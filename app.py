"""
Sivarr AI Web App — FastAPI Backend
Serves the dashboard and handles all AI interactions via REST API.
"""

import ast
import datetime
import json
import os
import random
import re
import shutil
import socket
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False

# ═══════════════════════════════════════════════════════════════
#  CONFIGURATION
# ═══════════════════════════════════════════════════════════════

VERSION         = "3.1"
CACHE_EXPIRY    = 30
HISTORY_LIMIT   = 40
BANK_LIMIT      = 20
DATA_DIR        = Path("data")
DATA_DIR.mkdir(exist_ok=True)

GEMINI_MODELS = [
    "gemini-1.5-flash", "gemini-1.5-pro",
    "gemini-pro", "gemini-1.0-pro",
]

MATH_TRIGGERS = [
    "solve", "calculate", "differentiate", "integrate", "expand",
    "factorise", "factorize", "simplify", "equation", "algebra",
    "quadratic", "derivative", "integral", "calculus", "gradient",
    "inequality", "simultaneous", "matrix", "fraction", "percentage",
    "ratio", "proof", "theorem", "logarithm", "log", "sin", "cos",
    "tan", "trigonometry", "polynomial", "find x", "find the value",
    "work out", "volume", "perimeter", "probability", "statistics",
    "mean", "median", "mode",
]

UNCERTAINTY_PHRASES = [
    "i'm not sure", "i am not sure", "i'm not certain", "i cannot verify",
    "i don't know", "i do not know", "may not be accurate", "cannot confirm",
    "you should verify", "double check", "consult a", "limited information",
]

TOPIC_STRIP = ["what is", "define", "explain", "solve", "calculate"]

SYSTEM_PROMPT = f"""You are the Sivarr AI — a casual, fun, and brilliant learning companion
built into the Sivarr platform for university students.

About Sivarr:
• Founded by Oladunni Testimony, a Lead City University student.
• Mission: student → skilled professional → employed talent → career growth.
• Currently serving Lead City University, expanding to more soon.
• Version: {VERSION}

Rules:
1. Be casual and encouraging — like a smart friend, not a textbook.
2. Keep answers SHORT — 2 to 4 sentences by default.
3. Show step-by-step explanations ONLY when explicitly asked.
4. Answer ANY question on any subject.
5. For math: state the final answer only unless asked for working.
6. Expand only when user asks for "more" or "explain further".
7. If unsure, say so clearly — never confidently guess wrong.
8. Format responses cleanly — use line breaks for readability when needed.
"""

MATH_PROMPT = """You are Sivarr's math expert.
1. State the final answer clearly and concisely.
2. Do NOT show steps unless asked.
3. One line is enough for simple problems e.g. "x = 5".
4. Be casual — a quick "easy!" is fine.
5. If unsure, say so.
"""

QUIZ_PROMPT = """Generate a {difficulty} multiple choice question about: {topic}

Difficulty: easy=basic recall, medium=application, hard=analysis

Reply ONLY with valid JSON:
{{
  "question": "...",
  "options": {{"A": "...", "B": "...", "C": "...", "D": "..."}},
  "answer": "A",
  "explanation": "One sentence."
}}"""

SUGGESTION_PROMPT = """You are Sivarr's study advisor.
Student: {name}
Studied: {topics}
Weakest: {weak}
Quiz performance: {quiz_summary}
Difficulty: {difficulty}

Recommend exactly 3 specific topics to study next.
Format: numbered list, one topic per line, one sentence reason.
Be encouraging and concise."""

# ═══════════════════════════════════════════════════════════════
#  LOAD ENV
# ═══════════════════════════════════════════════════════════════

def load_env():
    env = Path(".env")
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())

load_env()
API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()

# ═══════════════════════════════════════════════════════════════
#  GEMINI
# ═══════════════════════════════════════════════════════════════

_model_name = None
_chat_sessions = {}   # sid -> {"chat": session, "math": session}

def get_model() -> str:
    global _model_name
    if _model_name:
        return _model_name
    if not API_KEY or not GEMINI_AVAILABLE:
        return GEMINI_MODELS[0]
    genai.configure(api_key=API_KEY)
    try:
        available = [
            m.name.replace("models/", "") for m in genai.list_models()
            if "generateContent" in m.supported_generation_methods
        ]
        for m in GEMINI_MODELS:
            if m in available:
                _model_name = m
                return m
        _model_name = available[0] if available else GEMINI_MODELS[0]
    except Exception:
        _model_name = GEMINI_MODELS[0]
    return _model_name


