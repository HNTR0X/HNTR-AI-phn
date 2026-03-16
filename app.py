"""
Sivarr AI Web App — FastAPI Backend v4.2
Added: Rate limiting, Input validation, Error logging
"""

import ast
import collections
import datetime
import json
import logging
import os
import random
import re
import shutil
import time
import traceback
import uuid
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, validator

try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False

# ═══════════════════════════════════════════════════════════════
#  LOGGING SETUP
# ═══════════════════════════════════════════════════════════════

LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "sivarr.log"),
        logging.StreamHandler(),
    ]
)
log = logging.getLogger("sivarr")

# ═══════════════════════════════════════════════════════════════
#  CONFIGURATION
# ═══════════════════════════════════════════════════════════════

VERSION       = "4.2"
CACHE_EXPIRY  = 30
HISTORY_LIMIT = 40
BANK_LIMIT    = 20
DATA_DIR      = Path("data")
UPLOADS_DIR   = Path("uploads")
SHARES_DIR    = Path("shares")

for d in [DATA_DIR, UPLOADS_DIR, SHARES_DIR, LOG_DIR]:
    d.mkdir(exist_ok=True)

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "sivarr_admin_2024")

# ── Rate limiting config ──────────────────────────────────────
RATE_LIMIT_CHAT     = int(os.environ.get("RATE_LIMIT_CHAT", 30))      # max chat msgs per window
RATE_LIMIT_QUIZ     = int(os.environ.get("RATE_LIMIT_QUIZ", 20))      # max quiz questions per window
RATE_LIMIT_UPLOAD   = int(os.environ.get("RATE_LIMIT_UPLOAD", 5))     # max uploads per window
RATE_LIMIT_WINDOW   = int(os.environ.get("RATE_LIMIT_WINDOW", 60))    # window in seconds
RATE_LIMIT_LOGIN    = int(os.environ.get("RATE_LIMIT_LOGIN", 10))     # max login attempts per window

# ── Input validation config ───────────────────────────────────
MAX_MESSAGE_LEN  = 2000    # max characters in a chat message
MAX_NAME_LEN     = 80      # max student name length
MAX_MATRIC_LEN   = 30      # max matric number length
MAX_FILE_SIZE    = 5 * 1024 * 1024  # 5MB max file size