def get_sessions(sid: str, memory: str = ""):
    if sid not in _chat_sessions:
        model = get_model()
        system = SYSTEM_PROMPT + (f"\n\n{memory}" if memory else "")
        def mk(sys):
            m = genai.GenerativeModel(
                model_name=model,
                system_instruction=sys,
                generation_config=genai.GenerationConfig(
                    temperature=0.7, max_output_tokens=400
                ),
            )
            return m.start_chat(history=[])
        _chat_sessions[sid] = {
            "chat": mk(system),
            "math": mk(MATH_PROMPT),
        }
    return _chat_sessions[sid]


def gemini_ask(session, question: str) -> str:
    try:
        return session.send_message(question).text.strip()
    except Exception as e:
        return f"[error: {e}]"


def gemini_once(prompt: str, temp=0.8, tokens=400) -> object:
    try:
        model = genai.GenerativeModel(
            model_name=get_model(),
            generation_config=genai.GenerationConfig(
                temperature=temp, max_output_tokens=tokens
            ),
        )
        return model.generate_content(prompt).text.strip()
    except Exception:
        return None

# ═══════════════════════════════════════════════════════════════
#  MATH
# ═══════════════════════════════════════════════════════════════

_SAFE = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd,
)

def solve_local(text: str) -> object:
    if not re.fullmatch(r"[\d+\-*/().^ \s]+", text.strip()):
        return None
    for c in [text] + re.findall(r"[\d+\-*/().^ ]+", text):
        try:
            tree = ast.parse(c.strip(), mode="eval")
            if any(not isinstance(n, _SAFE) for n in ast.walk(tree)):
                continue
            r = eval(compile(tree, "<string>", "eval"), {"__builtins__": {}}, {})
            return f"Result = {int(r) if isinstance(r, float) and r.is_integer() else r}"
        except Exception:
            continue
    return None


def is_math(text: str) -> bool:
    return any(t in text.lower() for t in MATH_TRIGGERS)


def is_uncertain(text: str) -> bool:
    return any(p in text.lower() for p in UNCERTAINTY_PHRASES)

# ═══════════════════════════════════════════════════════════════
#  DATA HELPERS
# ═══════════════════════════════════════════════════════════════

def ppath(sid): return DATA_DIR / f"{sid}_progress.json"
def lpath():    return DATA_DIR / "library.json"
def bpath():    return DATA_DIR / "bank.json"


def load_json(p: Path) -> dict:
    return json.loads(p.read_text()) if p.exists() else {}


def save_json(p: Path, data: dict):
    tmp = str(p) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    shutil.move(tmp, str(p))


def load_progress(sid: str) -> dict:
    p = ppath(sid)
    if p.exists():
        return json.loads(p.read_text())
    return {
        "sessions": 0, "questions": 0, "topics": {},
        "quizzes": [], "wrong_answers": [], "chat_history": [],
        "difficulty": "medium", "name": "", "matric": "",
    }


def save_progress(sid: str, data: dict):
    p = ppath(sid)
    if p.exists():
        shutil.copy2(str(p), str(p).replace(".json", ".backup.json"))
    save_json(p, data)


def get_cached(lib: dict, topic: str) -> object:
    e = lib.get(topic)
    if not e:
        return None
    if isinstance(e, str):
        return e
    age = (datetime.date.today() - datetime.date.fromisoformat(e.get("date","2000-01-01"))).days
    return e["answer"] if age <= CACHE_EXPIRY else None


def set_cached(lib: dict, topic: str, ans: str):
    lib[topic] = {"answer": ans, "date": datetime.date.today().isoformat()}


def strip_topic(q: str) -> str:
    for w in TOPIC_STRIP:
        q = q.lower().replace(w, "")
    return q.strip()


def build_memory(p: dict) -> str:
    history = p.get("chat_history", [])
    topics  = list(p.get("topics", {}).keys())
    if not history and not topics:
        return ""
    lines = ["Previous session context:"]
    for h in history[-10:]:
        lines.append(f"  {'Student' if h['role']=='user' else 'Sivarr'}: {h['message']}")
    if topics:
        lines.append(f"Topics studied: {', '.join(topics[-5:])}")
    return "\n".join(lines)