GEMINI_MODELS = [
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-1.5-pro",
    "gemini-pro",
    "gemini-1.0-pro",
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
- Founded by a Lead City University student.
- Mission: student to skilled professional to employed talent to career growth.
- Version: {VERSION}

Rules:
1. Be casual and encouraging — like a smart friend, not a textbook.
2. Keep answers SHORT — 2 to 4 sentences by default.
3. Show step-by-step explanations ONLY when explicitly asked.
4. Answer ANY question on any subject.
5. For math: state the final answer only unless asked for working.
6. Expand only when user asks for more or explain further.
7. If unsure, say so clearly — never confidently guess wrong.
8. Format responses cleanly — use line breaks for readability when needed.
"""

MATH_PROMPT = """You are Sivarr's math expert.
1. State the final answer clearly and concisely.
2. Do NOT show steps unless asked.
3. One line is enough for simple problems e.g. x = 5.
4. Be casual.
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

SUGGESTION_PROMPT = """You are Sivarr study advisor.
Student: {name} | Studied: {topics} | Weakest: {weak} | Quiz: {quiz_summary} | Difficulty: {difficulty}
Recommend exactly 3 specific topics. Numbered list, one sentence each. Be encouraging."""

FILE_SUMMARY_PROMPT = """A student uploaded a document. Here is the extracted text:

{text}

Please:
1. Give a brief summary (3-5 sentences)
2. List 5 key topics or concepts from the document
3. Suggest 3 quiz questions based on the content

Format clearly with headers."""

FILE_QUIZ_PROMPT = """Based on this document content:
{text}

Generate a {difficulty} multiple choice question.
Reply ONLY with valid JSON:
{{
  "question": "...",
  "options": {{"A": "...", "B": "...", "C": "...", "D": "..."}},
  "answer": "A",
  "explanation": "One sentence."
}}"""

# ═══════════════════════════════════════════════════════════════
#  RATE LIMITER
# ═══════════════════════════════════════════════════════════════

class RateLimiter:
    """
    Simple in-memory rate limiter using a sliding window.
    Tracks request counts per key (IP or student ID) per endpoint.
    """
    def __init__(self):
        self._counts = collections.defaultdict(list)

    def is_allowed(self, key: str, limit: int, window: int = RATE_LIMIT_WINDOW) -> bool:
        """Return True if request is allowed, False if rate limit exceeded."""
        now   = time.time()
        calls = self._counts[key]

        # Remove calls outside the window
        self._counts[key] = [t for t in calls if now - t < window]

        if len(self._counts[key]) >= limit:
            return False

        self._counts[key].append(now)
        return True

    def remaining(self, key: str, limit: int, window: int = RATE_LIMIT_WINDOW) -> int:
        """Return how many requests are remaining in current window."""
        now = time.time()
        self._counts[key] = [t for t in self._counts[key] if now - t < window]
        return max(0, limit - len(self._counts[key]))


limiter = RateLimiter()


def get_client_key(request: Request, sid: str = "") -> str:
    """Get a unique key for rate limiting — prefer student ID, fall back to IP."""
    if sid:
        return f"student_{sid}"
    forwarded = request.headers.get("x-forwarded-for")
    ip = forwarded.split(",")[0].strip() if forwarded else request.client.host
    return f"ip_{ip}"


def check_rate_limit(key: str, limit: int, endpoint: str) -> None:
    """Raise 429 if rate limit exceeded, and log the event."""
    full_key = f"{endpoint}_{key}"
    if not limiter.is_allowed(full_key, limit):
        log.warning(f"Rate limit exceeded | key={key} | endpoint={endpoint}")
        raise HTTPException(
            status_code=429,
            detail=f"Too many requests. Please wait {RATE_LIMIT_WINDOW} seconds before trying again."
        )

# ═══════════════════════════════════════════════════════════════
#  INPUT VALIDATION
# ═══════════════════════════════════════════════════════════════

def sanitize_text(text: str, max_len: int = MAX_MESSAGE_LEN) -> str:
    """
    Clean and validate text input.
    - Strips whitespace
    - Removes null bytes and control characters
    - Enforces max length
    """
    if not text:
        return ""
    # Remove null bytes and non-printable control chars (keep newlines/tabs)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    text = text.strip()
    if len(text) > max_len:
        text = text[:max_len]
        log.info(f"Input truncated to {max_len} chars")
    return text


def validate_name(name: str) -> str:
    """Validate and clean student name."""
    name = sanitize_text(name, MAX_NAME_LEN)
    if not name:
        raise HTTPException(400, "Name cannot be empty.")
    if len(name) < 2:
        raise HTTPException(400, "Name must be at least 2 characters.")
    # Allow letters, spaces, hyphens, apostrophes
    if not re.match(r"^[a-zA-Z\s\-'.]+$", name):
        raise HTTPException(400, "Name contains invalid characters.")
    return name


def validate_matric(matric: str) -> str:
    """Validate matric number format."""
    matric = sanitize_text(matric, MAX_MATRIC_LEN)
    if not matric:
        raise HTTPException(400, "Matric number cannot be empty.")
    if len(matric) < 3:
        raise HTTPException(400, "Matric number too short.")
    # Allow alphanumeric, slashes, hyphens
    if not re.match(r"^[a-zA-Z0-9\-/]+$", matric):
        raise HTTPException(400, "Matric number contains invalid characters.")
    return matric


def validate_message(msg: str) -> str:
    """Validate chat message."""
    msg = sanitize_text(msg, MAX_MESSAGE_LEN)
    if not msg:
        raise HTTPException(400, "Message cannot be empty.")
    return msg

# ═══════════════════════════════════════════════════════════════
#  ENV
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
_chat_sessions = {}

def get_model():
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
                log.info(f"Gemini model selected: {m}")
                return m
        _model_name = available[0] if available else GEMINI_MODELS[0]
    except Exception as e:
        log.error(f"Gemini model selection failed: {e}")
        _model_name = GEMINI_MODELS[0]
    return _model_name


def get_sessions(sid, memory=""):
    if sid not in _chat_sessions:
        model  = get_model()
        system = SYSTEM_PROMPT + (f"\n\n{memory}" if memory else "")
        def mk(sys):
            m = genai.GenerativeModel(
                model_name=model,
                system_instruction=sys,
                generation_config=genai.GenerationConfig(temperature=0.7, max_output_tokens=400),
            )
            return m.start_chat(history=[])
        _chat_sessions[sid] = {"chat": mk(system), "math": mk(MATH_PROMPT)}
        log.info(f"New chat session created for: {sid}")
    return _chat_sessions[sid]


def friendly_gemini_error(e):
    """Convert raw Gemini exceptions into short readable messages."""
    msg = str(e).lower()
    if "quota" in msg or "429" in msg or "resource_exhausted" in msg:
        return "Sivarr is taking a short break — free tier quota reached. Please wait a minute and try again! ⏳"
    if "api key" in msg or "invalid" in msg or "401" in msg or "403" in msg:
        return "API key issue — please contact support."
    if "network" in msg or "connection" in msg or "timeout" in msg or "unavailable" in msg:
        return "Connection issue — check your internet and try again."
    if "404" in msg or "not found" in msg:
        return "AI model unavailable — try again in a moment."
    return "Something went wrong — please try again shortly."


def gemini_ask(session, question):
    try:
        return session.send_message(question).text.strip()
    except Exception as e:
        log.error(f"Gemini ask error: {e}")
        return friendly_gemini_error(e)


def gemini_once(prompt, temp=0.8, tokens=600):
    try:
        model = genai.GenerativeModel(
            model_name=get_model(),
            generation_config=genai.GenerationConfig(temperature=temp, max_output_tokens=tokens),
        )
        return model.generate_content(prompt).text.strip()
    except Exception as e:
        log.error(f"Gemini once error: {e}")
        return None

# ═══════════════════════════════════════════════════════════════
#  MATH
# ═══════════════════════════════════════════════════════════════

_SAFE = (
    ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd,
)

def solve_local(text):
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


def is_math(text):
    return any(t in text.lower() for t in MATH_TRIGGERS)


def is_uncertain(text):
    return any(p in text.lower() for p in UNCERTAINTY_PHRASES)

# ═══════════════════════════════════════════════════════════════
#  DATA HELPERS
# ═══════════════════════════════════════════════════════════════

def ppath(sid):  return DATA_DIR / f"{sid}_progress.json"
def lpath():     return DATA_DIR / "library.json"
def bpath():     return DATA_DIR / "bank.json"


def load_json(p):
    return json.loads(p.read_text()) if p.exists() else {}


def save_json(p, data):
    tmp = str(p) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    shutil.move(tmp, str(p))


def load_progress(sid):
    p = ppath(sid)
    if p.exists():
        return json.loads(p.read_text())
    return {
        "sessions": 0, "questions": 0, "topics": {},
        "quizzes": [], "wrong_answers": [], "chat_history": [],
        "difficulty": "medium", "name": "", "matric": "",
        "uploaded_files": [],
    }


def save_progress(sid, p):
    path = ppath(sid)
    if path.exists():
        shutil.copy2(str(path), str(path).replace(".json", ".backup.json"))
    save_json(path, p)


def get_cached(lib, topic):
    e = lib.get(topic)
    if not e:
        return None
    if isinstance(e, str):
        return e
    age = (datetime.date.today() - datetime.date.fromisoformat(e.get("date","2000-01-01"))).days
    return e["answer"] if age <= CACHE_EXPIRY else None


def set_cached(lib, topic, ans):
    lib[topic] = {"answer": ans, "date": datetime.date.today().isoformat()}


def strip_topic(q):
    for w in TOPIC_STRIP:
        q = q.lower().replace(w, "")
    return q.strip()


def build_memory(p):
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


def add_history(p, sid, role, msg):
    p.setdefault("chat_history", []).append({
        "role": role, "message": msg,
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    })
    p["chat_history"] = p["chat_history"][-HISTORY_LIMIT:]
    save_progress(sid, p)


def weak_topics(p):
    return sorted(p["topics"], key=lambda t: p["topics"][t])[:3]


def get_all_students():
    students = []
    for f in DATA_DIR.glob("*_progress.json"):
        if "backup" in f.name:
            continue
        try:
            data    = json.loads(f.read_text())
            quizzes = data.get("quizzes", [])
            avg     = (sum(q["score"] for q in quizzes) / len(quizzes) * 100) if quizzes else 0
            students.append({
                "name":        data.get("name", "Unknown"),
                "matric":      data.get("matric", "N/A"),
                "sessions":    data.get("sessions", 0),
                "questions":   data.get("questions", 0),
                "quizzes":     len(quizzes),
                "avg_score":   round(avg, 1),
                "topics":      list(data.get("topics", {}).keys()),
                "weak":        sorted(data.get("topics",{}), key=lambda t: data["topics"][t])[:3],
                "wrong_count": len(data.get("wrong_answers", [])),
                "difficulty":  data.get("difficulty", "medium"),
                "last_seen":   data.get("chat_history", [{}])[-1].get("time", "Never") if data.get("chat_history") else "Never",
            })
        except Exception as e:
            log.error(f"Error reading student file {f}: {e}")
            continue
    return sorted(students, key=lambda s: s["sessions"], reverse=True)

# ═══════════════════════════════════════════════════════════════
#  QUIZ JSON PARSER
# ═══════════════════════════════════════════════════════════════

def parse_quiz_json(raw: str, topic: str) -> dict:
    """
    Robustly parse a quiz question from Gemini output.
    Handles markdown fences, extra text, partial JSON, and
    common formatting issues Gemini produces.
    """
    if not raw:
        return None
    try:
        # Step 1 — strip markdown code fences
        raw = re.sub(r"```(?:json)?", "", raw).strip().rstrip("`").strip()

        # Step 2 — extract just the JSON object if there's extra text around it
        match = re.search(r'\{[\s\S]*\}', raw)
        if match:
            raw = match.group(0)

        # Step 3 — parse
        q = json.loads(raw)

        # Step 4 — validate required fields
        required = ["question", "options", "answer", "explanation"]
        if not all(k in q for k in required):
            log.warning(f"Quiz JSON missing fields: {list(q.keys())}")
            return None

        # Step 5 — validate options has A B C D
        opts = q.get("options", {})
        if not all(k in opts for k in ["A", "B", "C", "D"]):
            log.warning(f"Quiz options incomplete: {list(opts.keys())}")
            return None

        # Step 6 — normalize answer to uppercase single letter
        q["answer"] = str(q["answer"]).strip().upper()[:1]
        if q["answer"] not in ["A", "B", "C", "D"]:
            q["answer"] = "A"

        q["topic"] = topic
        return q

    except json.JSONDecodeError as e:
        log.error(f"Quiz JSON parse error: {e} | raw: {raw[:200]}")
        return None
    except Exception as e:
        log.error(f"Quiz parse unexpected error: {e}")
        return None


# ═══════════════════════════════════════════════════════════════
#  FASTAPI APP
# ═══════════════════════════════════════════════════════════════

app = FastAPI(title="Sivarr AI", version=VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Global error handler ──────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch all unhandled exceptions, log them, return clean error."""
    error_id = str(uuid.uuid4())[:8]
    log.error(f"Unhandled error [{error_id}] {request.url.path}: {exc}\n{traceback.format_exc()}")
    return JSONResponse(
        status_code=500,
        content={"detail": f"Something went wrong. Error ID: {error_id}"}
    )

# ── Request models with validation ────────────────────────────

class LoginRequest(BaseModel):
    name: str
    matric: str

    @validator("name")
    def name_valid(cls, v):
        v = sanitize_text(v, MAX_NAME_LEN)
        if not v or len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        if not re.match(r"^[a-zA-Z\s\-'.]+$", v):
            raise ValueError("Name contains invalid characters.")
        return v

    @validator("matric")
    def matric_valid(cls, v):
        v = sanitize_text(v, MAX_MATRIC_LEN)
        if not v or len(v) < 3:
            raise ValueError("Matric number is too short.")
        if not re.match(r"^[a-zA-Z0-9\-/]+$", v):
            raise ValueError("Matric number contains invalid characters.")
        return v


class ChatRequest(BaseModel):
    sid: str
    message: str

    @validator("message")
    def msg_valid(cls, v):
        v = sanitize_text(v, MAX_MESSAGE_LEN)
        if not v:
            raise ValueError("Message cannot be empty.")
        return v

    @validator("sid")
    def sid_valid(cls, v):
        v = sanitize_text(v, 100)
        if not v:
            raise ValueError("Session ID required.")
        return v


class QuizRequest(BaseModel):
    sid: str
    topic: str
    difficulty: str
    answer: str
    question: str
    correct: str
    explanation: str

    @validator("difficulty")
    def diff_valid(cls, v):
        if v not in ["easy", "medium", "hard"]:
            raise ValueError("Invalid difficulty.")
        return v

    @validator("answer", "correct")
    def answer_valid(cls, v):
        v = v.strip().upper()
        if v not in ["A", "B", "C", "D"]:
            raise ValueError("Answer must be A, B, C, or D.")
        return v


class DifficultyRequest(BaseModel):
    sid: str
    level: str

    @validator("level")
    def level_valid(cls, v):
        if v not in ["easy", "medium", "hard"]:
            raise ValueError("Level must be easy, medium, or hard.")
        return v


class AdminLoginRequest(BaseModel):
    password: str

# ── Routes ────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index():
    return Path("templates/index.html").read_text()

@app.get("/admin", response_class=HTMLResponse)
async def admin_page():
    return Path("templates/admin.html").read_text()


@app.post("/api/login")
async def login(req: LoginRequest, request: Request):
    key = get_client_key(request)
    check_rate_limit(key, RATE_LIMIT_LOGIN, "login")

    sid = f"{req.name.lower().strip()}_{req.matric.lower().strip()}"
    sid = re.sub(r"[^a-z0-9_]", "_", sid)  # Sanitize sid

    p = load_progress(sid)
    p["sessions"] += 1
    p["name"]   = req.name.title()
    p["matric"] = req.matric.upper()
    save_progress(sid, p)

    memory = build_memory(p)
    get_sessions(sid, memory)

    log.info(f"Login: {p['name']} ({p['matric']}) | Sessions: {p['sessions']}")

    return {
        "sid": sid, "name": p["name"], "matric": p["matric"],
        "sessions": p["sessions"], "difficulty": p.get("difficulty","medium"),
        "topics": list(p["topics"].keys()), "weak": weak_topics(p),
        "questions": p["questions"], "quizzes": len(p.get("quizzes",[])),
        "wrong_count": len(p.get("wrong_answers",[])), "returning": p["sessions"] > 1,
        "uploaded_files": p.get("uploaded_files", []),
    }


@app.post("/api/chat")
async def chat(req: ChatRequest, request: Request):
    key = get_client_key(request, req.sid)
    check_rate_limit(key, RATE_LIMIT_CHAT, "chat")

    p   = load_progress(req.sid)
    msg = req.message
    cmd = msg.lower()

    log.info(f"Chat: {req.sid[:20]} | {msg[:60]}")

    local = solve_local(msg)
    if local:
        add_history(p, req.sid, "user", msg)
        add_history(p, req.sid, "sivarr", local)
        p["questions"] += 1
        p["topics"]["math"] = p["topics"].get("math", 0) + 1
        save_progress(req.sid, p)
        return {"reply": local, "uncertain": False}

    sessions = get_sessions(req.sid)

    if is_math(cmd):
        ans = gemini_ask(sessions["math"], msg)
        uncertain = is_uncertain(ans)
        p["questions"] += 1
        p["topics"]["math"] = p["topics"].get("math", 0) + 1
        add_history(p, req.sid, "user", msg)
        add_history(p, req.sid, "sivarr", ans)
        save_progress(req.sid, p)
        return {"reply": ans, "uncertain": uncertain}

    lib    = load_json(lpath())
    topic  = strip_topic(cmd)
    cached = get_cached(lib, topic)
    if cached:
        p["questions"] += 1
        p["topics"][topic] = p["topics"].get(topic, 0) + 1
        save_progress(req.sid, p)
        return {"reply": cached, "uncertain": False}

    ans       = gemini_ask(sessions["chat"], msg)
    uncertain = is_uncertain(ans)

    if topic and any(kw in cmd for kw in ["what is","define","explain"]) and not uncertain:
        set_cached(lib, topic, ans)
        save_json(lpath(), lib)

    p["questions"] += 1
    p["topics"][topic or "general"] = p["topics"].get(topic or "general", 0) + 1
    add_history(p, req.sid, "user", msg)
    add_history(p, req.sid, "sivarr", ans)
    save_progress(req.sid, p)
    return {"reply": ans, "uncertain": uncertain}


@app.get("/api/quiz/question")
async def quiz_question(request: Request, sid: str, topic: str = "", difficulty: str = "medium", file_id: str = ""):
    sid = sanitize_text(sid, 100)
    key = get_client_key(request, sid)
    check_rate_limit(key, RATE_LIMIT_QUIZ, "quiz")

    if difficulty not in ["easy","medium","hard"]:
        difficulty = "medium"

    p = load_progress(sid)

    if file_id:
        file_id = sanitize_text(file_id, 20)
        fpath = UPLOADS_DIR / f"{sid}_{file_id}.txt"
        if fpath.exists():
            content = fpath.read_text()[:3000]
            raw = gemini_once(FILE_QUIZ_PROMPT.format(text=content, difficulty=difficulty), temp=0.9, tokens=300)
            if raw:
                try:
                    raw = re.sub(r"```(?:json)?","",raw).strip().rstrip("`")
                    q   = json.loads(raw)
                    q["topic"] = "uploaded document"
                    return q
                except Exception as e:
                    log.error(f"File quiz parse error: {e}")
        return {"error": "Could not generate question from file."}

    topics = list(p["topics"].keys())

    # Allow quiz even with no studied topics if a topic was provided
    if not topics and not topic:
        topic = "general knowledge"

    t = topic if topic else (random.choice(topics) if topics else "general knowledge")
    bank = load_json(bpath())
    key2 = f"{t}_{difficulty}"

    stored = bank.get(key2, [])
    if stored:
        q = random.choice(stored)
        q["topic"] = t
        return q

    raw = gemini_once(QUIZ_PROMPT.format(topic=t, difficulty=difficulty), temp=0.9, tokens=300)
    if not raw:
        log.warning(f"Gemini unavailable for quiz — using fallback question bank")
        return get_fallback_question(t, [])

    q = parse_quiz_json(raw, t)
    if not q:
        # Retry once with lower temperature
        raw2 = gemini_once(QUIZ_PROMPT.format(topic=t, difficulty=difficulty), temp=0.5, tokens=300)
        q = parse_quiz_json(raw2 or "", t)
    if not q:
        log.warning(f"Quiz parse failed twice — using fallback question bank")
        return get_fallback_question(t, [])

    bank.setdefault(key2, [])
    if q["question"] not in [x["question"] for x in bank[key2]]:
        bank[key2] = (bank[key2] + [q])[-BANK_LIMIT:]
    save_json(bpath(), bank)
    return q


@app.post("/api/quiz/submit")
async def quiz_submit(req: QuizRequest):
    p       = load_progress(req.sid)
    correct = req.answer.upper() == req.correct.upper()
    if not correct:
        p.setdefault("wrong_answers", []).append({
            "topic": sanitize_text(req.topic, 100),
            "question": sanitize_text(req.question, 500),
            "your_answer": req.answer,
            "correct": req.correct,
            "explanation": sanitize_text(req.explanation, 500),
            "difficulty": req.difficulty,
            "date": datetime.date.today().isoformat(),
        })
    save_progress(req.sid, p)
    return {"correct": correct, "correct_answer": req.correct}


@app.post("/api/quiz/complete")
async def quiz_complete(data: dict):
    sid   = sanitize_text(str(data.get("sid","")), 100)
    score = min(max(int(data.get("score",0)), 0), 5)
    topic = sanitize_text(str(data.get("topic","general")), 100)
    diff  = data.get("difficulty","medium")
    if diff not in ["easy","medium","hard"]:
        diff = "medium"
    p = load_progress(sid)
    p.setdefault("quizzes", []).append({
        "topic": topic, "score": score / 5,
        "pct": int(score / 5 * 100), "difficulty": diff,
    })
    save_progress(sid, p)
    log.info(f"Quiz complete: {sid[:20]} | {score}/5 | {topic} | {diff}")
    return {"ok": True}


@app.get("/api/progress")
async def progress(sid: str):
    sid     = sanitize_text(sid, 100)
    p       = load_progress(sid)
    quizzes = p.get("quizzes", [])
    avg     = (sum(q["score"] for q in quizzes) / len(quizzes) * 100) if quizzes else 0
    return {
        "name": p.get("name",""), "matric": p.get("matric",""),
        "sessions": p["sessions"], "questions": p["questions"],
        "topics": p["topics"], "weak": weak_topics(p),
        "difficulty": p.get("difficulty","medium"),
        "quizzes_taken": len(quizzes), "avg_score": round(avg,1),
        "last_quiz": quizzes[-1] if quizzes else None,
        "wrong_count": len(p.get("wrong_answers",[])),
        "uploaded_files": p.get("uploaded_files",[]),
    }


@app.get("/api/suggest")
async def suggest(request: Request, sid: str):
    sid = sanitize_text(sid, 100)
    key = get_client_key(request, sid)
    check_rate_limit(key, 5, "suggest")

    p      = load_progress(sid)
    topics = list(p["topics"].keys())
    if not topics:
        return {"suggestion": "Study some topics first and I will tailor suggestions for you!"}
    quizzes = p.get("quizzes",[])
    qs = (f"avg {sum(q['score'] for q in quizzes)/len(quizzes)*100:.0f}% across {len(quizzes)} quizzes"
          if quizzes else "no quizzes yet")
    result = gemini_once(SUGGESTION_PROMPT.format(
        name=p.get("name","Student"), topics=", ".join(topics),
        weak=", ".join(weak_topics(p)) or "none",
        quiz_summary=qs, difficulty=p.get("difficulty","medium"),
    ), temp=0.6, tokens=250)
    return {"suggestion": result or "Could not generate suggestions right now."}


@app.post("/api/difficulty")
async def set_difficulty(req: DifficultyRequest):
    p = load_progress(req.sid)
    p["difficulty"] = req.level
    save_progress(req.sid, p)
    return {"ok": True, "level": req.level}


@app.get("/api/wrong")
async def get_wrong(sid: str):
    sid = sanitize_text(sid, 100)
    p   = load_progress(sid)
    return {"wrong": p.get("wrong_answers",[])}


@app.post("/api/wrong/clear")
async def clear_wrong(data: dict):
    sid   = sanitize_text(str(data.get("sid","")), 100)
    idx   = int(data.get("index", -1))
    p     = load_progress(sid)
    wrong = p.get("wrong_answers",[])
    if 0 <= idx < len(wrong):
        wrong.pop(idx)
    p["wrong_answers"] = wrong
    save_progress(sid, p)
    return {"ok": True, "remaining": len(wrong)}


# ── File Upload ───────────────────────────────────────────────

@app.post("/api/upload")
async def upload_file(request: Request, sid: str = Form(...), file: UploadFile = File(...)):
    sid = sanitize_text(sid, 100)
    key = get_client_key(request, sid)
    check_rate_limit(key, RATE_LIMIT_UPLOAD, "upload")

    allowed = [".txt", ".pdf", ".md"]
    ext     = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, "Use .txt, .pdf, or .md files only.")

    content = await file.read()

    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(400, f"File too large. Maximum size is 5MB.")

    if ext == ".pdf":
        try:
            import io
            try:
                import pypdf
                reader = pypdf.PdfReader(io.BytesIO(content))
                text   = "\n".join(page.extract_text() or "" for page in reader.pages)
            except ImportError:
                text = content.decode("utf-8", errors="ignore")
        except Exception as e:
            log.error(f"PDF parse error: {e}")
            text = content.decode("utf-8", errors="ignore")
    else:
        text = content.decode("utf-8", errors="ignore")

    text = sanitize_text(text, 10000)
    if not text.strip():
        raise HTTPException(400, "Could not extract text from file.")

    file_id = str(uuid.uuid4())[:8]
    fpath   = UPLOADS_DIR / f"{sid}_{file_id}.txt"
    fpath.write_text(text)

    p = load_progress(sid)
    p.setdefault("uploaded_files", []).append({
        "id": file_id,
        "name": sanitize_text(file.filename, 200),
        "date": datetime.date.today().isoformat(),
    })
    save_progress(sid, p)

    log.info(f"File uploaded: {file.filename} by {sid[:20]}")
    summary = gemini_once(FILE_SUMMARY_PROMPT.format(text=text[:3000]), temp=0.5, tokens=600)
    return {
        "file_id": file_id,
        "filename": file.filename,
        "summary": summary or "File uploaded! You can now quiz yourself on it.",
    }


# ── Share Results ─────────────────────────────────────────────

@app.post("/api/share")
async def create_share(request: Request, data: dict):
    key = get_client_key(request)
    check_rate_limit(key, 10, "share")

    share_id   = str(uuid.uuid4())[:10]
    share_data = {
        "id":      share_id,
        "type":    sanitize_text(str(data.get("type","quiz")), 20),
        "name":    sanitize_text(str(data.get("name","Student")), MAX_NAME_LEN),
        "score":   min(max(int(data.get("score",0)), 0), 5),
        "topic":   sanitize_text(str(data.get("topic","General")), 100),
        "diff":    data.get("difficulty","medium") if data.get("difficulty") in ["easy","medium","hard"] else "medium",
        "created": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    (SHARES_DIR / f"{share_id}.json").write_text(json.dumps(share_data, indent=2))
    log.info(f"Share created: {share_id} by {share_data['name']}")
    return {"share_id": share_id, "url": f"/share/{share_id}"}


@app.get("/share/{share_id}", response_class=HTMLResponse)
async def view_share(share_id: str):
    share_id   = re.sub(r"[^a-zA-Z0-9\-]", "", share_id)[:20]
    share_path = SHARES_DIR / f"{share_id}.json"
    if not share_path.exists():
        return HTMLResponse("<h2>Share link not found.</h2>", status_code=404)
    d   = json.loads(share_path.read_text())
    pct = int((d.get("score",0) / 5) * 100)
    emoji = "🏆" if pct==100 else "🌟" if pct>=80 else "📝"
    return HTMLResponse(f"""<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sivarr AI — {d['name']}'s Results</title>
<meta property="og:title" content="{d['name']} scored {pct}% on Sivarr AI!">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;800&display=swap" rel="stylesheet">
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#08090d;color:#f0f1f5;font-family:'Outfit',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}}
.card{{background:#13151c;border:1px solid #1c1f2a;border-radius:20px;padding:2.5rem;max-width:380px;width:100%;text-align:center}}
.mono{{width:36px;height:36px;background:linear-gradient(135deg,#4f6ef7,#7c3aed);border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;margin-bottom:1.5rem}}
.score{{font-size:3.5rem;font-weight:800;background:linear-gradient(135deg,#4f6ef7,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}}
.meta{{color:#5a5f7a;margin:.5rem 0 1.5rem;font-size:.9rem}}
.pill{{display:inline-block;background:#4f6ef715;border:1px solid #4f6ef730;color:#4f6ef7;padding:4px 14px;border-radius:20px;font-size:.8rem;margin:3px}}
.cta{{margin-top:1.5rem;background:linear-gradient(135deg,#4f6ef7,#7c3aed);color:#fff;border:none;border-radius:10px;padding:11px 24px;font-family:'Outfit',sans-serif;font-weight:700;font-size:.95rem;cursor:pointer;text-decoration:none;display:inline-block}}
</style></head><body>
<div class="card">
<div class="mono">Sr</div>
<div style="font-size:2.5rem">{emoji}</div>
<div class="score">{d.get('score',0)}/5</div>
<div style="font-weight:700;font-size:1.1rem;margin:.3rem 0">{d['name']}</div>
<div class="meta">scored {pct}% on {d.get('topic','General').title()}</div>
<span class="pill">{d.get('diff','medium').title()}</span>
<span class="pill">{d.get('created','')}</span><br><br>
<a href="/" class="cta">Try Sivarr AI →</a>
</div></body></html>""")


# ── Admin ─────────────────────────────────────────────────────

@app.post("/api/admin/login")
async def admin_login(req: AdminLoginRequest, request: Request):
    key = get_client_key(request)
    check_rate_limit(key, 5, "admin_login")  # Extra strict for admin
    if req.password != ADMIN_PASSWORD:
        log.warning(f"Failed admin login attempt from {key}")
        raise HTTPException(401, "Invalid password")
    log.info(f"Admin login successful from {key}")
    return {"ok": True, "token": "admin_" + ADMIN_PASSWORD[:6]}


@app.get("/api/admin/students")
async def admin_students(token: str):
    if not token.startswith("admin_"):
        raise HTTPException(401, "Unauthorized")
    students = get_all_students()
    total_q  = sum(s["questions"] for s in students)
    total_qz = sum(s["quizzes"] for s in students)
    avg_all  = (sum(s["avg_score"] for s in students) / len(students)) if students else 0
    return {
        "students": students, "total": len(students),
        "total_questions": total_q, "total_quizzes": total_qz,
        "avg_score": round(avg_all, 1),
    }




# ═══════════════════════════════════════════════════════════════
#  LECTURER SYSTEM
# ═══════════════════════════════════════════════════════════════

LECTURER_PASSWORD = os.environ.get("LECTURER_PASSWORD", "lecturer2024")
LECTURER_DIR      = Path("lecturer_data")
LECTURER_DIR.mkdir(exist_ok=True)

def ann_path():   return LECTURER_DIR / "announcements.json"
def topics_path():return LECTURER_DIR / "class_topics.json"
def exams_path(): return LECTURER_DIR / "exams.json"

def load_lecturer_json(p):
    return json.loads(p.read_text()) if p.exists() else []

def save_lecturer_json(p, data):
    tmp = str(p) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    shutil.move(tmp, str(p))

def valid_lecturer_token(token: str) -> bool:
    return token == "lect_" + LECTURER_PASSWORD[:8]


class LecturerLoginRequest(BaseModel):
    name: str
    password: str

class AnnounceRequest(BaseModel):
    token: str
    message: str
    author: str

class TopicsRequest(BaseModel):
    token: str
    topics: list

class ExamPublishRequest(BaseModel):
    token: str
    title: str
    questions: list
    questions_per_student: int


@app.get("/lecturer", response_class=HTMLResponse)
async def lecturer_page():
    return Path("templates/lecturer.html").read_text()


@app.post("/api/lecturer/login")
async def lecturer_login(req: LecturerLoginRequest, request: Request):
    key = get_client_key(request)
    check_rate_limit(key, 5, "lecturer_login")
    if req.password != LECTURER_PASSWORD:
        log.warning(f"Failed lecturer login: {req.name}")
        raise HTTPException(401, "Invalid password")
    log.info(f"Lecturer login: {req.name}")
    return {"ok": True, "token": "lect_" + LECTURER_PASSWORD[:8]}


@app.get("/api/lecturer/students")
async def lecturer_students(token: str):
    if not valid_lecturer_token(token):
        raise HTTPException(401, "Unauthorized")
    students = get_all_students()
    total_q  = sum(s["questions"] for s in students)
    total_qz = sum(s["quizzes"] for s in students)
    avg_all  = (sum(s["avg_score"] for s in students) / len(students)) if students else 0
    return {
        "students": students, "total": len(students),
        "total_questions": total_q, "total_quizzes": total_qz,
        "avg_score": round(avg_all, 1),
    }


@app.get("/api/lecturer/announcements")
async def get_announcements(token: str = ""):
    # Announcements are readable by students too (no token needed for GET)
    return {"announcements": load_lecturer_json(ann_path())}


@app.post("/api/lecturer/announce")
async def post_announcement(req: AnnounceRequest):
    if not valid_lecturer_token(req.token):
        raise HTTPException(401, "Unauthorized")
    msg = sanitize_text(req.message, 1000)
    if not msg:
        raise HTTPException(400, "Message cannot be empty")
    anns = load_lecturer_json(ann_path())
    anns.insert(0, {
        "message": msg,
        "author":  sanitize_text(req.author, MAX_NAME_LEN),
        "date":    datetime.datetime.now().strftime("%d %b %Y, %H:%M"),
    })
    anns = anns[:20]  # Keep last 20
    save_lecturer_json(ann_path(), anns)
    log.info(f"Announcement posted by {req.author}")
    return {"ok": True, "announcements": anns}


@app.post("/api/lecturer/announce/delete")
async def delete_announcement(data: dict):
    if not valid_lecturer_token(data.get("token","")):
        raise HTTPException(401, "Unauthorized")
    anns = load_lecturer_json(ann_path())
    idx  = int(data.get("index", -1))
    if 0 <= idx < len(anns):
        anns.pop(idx)
    save_lecturer_json(ann_path(), anns)
    return {"ok": True, "announcements": anns}


@app.get("/api/lecturer/topics")
async def get_class_topics(token: str = ""):
    return {"topics": load_lecturer_json(topics_path())}


@app.post("/api/lecturer/topics/save")
async def save_class_topics(req: TopicsRequest):
    if not valid_lecturer_token(req.token):
        raise HTTPException(401, "Unauthorized")
    topics = [sanitize_text(t, 100) for t in req.topics if t][:50]
    save_lecturer_json(topics_path(), topics)
    log.info(f"Class topics updated: {topics}")
    return {"ok": True, "topics": topics}


@app.get("/api/lecturer/exams")
async def get_exams(token: str):
    if not valid_lecturer_token(token):
        raise HTTPException(401, "Unauthorized")
    exams = load_lecturer_json(exams_path())
    # Return safe summary (not full question list)
    return {"exams": [{
        "title": e["title"],
        "total_questions": len(e.get("questions",[])),
        "per_student": e.get("questions_per_student", 20),
        "date": e.get("date",""),
    } for e in exams]}


@app.post("/api/lecturer/exam/publish")
async def publish_exam(req: ExamPublishRequest):
    if not valid_lecturer_token(req.token):
        raise HTTPException(401, "Unauthorized")
    if not req.title.strip():
        raise HTTPException(400, "Exam title required")
    if len(req.questions) < req.questions_per_student:
        raise HTTPException(400, f"Need at least {req.questions_per_student} questions")

    exams = load_lecturer_json(exams_path())
    exams.insert(0, {
        "title":                 sanitize_text(req.title, 200),
        "questions":             req.questions[:100],
        "questions_per_student": min(req.questions_per_student, len(req.questions)),
        "date":                  datetime.date.today().isoformat(),
    })
    save_lecturer_json(exams_path(), exams)
    log.info(f"Exam published: {req.title} ({len(req.questions)} questions)")
    return {"ok": True}


@app.post("/api/lecturer/exam/delete")
async def delete_exam(data: dict):
    if not valid_lecturer_token(data.get("token","")):
        raise HTTPException(401, "Unauthorized")
    exams = load_lecturer_json(exams_path())
    idx   = int(data.get("index", -1))
    if 0 <= idx < len(exams):
        exams.pop(idx)
    save_lecturer_json(exams_path(), exams)
    return {"ok": True}


@app.get("/api/exam/student")
async def get_student_exam(sid: str):
    """
    Return a shuffled exam for a specific student.
    Each student gets a unique shuffle based on their SID.
    """
    sid   = sanitize_text(sid, 100)
    exams = load_lecturer_json(exams_path())
    if not exams:
        return {"exam": None}

    # Get the most recently published exam
    exam = exams[0]
    questions = exam.get("questions", [])
    per_student = exam.get("questions_per_student", 20)

    # Deterministic shuffle per student (same student always gets same set)
    import hashlib
    seed = int(hashlib.md5(f"{sid}_{exam['title']}".encode()).hexdigest(), 16)
    rng  = random.Random(seed)
    shuffled = questions.copy()
    rng.shuffle(shuffled)
    student_questions = shuffled[:per_student]

    return {
        "exam": {
            "title":     exam["title"],
            "questions": student_questions,
            "total":     len(student_questions),
        }
    }


# ── Lecturer page ─────────────────────────────────────────────

@app.get("/lecturer", response_class=HTMLResponse)
async def lecturer_page():
    return Path("templates/lecturer.html").read_text()


# ── Lecturer data paths ───────────────────────────────────────

LECTURER_PASSWORD = os.environ.get("LECTURER_PASSWORD", "sivarr_lecturer_2024")
ANN_PATH   = DATA_DIR / "announcements.json"
TOPICS_PATH = DATA_DIR / "class_topics.json"
EXAMS_PATH  = DATA_DIR / "exams.json"


class LecturerLoginRequest(BaseModel):
    name: str
    password: str


class AnnouncementRequest(BaseModel):
    token: str
    text: str
    type: str
    lecturer: str


class TopicsRequest(BaseModel):
    token: str
    topics: list


def verify_lecturer(token: str):
    if not token.startswith("lecturer_"):
        raise HTTPException(401, "Unauthorized")


@app.post("/api/lecturer/login")
async def lecturer_login(req: LecturerLoginRequest, request: Request):
    key = get_client_key(request)
    check_rate_limit(key, 5, "lec_login")
    if req.password != LECTURER_PASSWORD:
        log.warning(f"Failed lecturer login from {key}")
        raise HTTPException(401, "Invalid password")
    log.info(f"Lecturer login: {req.name}")
    return {"ok": True, "token": "lecturer_" + LECTURER_PASSWORD[:6]}


@app.get("/api/lecturer/announcements")
async def get_announcements(token: str):
    verify_lecturer(token)
    data = json.loads(ANN_PATH.read_text()) if ANN_PATH.exists() else []
    return {"announcements": data}


@app.post("/api/lecturer/announcement")
async def post_announcement(req: AnnouncementRequest):
    verify_lecturer(req.token)
    data = json.loads(ANN_PATH.read_text()) if ANN_PATH.exists() else []
    data.append({
        "text":     sanitize_text(req.text, 500),
        "type":     req.type if req.type in ["info","warning","deadline","exam"] else "info",
        "lecturer": sanitize_text(req.lecturer, MAX_NAME_LEN),
        "date":     datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    })
    ANN_PATH.write_text(json.dumps(data, indent=2))
    log.info(f"Announcement posted by {req.lecturer}")
    return {"ok": True}


@app.post("/api/lecturer/announcement/delete")
async def delete_announcement(data: dict):
    verify_lecturer(data.get("token",""))
    idx  = int(data.get("index", -1))
    anns = json.loads(ANN_PATH.read_text()) if ANN_PATH.exists() else []
    if 0 <= idx < len(anns):
        anns.pop(idx)
    ANN_PATH.write_text(json.dumps(anns, indent=2))
    return {"ok": True}


@app.get("/api/announcements/active")
async def active_announcements():
    """Public endpoint — students call this on login."""
    data = json.loads(ANN_PATH.read_text()) if ANN_PATH.exists() else []
    return {"announcements": data[-5:]}  # Return last 5


@app.post("/api/lecturer/topics")
async def save_class_topics(req: TopicsRequest):
    verify_lecturer(req.token)
    clean = [sanitize_text(t, 100) for t in req.topics if t]
    TOPICS_PATH.write_text(json.dumps(clean, indent=2))
    return {"ok": True}


@app.get("/api/lecturer/students")
async def lecturer_students(token: str):
    """Lecturer version of student list — accepts lecturer_ token."""
    if not token.startswith("lecturer_") and not token.startswith("admin_"):
        raise HTTPException(401, "Unauthorized")
    students = get_all_students()
    total_q  = sum(s["questions"] for s in students)
    total_qz = sum(s["quizzes"] for s in students)
    avg_all  = (sum(s["avg_score"] for s in students) / len(students)) if students else 0
    return {
        "students": students, "total": len(students),
        "total_questions": total_q, "total_quizzes": total_qz,
        "avg_score": round(avg_all, 1),
    }


@app.get("/api/lecturer/topics")
async def get_class_topics():
    """Public — students can see suggested topics."""
    data = json.loads(TOPICS_PATH.read_text()) if TOPICS_PATH.exists() else []
    return {"topics": data}


@app.post("/api/lecturer/exam")
async def save_exam(data: dict):
    verify_lecturer(data.get("token",""))
    exams = json.loads(EXAMS_PATH.read_text()) if EXAMS_PATH.exists() else []
    exam  = {
        "id":                   str(uuid.uuid4())[:10],
        "title":                sanitize_text(str(data.get("title","")), 200),
        "questions":            [sanitize_text(str(q), 500) for q in data.get("questions",[])[:100]],
        "questions_per_student": min(int(data.get("questions_per_student", 30)), 100),
        "duration":             min(int(data.get("duration", 60)), 300),
        "lecturer":             sanitize_text(str(data.get("lecturer","")), MAX_NAME_LEN),
        "created":              data.get("created", datetime.datetime.now().strftime("%Y-%m-%d %H:%M")),
    }
    exams.append(exam)
    EXAMS_PATH.write_text(json.dumps(exams, indent=2))
    log.info(f"Exam saved: {exam['title']} by {exam['lecturer']}")
    return {"ok": True, "id": exam["id"]}


@app.get("/api/lecturer/exams")
async def get_exams(token: str):
    verify_lecturer(token)
    exams = json.loads(EXAMS_PATH.read_text()) if EXAMS_PATH.exists() else []
    return {"exams": exams}


@app.post("/api/lecturer/exam/delete")
async def delete_exam(data: dict):
    verify_lecturer(data.get("token",""))
    idx   = int(data.get("index", -1))
    exams = json.loads(EXAMS_PATH.read_text()) if EXAMS_PATH.exists() else []
    if 0 <= idx < len(exams):
        exams.pop(idx)
    EXAMS_PATH.write_text(json.dumps(exams, indent=2))
    return {"ok": True}


@app.get("/exam/{exam_id}", response_class=HTMLResponse)
async def student_exam(exam_id: str, sid: str = ""):
    """Student-facing exam page — shuffles questions uniquely per student."""
    exams = json.loads(EXAMS_PATH.read_text()) if EXAMS_PATH.exists() else []
    exam  = next((e for e in exams if e["id"] == exam_id), None)
    if not exam:
        return HTMLResponse("<h2>Exam not found.</h2>", status_code=404)

    # Shuffle questions uniquely per student using their sid as seed
    import hashlib
    questions = exam["questions"].copy()
    seed = int(hashlib.md5((sid + exam_id).encode()).hexdigest(), 16) % (2**32)
    rng  = random.Random(seed)
    rng.shuffle(questions)
    selected = questions[:exam["questions_per_student"]]

    # Build exam page
    q_html = "".join(f'<div class="eq"><span class="eq-num">{i+1}.</span><span>{esc(q)}</span></div>'
                     for i, q in enumerate(selected))

    return HTMLResponse(f"""<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(exam['title'])}</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#08090d;color:#f0f1f5;font-family:'DM Sans',sans-serif;padding:2rem;min-height:100vh}}
.header{{background:#13151c;border:1px solid #1c1f2a;border-radius:14px;padding:1.5rem;margin-bottom:1.5rem}}
.logo{{display:flex;align-items:center;gap:8px;margin-bottom:1rem}}
.mono{{width:32px;height:32px;background:linear-gradient(135deg,#4f6ef7,#7c3aed);border-radius:8px;
  display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:#fff;font-family:'Outfit',sans-serif}}
h1{{font-family:'Outfit',sans-serif;font-size:1.3rem;font-weight:800;margin-bottom:.3rem}}
.meta{{color:#5a5f7a;font-size:.83rem}}
.pill{{display:inline-block;background:#4f6ef715;border:1px solid #4f6ef730;color:#4f6ef7;
  padding:3px 10px;border-radius:20px;font-size:.75rem;font-weight:700;margin:2px}}
.eq{{background:#13151c;border:1px solid #1c1f2a;border-radius:10px;padding:12px 16px;
  margin-bottom:8px;display:flex;gap:10px;font-size:.9rem;line-height:1.6}}
.eq-num{{font-family:'Outfit',sans-serif;font-weight:700;color:#4f6ef7;min-width:24px}}
.warning{{background:#78350f20;border:1px solid #f59e0b40;border-radius:10px;padding:10px 14px;
  color:#f59e0b;font-size:.82rem;margin-bottom:1rem}}
</style></head><body>
<div class="header">
  <div class="logo"><div class="mono">Sr</div><strong style="font-family:'Outfit',sans-serif">Sivarr AI</strong></div>
  <h1>{esc(exam['title'])}</h1>
  <div class="meta">By {esc(exam['lecturer'])} · {exam['questions_per_student']} questions · {exam['duration']} minutes</div>
  <div style="margin-top:.75rem">
    <span class="pill">📝 {exam['questions_per_student']} Questions</span>
    <span class="pill">⏱ {exam['duration']} mins</span>
  </div>
</div>
<div class="warning">⚠️ Questions are shuffled uniquely for each student. Complete on paper or as directed by your lecturer.</div>
{q_html}
</body></html>""")

# ── Leaderboard ──────────────────────────────────────────────

@app.get("/api/leaderboard")
async def leaderboard():
    """Public leaderboard — top students by quiz average."""
    students = get_all_students()
    # Only include students who have taken at least 1 quiz
    ranked = [s for s in students if s["quizzes"] > 0]
    ranked.sort(key=lambda s: (s["avg_score"], s["quizzes"]), reverse=True)
    # Add sid field for "you" highlighting — derived from name + matric
    for s in ranked:
        name   = s["name"].lower().strip()
        matric = s["matric"].lower().strip()
        s["sid"] = re.sub(r"[^a-z0-9_]", "_", f"{name}_{matric}")
    return {"leaderboard": ranked[:20]}  # Top 20


# ── Health check ──────────────────────────────────────────────

@app.get("/health")
async def health():
    """Simple health check endpoint for Railway."""
    return {
        "status":  "ok",
        "version": VERSION,
        "time":    datetime.datetime.now().isoformat(),
        "gemini":  GEMINI_AVAILABLE,
        "model":   _model_name or "not initialized",
    }