def add_history(p: dict, sid: str, role: str, msg: str):
    p.setdefault("chat_history", []).append({
        "role": role, "message": msg,
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    })
    p["chat_history"] = p["chat_history"][-HISTORY_LIMIT:]
    save_progress(sid, p)


def weak_topics(p: dict) -> list:
    return sorted(p["topics"], key=lambda t: p["topics"][t])[:3]

# ═══════════════════════════════════════════════════════════════
#  FASTAPI APP
# ═══════════════════════════════════════════════════════════════

app = FastAPI(title="Sivarr AI", version=VERSION)

# ── Request models ────────────────────────────────────────────

class LoginRequest(BaseModel):
    name: str
    matric: str

class ChatRequest(BaseModel):
    sid: str
    message: str

class QuizRequest(BaseModel):
    sid: str
    topic: str
    difficulty: str
    answer: str
    question: str
    correct: str
    explanation: str

class DifficultyRequest(BaseModel):
    sid: str
    level: str

# ── Routes ────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index():
    return (Path("templates/index.html")).read_text()


@app.post("/api/login")
async def login(req: LoginRequest):
    if not req.name.strip() or not req.matric.strip():
        raise HTTPException(400, "Name and matric are required")

    sid = f"{req.name.lower().strip()}_{req.matric.lower().strip()}"
    p   = load_progress(sid)
    p["sessions"] += 1
    p["name"]   = req.name.title()
    p["matric"] = req.matric.upper()
    save_progress(sid, p)

    # Init Gemini sessions with memory
    memory = build_memory(p)
    get_sessions(sid, memory)

    return {
        "sid": sid,
        "name": p["name"],
        "matric": p["matric"],
        "sessions": p["sessions"],
        "difficulty": p.get("difficulty", "medium"),
        "topics": list(p["topics"].keys()),
        "weak": weak_topics(p),
        "questions": p["questions"],
        "quizzes": len(p.get("quizzes", [])),
        "wrong_count": len(p.get("wrong_answers", [])),
        "returning": p["sessions"] > 1,
    }


@app.post("/api/chat")
async def chat(req: ChatRequest):
    p   = load_progress(req.sid)
    msg = req.message.strip()
    cmd = msg.lower()

    # Local math
    local = solve_local(msg)
    if local:
        add_history(p, req.sid, "user", msg)
        add_history(p, req.sid, "sivarr", local)
        p["questions"] += 1
        p["topics"]["math"] = p["topics"].get("math", 0) + 1
        save_progress(req.sid, p)
        return {"reply": local, "uncertain": False}

    sessions = get_sessions(req.sid)

    # Math via Gemini
    if is_math(cmd):
        ans = gemini_ask(sessions["math"], msg)
        uncertain = is_uncertain(ans)
        p["questions"] += 1
        p["topics"]["math"] = p["topics"].get("math", 0) + 1
        add_history(p, req.sid, "user", msg)
        add_history(p, req.sid, "sivarr", ans)
        save_progress(req.sid, p)
        return {"reply": ans, "uncertain": uncertain}

    # Cache check
    lib   = load_json(lpath())
    topic = strip_topic(cmd)
    cached = get_cached(lib, topic)
    if cached:
        p["questions"] += 1
        p["topics"][topic] = p["topics"].get(topic, 0) + 1
        save_progress(req.sid, p)
        return {"reply": cached, "uncertain": False}

    # General chat
    ans = gemini_ask(sessions["chat"], msg)
    uncertain = is_uncertain(ans)

    if topic and any(kw in cmd for kw in ["what is", "define", "explain"]) and not uncertain:
        set_cached(lib, topic, ans)
        save_json(lpath(), lib)

    p["questions"] += 1
    p["topics"][topic or "general"] = p["topics"].get(topic or "general", 0) + 1
    add_history(p, req.sid, "user", msg)
    add_history(p, req.sid, "sivarr", ans)
    save_progress(req.sid, p)

    return {"reply": ans, "uncertain": uncertain}


@app.get("/api/quiz/question")
async def quiz_question(sid: str, topic: str = "", difficulty: str = "medium"):
    p = load_progress(sid)
    topics = list(p["topics"].keys())
    if not topics:
        return {"error": "Study some topics first before taking a quiz!"}

    t    = topic if topic in topics else random.choice(topics)
    bank = load_json(bpath())
    key  = f"{t}_{difficulty}"

    # Try bank first
    stored = bank.get(key, [])
    if stored:
        q = random.choice(stored)
        q["topic"] = t
        return q

    # Generate fresh
    raw = gemini_once(QUIZ_PROMPT.format(topic=t, difficulty=difficulty), temp=0.9, tokens=300)
    if not raw:
        return {"error": "Could not generate question. Try again."}
    try:
        raw = re.sub(r"```(?:json)?", "", raw).strip().rstrip("`")
        q   = json.loads(raw)
        q["topic"] = t
        bank.setdefault(key, [])
        if q["question"] not in [x["question"] for x in bank[key]]:
            bank[key] = (bank[key] + [q])[-BANK_LIMIT:]
        save_json(bpath(), bank)
        return q
    except Exception:
        return {"error": "Question parse failed. Try again."}


@app.post("/api/quiz/submit")
async def quiz_submit(req: QuizRequest):
    p       = load_progress(req.sid)
    correct = req.answer.upper() == req.correct.upper()

    if not correct:
        p.setdefault("wrong_answers", []).append({
            "topic": req.topic, "question": req.question,
            "your_answer": req.answer, "correct": req.correct,
            "explanation": req.explanation, "difficulty": req.difficulty,
            "date": datetime.date.today().isoformat(),
        })

    save_progress(req.sid, p)
    return {"correct": correct, "correct_answer": req.correct}


@app.post("/api/quiz/complete")
async def quiz_complete(data: dict):
    sid   = data["sid"]
    score = data["score"]
    topic = data["topic"]
    diff  = data["difficulty"]
    p     = load_progress(sid)
    p.setdefault("quizzes", []).append({
        "topic": topic, "score": score / 5,
        "pct": int(score / 5 * 100), "difficulty": diff,
    })
    save_progress(sid, p)
    return {"ok": True}


@app.get("/api/progress")
async def progress(sid: str):
    p       = load_progress(sid)
    quizzes = p.get("quizzes", [])
    avg     = (sum(q["score"] for q in quizzes) / len(quizzes) * 100) if quizzes else 0
    return {
        "name": p.get("name", ""),
        "matric": p.get("matric", ""),
        "sessions": p["sessions"],
        "questions": p["questions"],
        "topics": p["topics"],
        "weak": weak_topics(p),
        "difficulty": p.get("difficulty", "medium"),
        "quizzes_taken": len(quizzes),
        "avg_score": round(avg, 1),
        "last_quiz": quizzes[-1] if quizzes else None,
        "wrong_count": len(p.get("wrong_answers", [])),
    }


@app.get("/api/suggest")
async def suggest(sid: str):
    p      = load_progress(sid)
    topics = list(p["topics"].keys())
    if not topics:
        return {"suggestion": "Study some topics first and I'll tailor suggestions for you! 📚"}

    quizzes = p.get("quizzes", [])
    qs = (f"avg {sum(q['score'] for q in quizzes)/len(quizzes)*100:.0f}% across {len(quizzes)} quizzes"
          if quizzes else "no quizzes yet")

    result = gemini_once(
        SUGGESTION_PROMPT.format(
            name=p.get("name","Student"), topics=", ".join(topics),
            weak=", ".join(weak_topics(p)) or "none",
            quiz_summary=qs, difficulty=p.get("difficulty","medium"),
        ),
        temp=0.6, tokens=250,
    )
    return {"suggestion": result or "Couldn't generate suggestions right now — try again later."}


@app.post("/api/difficulty")
async def set_difficulty(req: DifficultyRequest):
    if req.level not in ["easy", "medium", "hard"]:
        raise HTTPException(400, "Invalid level")
    p = load_progress(req.sid)
    p["difficulty"] = req.level
    save_progress(req.sid, p)
    return {"ok": True, "level": req.level}


@app.get("/api/wrong")
async def get_wrong(sid: str):
    p = load_progress(sid)
    return {"wrong": p.get("wrong_answers", [])}


@app.post("/api/wrong/clear")
async def clear_wrong(data: dict):
    sid = data["sid"]
    idx = data["index"]
    p   = load_progress(sid)
    wrong = p.get("wrong_answers", [])
    if 0 <= idx < len(wrong):
        wrong.pop(idx)
    p["wrong_answers"] = wrong
    save_progress(sid, p)
    return {"ok": True, "remaining": len(wrong)}
