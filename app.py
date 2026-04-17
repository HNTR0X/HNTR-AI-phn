"""
Sivarr AI Web App — FastAPI Backend v4.2
Added: Rate limiting, Input validation, Error logging
"""

import ast
import collections
import datetime
import hashlib
import hmac
import bcrypt
import json
import logging
import os
import random
import re
import secrets
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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.StreamHandler(),
    ]
)
log = logging.getLogger("sivarr")

# ═══════════════════════════════════════════════════════════════
#  CONFIGURATION
# ═══════════════════════════════════════════════════════════════

VERSION       = "3"
CACHE_EXPIRY  = 30
HISTORY_LIMIT = 40
BANK_LIMIT    = 20
# Use Railway persistent volume if available, else local
# Set RAILWAY_VOLUME_MOUNT_PATH in Railway environment variables
_BASE = Path(os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", "."))
DATA_DIR    = _BASE / "data"
UPLOADS_DIR = _BASE / "uploads"
SHARES_DIR  = _BASE / "shares"
LOG_DIR     = _BASE / "logs"

for d in [DATA_DIR, UPLOADS_DIR, SHARES_DIR, LOG_DIR]:
    d.mkdir(parents=True, exist_ok=True)

ADMIN_PASSWORD     = os.environ.get("ADMIN_PASSWORD", "sivarr_admin_2024")
LECTURER_PASSWORD  = os.environ.get("LECTURER_PASSWORD", "sivarr_lecturer_2024")

# ── Shared file paths (defined early so all functions can use them) ──
ANN_PATH    = DATA_DIR / "announcements.json"
TOPICS_PATH = DATA_DIR / "class_topics.json"
EXAMS_PATH  = DATA_DIR / "exams.json"
CLASSES_PATH = DATA_DIR / "classes.json"
USERS_PATH   = DATA_DIR / "users.json"

def load_users() -> dict:
    if USERS_PATH.exists():
        try: return json.loads(USERS_PATH.read_text())
        except: return {}
    return {}

def save_users(users: dict):
    tmp = str(USERS_PATH) + ".tmp"
    with open(tmp, "w") as f: json.dump(users, f, indent=2)
    shutil.move(tmp, str(USERS_PATH))

# ── Rate limiting config ──────────────────────────────────────
RATE_LIMIT_CHAT     = int(os.environ.get("RATE_LIMIT_CHAT", 20))      # max chat msgs per window
RATE_LIMIT_QUIZ     = int(os.environ.get("RATE_LIMIT_QUIZ", 5))      # max quiz questions per window
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
    Persistent rate limiter using sliding window.
    Backed by a JSON file so limits survive server restarts.
    In-memory cache for speed, flushed to disk periodically.
    """
    def __init__(self):
        self._counts   = collections.defaultdict(list)
        self._dirty    = False
        self._path     = None   # set after DATA_DIR is defined
        self._last_save = time.time()
        self._save_interval = 30  # seconds between disk flushes

    def _set_path(self, path: Path):
        self._path = path
        self._load()

    def _load(self):
        """Load persisted rate limit state from disk."""
        if self._path and self._path.exists():
            try:
                data = json.loads(self._path.read_text())
                now  = time.time()
                # Only load recent entries — discard old ones
                self._counts = collections.defaultdict(list, {
                    k: [t for t in v if now - t < RATE_LIMIT_WINDOW * 2]
                    for k, v in data.items()
                })
            except Exception:
                self._counts = collections.defaultdict(list)

    def _save(self):
        """Flush rate limit state to disk."""
        if self._path and self._dirty:
            try:
                tmp = str(self._path) + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(dict(self._counts), f)
                shutil.move(tmp, str(self._path))
                self._dirty = False
                self._last_save = time.time()
            except Exception:
                pass

    def is_allowed(self, key: str, limit: int, window: int = RATE_LIMIT_WINDOW) -> bool:
        now   = time.time()
        calls = self._counts[key]
        self._counts[key] = [t for t in calls if now - t < window]
        if len(self._counts[key]) >= limit:
            return False
        self._counts[key].append(now)
        self._dirty = True
        # Periodic save
        if now - self._last_save > self._save_interval:
            self._save()
        return True

    def remaining(self, key: str, limit: int, window: int = RATE_LIMIT_WINDOW) -> int:
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
    - Prevents path traversal sequences
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


def validate_sid(sid: str) -> str:
    """
    Validate and sanitize student session ID.
    - Must be alphanumeric + underscores only
    - Max 100 chars
    - Prevents path traversal (no dots, slashes)
    """
    sid = sanitize_text(sid, 100)
    # Remove any path traversal characters
    sid = re.sub(r"[^a-z0-9_]", "_", sid.lower())
    if not sid or len(sid) < 3:
        raise HTTPException(400, "Invalid session ID.")
    # Block traversal patterns
    if ".." in sid or "/" in sid or "\\" in sid:
        raise HTTPException(400, "Invalid session ID.")
    return sid


def safe_path(base_dir: Path, filename: str) -> Path:
    """
    Return a safe path within base_dir, preventing path traversal.
    Raises HTTPException if the resolved path escapes base_dir.
    """
    # Sanitise filename
    safe_name = re.sub(r"[^a-zA-Z0-9_\-.]", "_", filename)
    full_path  = (base_dir / safe_name).resolve()
    # Ensure it stays within base_dir
    try:
        full_path.relative_to(base_dir.resolve())
    except ValueError:
        log.warning(f"Path traversal attempt: {filename}")
        raise HTTPException(400, "Invalid file path.")
    return full_path


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

from fastapi.staticfiles import StaticFiles
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/css", StaticFiles(directory="css"), name="css")
app.mount("/js",  StaticFiles(directory="js"),  name="js")

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
    password: str = ""
    email: str    = ""
    phone: str    = ""
    action: str   = "login"   # "login" | "register"

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
    return Path("/index.html").read_text()

@app.get("/admin", response_class=HTMLResponse)
async def admin_page():
    return Path("templates/admin.html").read_text()


@app.post("/api/login")
async def login(req: LoginRequest, request: Request):
    key = get_client_key(request)
    check_rate_limit(key, RATE_LIMIT_LOGIN, "login")

    sid = re.sub(r"[^a-z0-9_]", "_",
          f"{req.name.lower().strip()}_{req.matric.lower().strip()}")

    users = load_users()

    # ── REGISTER ──────────────────────────────────────────────
    if req.action == "register":
        if not req.password or len(req.password) < 6:
            raise HTTPException(400, "Password must be at least 6 characters.")
        if sid in users:
            raise HTTPException(409, "Account already exists. Please sign in.")
        hashed = bcrypt.hashpw(req.password.encode(), bcrypt.gensalt()).decode()
        users[sid] = {
            "sid":      sid,
            "name":     sanitize_text(req.name.title(), MAX_NAME_LEN),
            "matric":   req.matric.upper(),
            "email":    sanitize_text(req.email, 200),
            "phone":    sanitize_text(req.phone, 30),
            "password": hashed,
            "created":  datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        }
        save_users(users)
        log.info(f"Register: {users[sid]['name']} ({users[sid]['matric']})")

    # ── LOGIN ──────────────────────────────────────────────────
    else:
        if sid in users:
            stored = users[sid].get("password", "")
            if stored:
                if not req.password:
                    raise HTTPException(401, "Password required.")
                if not bcrypt.checkpw(req.password.encode(), stored.encode()):
                    raise HTTPException(401, "Incorrect password.")
        # Legacy accounts (no password) pass through until they register

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
        "date": datetime.date.today().isoformat(),
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

    # Quiz trend — last 10 with dates for sparkline
    quiz_history = [
        {"pct": q.get("pct", 0), "topic": q.get("topic",""), "date": q.get("date","")}
        for q in quizzes[-10:]
    ]

    # Topic mastery — convert count to mastery %
    topics = p.get("topics", {})
    max_count = max(topics.values()) if topics else 1
    topic_mastery = {t: min(round((c / max_count) * 100), 100) for t, c in topics.items()}

    # Streak calculation
    streak = p.get("streak", 0)
    last_active = p.get("last_active", "")
    today = datetime.date.today().isoformat()
    yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    if last_active not in [today, yesterday]:
        streak = 0

    # Best topic
    best_topic = max(topics, key=topics.get) if topics else None

    # Study sessions this week
    chat_hist = p.get("chat_history", [])
    week_ago = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()
    sessions_week = len(set(
        h.get("time","")[:10] for h in chat_hist
        if h.get("time","")[:10] >= week_ago
    ))

    return {
        "name": p.get("name",""), "matric": p.get("matric",""),
        "sessions": p["sessions"], "questions": p["questions"],
        "topics": topics, "weak": weak_topics(p),
        "difficulty": p.get("difficulty","medium"),
        "quizzes_taken": len(quizzes), "avg_score": round(avg, 1),
        "last_quiz": quizzes[-1] if quizzes else None,
        "wrong_count": len(p.get("wrong_answers",[])),
        "uploaded_files": p.get("uploaded_files",[]),
        "quiz_history": quiz_history,
        "topic_mastery": topic_mastery,
        "streak": streak,
        "best_topic": best_topic,
        "sessions_week": sessions_week,
        "xp": p.get("xp", 0),
        "level": p.get("level", 1),
        "badges": p.get("badges", []),
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
    sid = validate_sid(sid)
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
    # Generate cryptographic token — HMAC of password + secret
    token = "admin_" + hmac.new(
        ADMIN_PASSWORD.encode(), b"sivarr_admin", hashlib.sha256
    ).hexdigest()[:16]
    return {"ok": True, "token": token}


@app.get("/api/admin/students")
async def admin_students(token: str):
    if not hmac.compare_digest(token, _expected_admin_token()):
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
#  LECTURER ENDPOINTS
# ═══════════════════════════════════════════════════════════════

@app.get("/lecturer", response_class=HTMLResponse)
async def lecturer_page():
    return Path("templates/lecturer.html").read_text()


class LecturerLoginRequest(BaseModel):
    name: str
    password: str


def _expected_lecturer_token() -> str:
    return "lecturer_" + hmac.new(
        LECTURER_PASSWORD.encode(), b"sivarr_lecturer", hashlib.sha256
    ).hexdigest()[:16]

def _expected_admin_token() -> str:
    return "admin_" + hmac.new(
        ADMIN_PASSWORD.encode(), b"sivarr_admin", hashlib.sha256
    ).hexdigest()[:16]

def verify_lecturer(token: str):
    """Verify lecturer token using constant-time comparison."""
    expected = _expected_lecturer_token()
    if not hmac.compare_digest(token, expected):
        raise HTTPException(401, "Unauthorized")


@app.post("/api/lecturer/login")
async def lecturer_login(req: LecturerLoginRequest, request: Request):
    key = get_client_key(request)
    check_rate_limit(key, 5, "lec_login")
    if req.password != LECTURER_PASSWORD:
        log.warning(f"Failed lecturer login: {req.name}")
        raise HTTPException(401, "Invalid password")
    log.info(f"Lecturer login: {req.name}")
    # Generate cryptographic token — HMAC of password + secret
    token = "lecturer_" + hmac.new(
        LECTURER_PASSWORD.encode(), b"sivarr_lecturer", hashlib.sha256
    ).hexdigest()[:16]
    return {"ok": True, "token": token}


@app.get("/api/lecturer/students")
async def lecturer_students(token: str):
    verify_lecturer(token)
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
async def get_announcements(token: str):
    verify_lecturer(token)
    data = json.loads(ANN_PATH.read_text()) if ANN_PATH.exists() else []
    return {"announcements": data}


class AnnouncementRequest(BaseModel):
    token: str
    text: str
    type: str
    lecturer: str


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
    data = json.loads(ANN_PATH.read_text()) if ANN_PATH.exists() else []
    return {"announcements": data[-5:]}


class TopicsRequest(BaseModel):
    token: str
    topics: list


@app.post("/api/lecturer/topics")
async def save_class_topics(req: TopicsRequest):
    verify_lecturer(req.token)
    clean = [sanitize_text(t, 100) for t in req.topics if t]
    TOPICS_PATH.write_text(json.dumps(clean, indent=2))
    return {"ok": True}


@app.get("/api/lecturer/topics")
async def get_class_topics():
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




# ── Class request models ──────────────────────────────────────

class CreateClassRequest(BaseModel):
    token: str
    name: str
    subject: str
    lecturer: str

class JoinClassRequest(BaseModel):
    sid: str
    code: str

class MaterialRequest(BaseModel):
    token: str
    code: str = ""
    title: str
    content: str = ""
    url: str = ""
    type: str

class ClassAnnouncementRequest(BaseModel):
    token: str
    code: str
    text: str
    type: str
    author: str = ""

class LiveClassRequest(BaseModel):
    token: str
    code: str = ""
    link: str
    title: str = ""

class AssignmentRequest(BaseModel):
    token: str
    code: str = ""
    title: str
    description: str = ""
    due_date: str = ""
    due: str = ""

class SubmitAssignmentRequest(BaseModel):
    sid: str
    code: str
    assignment_id: str
    content: str

class DiscussionRequest(BaseModel):
    sid: str
    code: str
    message: str
    name: str

class AssignExamRequest(BaseModel):
    token: str
    code: str = ""
    exam_id: str

# ── Classes helper functions ──────────────────────────────────

def load_classes() -> dict:
    """Load all classes from JSON file."""
    if CLASSES_PATH.exists():
        try:
            return json.loads(CLASSES_PATH.read_text())
        except Exception:
            return {}
    return {}


def save_classes(classes: dict):
    """Save classes atomically using temp file."""
    tmp = str(CLASSES_PATH) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(classes, f, indent=2)
    shutil.move(tmp, str(CLASSES_PATH))


def generate_class_code() -> str:
    """Generate a unique 6-char alphanumeric class code."""
    import string
    chars   = string.ascii_uppercase + string.digits
    classes = load_classes()
    while True:
        code = "".join(random.choices(chars, k=6))
        if code not in classes:
            return code


def get_student_classes(sid: str) -> list:
    """Return all classes a student has joined."""
    classes = load_classes()
    result  = []
    for code, cls in classes.items():
        if sid in cls.get("students", []):
            result.append({
                "code":     code,
                "name":     cls.get("name", ""),
                "subject":  cls.get("subject", ""),
                "lecturer": cls.get("lecturer", ""),
                "materials":     cls.get("materials", []),
                "announcements": cls.get("announcements", []),
                "live_class":    cls.get("live_class"),
                "assignments":   cls.get("assignments", []),
                "exams":         cls.get("exams", []),
            })
    return result

@app.post("/api/class/create")
async def create_class(req: CreateClassRequest):
    verify_lecturer(req.token)
    code    = generate_class_code()
    classes = load_classes()
    classes[code] = {
        "name":          sanitize_text(req.name, 100),
        "subject":       sanitize_text(req.subject, 100),
        "lecturer":      sanitize_text(req.lecturer, MAX_NAME_LEN),
        "code":          code,
        "created":       datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "students":      [],
        "materials":     [],
        "announcements": [],
        "live_class":    None,
        "assignments":   [],
        "discussions":   [],
        "exams":         [],
    }
    save_classes(classes)
    log.info(f"Class created: {req.name} ({code}) by {req.lecturer}")
    return {"ok": True, "code": code}

# ── Lecturer: Get their classes ───────────────────────────────

@app.get("/api/class/lecturer")
async def lecturer_classes(token: str):
    verify_lecturer(token)
    classes = load_classes()
    return {
        "classes": [
            {**cls, "code": code, "student_count": len(cls.get("students", []))}
            for code, cls in classes.items()
        ]
    }

# ── Lecturer: Post material ───────────────────────────────────

@app.post("/api/class/material")
async def add_material(req: MaterialRequest):
    verify_lecturer(req.token)
    classes = load_classes()
    if req.code not in classes:
        raise HTTPException(404, "Class not found")
    material = {
        "id":      str(uuid.uuid4())[:8],
        "title":   sanitize_text(req.title, 200),
        "content": sanitize_text(req.content, 2000),
        "type":    req.type if req.type in ["link","note","file"] else "note",
        "date":    datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    classes[req.code].setdefault("materials", []).append(material)
    save_classes(classes)
    return {"ok": True}

# ── Lecturer: Post class announcement ────────────────────────

@app.post("/api/class/announcement")
async def class_announcement(req: ClassAnnouncementRequest):
    verify_lecturer(req.token)
    classes = load_classes()
    if req.code not in classes:
        raise HTTPException(404, "Class not found")
    ann = {
        "id":     str(uuid.uuid4())[:8],
        "text":   sanitize_text(req.text, 500),
        "type":   req.type if req.type in ["info","warning","deadline","exam"] else "info",
        "date":   datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "author": sanitize_text(req.author, MAX_NAME_LEN),
    }
    classes[req.code].setdefault("announcements", []).append(ann)
    save_classes(classes)
    return {"ok": True}

# ── Lecturer: Set live class link ─────────────────────────────

@app.post("/api/class/live")
async def set_live_class(req: LiveClassRequest):
    verify_lecturer(req.token)
    classes = load_classes()
    if req.code not in classes:
        raise HTTPException(404, "Class not found")
    classes[req.code]["live_class"] = {
        "link":  sanitize_text(req.link, 500),
        "title": sanitize_text(req.title, 200),
        "date":  datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    save_classes(classes)
    return {"ok": True}

# ── Lecturer: Create assignment ───────────────────────────────

@app.post("/api/class/assignment")
async def create_assignment(req: AssignmentRequest):
    verify_lecturer(req.token)
    classes = load_classes()
    if req.code not in classes:
        raise HTTPException(404, "Class not found")
    assignment = {
        "id":          str(uuid.uuid4())[:8],
        "title":       sanitize_text(req.title, 200),
        "description": sanitize_text(req.description, 1000),
        "due_date":    sanitize_text(req.due_date, 50),
        "date":        datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "submissions": [],
    }
    classes[req.code].setdefault("assignments", []).append(assignment)
    save_classes(classes)
    return {"ok": True, "id": assignment["id"]}

# ── Lecturer: Assign exam to class ───────────────────────────

@app.post("/api/class/assign-exam")
async def assign_exam_to_class(req: AssignExamRequest):
    verify_lecturer(req.token)
    classes = load_classes()
    exams   = json.loads(EXAMS_PATH.read_text()) if EXAMS_PATH.exists() else []
    exam    = next((e for e in exams if e["id"] == req.exam_id), None)
    if not exam:
        raise HTTPException(404, "Exam not found")
    if req.code not in classes:
        raise HTTPException(404, "Class not found")
    classes[req.code].setdefault("exams", [])
    if req.exam_id not in [e["id"] for e in classes[req.code]["exams"]]:
        classes[req.code]["exams"].append({
            "id":    exam["id"],
            "title": exam["title"],
            "date":  datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        })
    save_classes(classes)
    return {"ok": True}

# ── Lecturer: View submissions ────────────────────────────────

@app.get("/api/class/submissions")
async def get_submissions(token: str, code: str, assignment_id: str):
    verify_lecturer(token)
    classes = load_classes()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    for a in classes[code].get("assignments", []):
        if a["id"] == assignment_id:
            return {"submissions": a.get("submissions", [])}
    raise HTTPException(404, "Assignment not found")

# ── Lecturer: Delete class ────────────────────────────────────

@app.post("/api/class/delete")
async def delete_class(data: dict):
    verify_lecturer(data.get("token", ""))
    code    = data.get("code", "")
    classes = load_classes()
    if code in classes:
        del classes[code]
        save_classes(classes)
    return {"ok": True}

# ── Student: Join class ───────────────────────────────────────

@app.post("/api/class/join")
async def join_class(req: JoinClassRequest, request: Request):
    key = get_client_key(request, req.sid)
    check_rate_limit(key, 10, "join_class")
    classes = load_classes()
    code    = req.code.upper().strip()
    if code not in classes:
        raise HTTPException(404, "Class not found. Check the code and try again.")
    cls = classes[code]
    if req.sid not in cls["students"]:
        cls["students"].append(req.sid)
        save_classes(classes)
    return {
        "ok":      True,
        "code":    code,
        "name":    cls["name"],
        "subject": cls["subject"],
        "lecturer": cls["lecturer"],
    }

# ── Student: Leave class ──────────────────────────────────────

@app.post("/api/class/leave")
async def leave_class(data: dict):
    sid     = sanitize_text(str(data.get("sid", "")), 100)
    code    = sanitize_text(str(data.get("code", "")), 10).upper()
    classes = load_classes()
    if code in classes and sid in classes[code]["students"]:
        classes[code]["students"].remove(sid)
        save_classes(classes)
    return {"ok": True}

# ── Student: Get their classes ────────────────────────────────

@app.get("/api/class/student")
async def student_classes(sid: str):
    sid = validate_sid(sid)
    return {"classes": get_student_classes(sid)}

# ── Student/All: Get class detail ────────────────────────────

@app.get("/api/class/detail")
async def class_detail(code: str, sid: str = ""):
    code    = sanitize_text(code, 10).upper()
    classes = load_classes()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    cls = dict(classes[code])
    cls["code"]          = code
    cls["student_count"] = len(cls.get("students", []))
    cls["is_member"]     = sid in cls.get("students", []) if sid else False
    # Don't expose student list publicly
    cls.pop("students", None)
    return cls

# ── Student: Submit assignment ────────────────────────────────

@app.post("/api/class/submit")
async def submit_assignment(req: SubmitAssignmentRequest):
    classes = load_classes()
    if req.code not in classes:
        raise HTTPException(404, "Class not found")
    p    = load_progress(req.sid)
    name = p.get("name", "Unknown")
    for a in classes[req.code].get("assignments", []):
        if a["id"] == req.assignment_id:
            # Check if already submitted
            existing = [s for s in a.get("submissions", []) if s["sid"] == req.sid]
            if existing:
                existing[0]["content"] = sanitize_text(req.content, 5000)
                existing[0]["date"]    = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
                existing[0]["resubmitted"] = True
            else:
                a.setdefault("submissions", []).append({
                    "sid":     req.sid,
                    "name":    name,
                    "content": sanitize_text(req.content, 5000),
                    "date":    datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
                })
            save_classes(classes)
            return {"ok": True}
    raise HTTPException(404, "Assignment not found")

# ── Discussion ────────────────────────────────────────────────

@app.post("/api/class/discuss")
async def post_discussion(req: DiscussionRequest, request: Request):
    key = get_client_key(request, req.sid)
    check_rate_limit(key, 20, "discuss")
    classes = load_classes()
    if req.code not in classes:
        raise HTTPException(404, "Class not found")
    msg = {
        "id":      str(uuid.uuid4())[:8],
        "sid":     req.sid,
        "name":    sanitize_text(req.name, MAX_NAME_LEN),
        "message": sanitize_text(req.message, 1000),
        "date":    datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    classes[req.code].setdefault("discussions", []).append(msg)
    # Keep last 200 messages
    classes[req.code]["discussions"] = classes[req.code]["discussions"][-200:]
    save_classes(classes)
    return {"ok": True, "msg": msg}

@app.get("/api/class/discuss")
async def get_discussion(code: str, since: str = ""):
    code    = sanitize_text(code, 10).upper()
    classes = load_classes()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    msgs = classes[code].get("discussions", [])
    if since:
        msgs = [m for m in msgs if m.get("date","") > since]
    return {"messages": msgs[-100:]}


# ── Group Chat ────────────────────────────────────────────────

GROUPS_PATH = DATA_DIR / "groups.json"

def load_groups() -> dict:
    if GROUPS_PATH.exists():
        try: return json.loads(GROUPS_PATH.read_text())
        except: return {}
    return {}

def save_groups(groups: dict):
    tmp = str(GROUPS_PATH) + ".tmp"
    with open(tmp, "w") as f: json.dump(groups, f, indent=2)
    shutil.move(tmp, str(GROUPS_PATH))


@app.post("/api/group/create")
async def create_group(data: dict, request: Request):
    sid  = validate_sid(str(data.get("sid","")))
    name = sanitize_text(str(data.get("name","")), 80)
    if not name: raise HTTPException(400, "Group name required")
    groups = load_groups()
    gid = str(uuid.uuid4())[:10]
    groups[gid] = {
        "id":       gid,
        "name":     name,
        "created_by": sid,
        "created_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "members":  [sid],
        "messages": [],
    }
    save_groups(groups)
    return {"ok": True, "group_id": gid, "name": name}


@app.post("/api/group/join")
async def join_group(data: dict):
    sid = validate_sid(str(data.get("sid","")))
    gid = sanitize_text(str(data.get("group_id","")), 20)
    groups = load_groups()
    if gid not in groups: raise HTTPException(404, "Group not found")
    if sid not in groups[gid]["members"]:
        groups[gid]["members"].append(sid)
    save_groups(groups)
    return {"ok": True, "name": groups[gid]["name"]}


@app.get("/api/group/list")
async def list_groups(sid: str):
    sid    = validate_sid(sid)
    groups = load_groups()
    member_of = [
        {"id": gid, "name": g["name"], "member_count": len(g["members"]),
         "last_msg": g["messages"][-1]["message"][:50] if g["messages"] else "",
         "last_date": g["messages"][-1]["date"] if g["messages"] else g["created_at"]}
        for gid, g in groups.items() if sid in g["members"]
    ]
    return {"groups": member_of}


@app.post("/api/group/message")
async def send_group_message(data: dict, request: Request):
    sid     = validate_sid(str(data.get("sid","")))
    gid     = sanitize_text(str(data.get("group_id","")), 20)
    message = sanitize_text(str(data.get("message","")), 1000)
    name    = sanitize_text(str(data.get("name","Student")), MAX_NAME_LEN)
    groups  = load_groups()
    if gid not in groups: raise HTTPException(404, "Group not found")
    if sid not in groups[gid]["members"]: raise HTTPException(403, "Not a member")
    msg = {
        "id":      str(uuid.uuid4())[:8],
        "sid":     sid,
        "name":    name,
        "message": message,
        "date":    datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    groups[gid]["messages"].append(msg)
    groups[gid]["messages"] = groups[gid]["messages"][-300:]
    save_groups(groups)
    return {"ok": True, "msg": msg}


@app.get("/api/group/messages")
async def get_group_messages(group_id: str, sid: str):
    sid    = validate_sid(sid)
    gid    = sanitize_text(group_id, 20)
    groups = load_groups()
    if gid not in groups: raise HTTPException(404, "Group not found")
    if sid not in groups[gid]["members"]: raise HTTPException(403, "Not a member")
    return {"messages": groups[gid]["messages"][-100:], "name": groups[gid]["name"]}


# ── Dynamic class routes (lecturer management) ───────────────

@app.get("/api/class/lecturer/all")
async def lecturer_all_classes(token: str, lecturer: str = ""):
    """Get all classes for a specific lecturer."""
    verify_lecturer(token)
    classes = load_classes()
    result  = []
    for code, cls in classes.items():
        if not lecturer or cls.get("lecturer","").lower() == lecturer.lower():
            result.append({**cls, "code": code, "student_count": len(cls.get("students",[]))})
    return {"classes": result}


@app.get("/api/class/{code}/lecturer")
async def class_detail_lecturer(code: str, token: str):
    """Get full class detail for lecturer (includes student list)."""
    verify_lecturer(token)
    classes = load_classes()
    code    = code.upper()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    cls = dict(classes[code])
    cls["code"]          = code
    cls["student_count"] = len(cls.get("students",[]))
    return cls


@app.post("/api/class/{code}/material")
async def add_material_dynamic(code: str, req: MaterialRequest):
    """Add material to a class."""
    verify_lecturer(req.token)
    classes = load_classes()
    code    = code.upper()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    material = {
        "id":      str(uuid.uuid4())[:8],
        "title":   sanitize_text(req.title, 200),
        "content": sanitize_text(req.content, 2000),
        "url":     sanitize_text(req.url, 500),
        "type":    req.type if req.type in ["link","note","file"] else "note",
        "date":    datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    classes[code].setdefault("materials",[]).append(material)
    save_classes(classes)
    return {"ok": True, "id": material["id"]}


@app.post("/api/class/{code}/material/delete")
async def delete_material(code: str, req: dict):
    """Delete a material from a class."""
    token       = req.get("token","")
    material_id = req.get("id","")
    verify_lecturer(token)
    classes = load_classes()
    code    = code.upper()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    classes[code]["materials"] = [
        m for m in classes[code].get("materials",[]) if m["id"] != material_id
    ]
    save_classes(classes)
    return {"ok": True}


@app.post("/api/class/{code}/assignment")
async def add_assignment_dynamic(code: str, req: AssignmentRequest):
    """Add assignment to a class."""
    verify_lecturer(req.token)
    classes = load_classes()
    code    = code.upper()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    assignment = {
        "id":          str(uuid.uuid4())[:8],
        "title":       sanitize_text(req.title, 200),
        "description": sanitize_text(req.description, 1000),
        "due_date":    sanitize_text(req.due_date, 50),
        "date":        datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "submissions": [],
    }
    classes[code].setdefault("assignments",[]).append(assignment)
    save_classes(classes)
    return {"ok": True, "id": assignment["id"]}


@app.post("/api/class/{code}/exam")
async def assign_exam_dynamic(code: str, req: AssignExamRequest):
    """Assign an exam to a class."""
    verify_lecturer(req.token)
    classes = load_classes()
    exams   = json.loads(EXAMS_PATH.read_text()) if EXAMS_PATH.exists() else []
    code    = code.upper()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    exam = next((e for e in exams if e["id"] == req.exam_id), None)
    if not exam:
        raise HTTPException(404, "Exam not found")
    classes[code].setdefault("exams",[])
    if req.exam_id not in [e["id"] for e in classes[code]["exams"]]:
        classes[code]["exams"].append({
            "id": exam["id"], "title": exam["title"],
            "date": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        })
    save_classes(classes)
    return {"ok": True}


@app.post("/api/class/{code}/link")
async def set_class_link(code: str, req: LiveClassRequest):
    """Set live class link."""
    verify_lecturer(req.token)
    classes = load_classes()
    code    = code.upper()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    classes[code]["live_class"] = {
        "link":  sanitize_text(req.link, 500),
        "title": sanitize_text(req.title, 200),
        "date":  datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    save_classes(classes)
    return {"ok": True}


@app.get("/api/class/{code}/discuss")
async def get_class_discuss(code: str):
    """Get discussion messages for a class."""
    code    = code.upper()
    classes = load_classes()
    if code not in classes:
        raise HTTPException(404, "Class not found")
    return {"messages": classes[code].get("discussions",[])[-50:]}



# ── Study Haven ───────────────────────────────────────────────

STUDY_DECK_PROMPT = """You are Sivarr's Study Haven — an expert at turning raw lecture content into clean, structured study material.

A student uploaded the following lecture content:

{text}

Generate a comprehensive study pack with exactly these three sections:

---
## 📋 SUMMARY
Write a concise 4-6 sentence overview of the entire lecture. Capture the main argument, key theme, and why this topic matters.

---
## 📚 STRUCTURED NOTES

### [Main Topic 1]
- **Key Concept:** definition or explanation
- **Key Concept:** definition or explanation

### [Main Topic 2]
- **Key Concept:** definition or explanation
- **Key Concept:** definition or explanation

(continue for all major topics — use actual topic names from the content)

---
## ❓ PRACTICE QUESTIONS
Generate exactly 5 practice questions based on the content. Mix question types:
1. [Question]
2. [Question]
3. [Question]
4. [Question]
5. [Question]

Keep everything concise, clear and student-friendly. Use the actual content — don't make things up.
"""


@app.post("/api/study-deck")
async def study_deck(request: Request, sid: str = Form(...), file: UploadFile = File(...)):
    """Process uploaded lecture content and generate structured study material."""
    sid = sanitize_text(sid, 100)
    key = get_client_key(request, sid)
    check_rate_limit(key, 3, "study_deck")  # Strict limit — expensive operation

    allowed = [".txt", ".pdf", ".md"]
    ext     = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, "Use .txt, .pdf, or .md files only.")

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(400, "File too large. Maximum 5MB.")

    # Extract text
    if ext == ".pdf":
        try:
            import io
            try:
                import pypdf
                reader = pypdf.PdfReader(io.BytesIO(content))
                text   = "\n".join(page.extract_text() or "" for page in reader.pages)
            except ImportError:
                text = content.decode("utf-8", errors="ignore")
        except Exception:
            text = content.decode("utf-8", errors="ignore")
    else:
        text = content.decode("utf-8", errors="ignore")

    text = sanitize_text(text, 8000)
    if not text.strip():
        raise HTTPException(400, "Could not extract text from file.")

    log.info(f"Study Haven processing: {file.filename} for {sid[:20]}")

    # Generate study pack
    result = gemini_once(
        STUDY_DECK_PROMPT.format(text=text[:6000]),
        temp=0.4,
        tokens=2000,
    )

    if not result:
        raise HTTPException(503, "AI is busy right now — try again in a moment.")

    return {
        "filename": file.filename,
        "result":   result,
        "chars":    len(text),
    }



# ══════════════════════════════════════════════════════════════════
#  ENHANCED EXAM SYSTEM
# ══════════════════════════════════════════════════════════════════

EXAM_RESULTS_PATH = DATA_DIR / "exam_results.json"
EXAM_SESSIONS_PATH = DATA_DIR / "exam_sessions.json"

def load_exam_results() -> list:
    if EXAM_RESULTS_PATH.exists():
        try: return json.loads(EXAM_RESULTS_PATH.read_text())
        except: return []
    return []

def save_exam_results(results: list):
    tmp = str(EXAM_RESULTS_PATH) + ".tmp"
    with open(tmp, "w") as f: json.dump(results, f, indent=2)
    shutil.move(tmp, str(EXAM_RESULTS_PATH))

def load_exam_sessions() -> dict:
    if EXAM_SESSIONS_PATH.exists():
        try: return json.loads(EXAM_SESSIONS_PATH.read_text())
        except: return {}
    return {}

def save_exam_sessions(sessions: dict):
    tmp = str(EXAM_SESSIONS_PATH) + ".tmp"
    with open(tmp, "w") as f: json.dump(sessions, f, indent=2)
    shutil.move(tmp, str(EXAM_SESSIONS_PATH))


AI_EXAM_PROMPT = """You are an expert university exam question generator.
Generate exactly {count} high-quality multiple choice questions on the topic: "{topic}"
Difficulty level: {difficulty}
Question types to mix: {types}

Return ONLY a valid JSON array with no extra text. Each object must have:
{{
  "question": "Question text here",
  "options": {{"A": "option", "B": "option", "C": "option", "D": "option"}},
  "answer": "A",
  "explanation": "Why this is correct",
  "type": "mcq",
  "difficulty": "{difficulty}"
}}"""


@app.post("/api/exam/generate")
async def generate_exam_questions(data: dict, request: Request):
    """AI generates exam questions from a topic."""
    verify_lecturer(data.get("token", ""))
    topic      = sanitize_text(str(data.get("topic", "")), 200)
    count      = min(int(data.get("count", 20)), 50)
    difficulty = data.get("difficulty", "medium")
    qtypes     = data.get("types", ["mcq"])

    if not topic:
        raise HTTPException(400, "Topic is required")

    prompt = AI_EXAM_PROMPT.format(
        count=count, topic=topic, difficulty=difficulty,
        types=", ".join(qtypes)
    )

    result = gemini_once(prompt, temp=0.7, tokens=4000)
    if not result:
        raise HTTPException(503, "AI unavailable — try again")

    # Parse JSON from AI response
    try:
        # Strip markdown fences if present
        clean = re.sub(r"```json|```", "", result).strip()
        questions = json.loads(clean)
        if not isinstance(questions, list):
            raise ValueError("Not a list")
    except Exception:
        raise HTTPException(500, "AI returned invalid format — try again")

    return {"ok": True, "questions": questions, "count": len(questions)}


@app.post("/api/exam/start")
async def start_exam(data: dict, request: Request):
    """Student starts an exam — returns shuffled unique question set."""
    sid     = sanitize_text(str(data.get("sid", "")), 100)
    exam_id = sanitize_text(str(data.get("exam_id", "")), 20)
    code    = sanitize_text(str(data.get("code", "")), 10).upper()

    if not sid or not exam_id:
        raise HTTPException(400, "Missing sid or exam_id")

    # Load exam
    exams = json.loads(EXAMS_PATH.read_text()) if EXAMS_PATH.exists() else []
    exam  = next((e for e in exams if e["id"] == exam_id), None)
    if not exam:
        raise HTTPException(404, "Exam not found")

    # Check if already submitted
    results = load_exam_results()
    if any(r["sid"] == sid and r["exam_id"] == exam_id for r in results):
        raise HTTPException(409, "You have already submitted this exam")

    # Build shuffled question set for this student
    questions = exam.get("questions_full", exam.get("questions", []))
    qps       = min(exam.get("questions_per_student", 30), len(questions))

    # Shuffle and pick unique set seeded by sid for reproducibility
    import hashlib
    seed = int(hashlib.md5(f"{sid}{exam_id}".encode()).hexdigest(), 16) % (2**31)
    rng  = random.Random(seed)

    if questions and isinstance(questions[0], dict):
        selected = rng.sample(questions, min(qps, len(questions)))
        # Shuffle answer options for each question
        shuffled = []
        for q in selected:
            opts  = list(q.get("options", {}).items())
            rng.shuffle(opts)
            letter_map = {old: new for new, (old, _) in zip("ABCD", opts)}
            new_opts   = {new: val for new, (_, val) in zip("ABCD", opts)}
            new_ans    = letter_map.get(q.get("answer", "A"), "A")
            shuffled.append({**q, "options": new_opts, "answer": new_ans})
    else:
        # Legacy plain string questions
        selected  = rng.sample(questions, min(qps, len(questions)))
        shuffled  = [{"question": q, "options": {"A":"True","B":"False","C":"Maybe","D":"None"},
                      "answer":"A", "explanation":"", "type":"mcq"} for q in selected]

    # Store session
    sessions = load_exam_sessions()
    sessions[f"{sid}_{exam_id}"] = {
        "sid": sid, "exam_id": exam_id, "code": code,
        "started_at": datetime.datetime.now().isoformat(),
        "duration":   exam.get("duration", 60),
        "questions":  shuffled,
        "answers":    {},
    }
    save_exam_sessions(sessions)

    # Return questions WITHOUT answers
    safe_q = [{k: v for k, v in q.items() if k != "answer" and k != "explanation"}
              for q in shuffled]

    return {
        "ok":        True,
        "exam_id":   exam_id,
        "title":     exam.get("title", ""),
        "duration":  exam.get("duration", 60),
        "total":     len(shuffled),
        "questions": safe_q,
    }


@app.post("/api/exam/submit")
async def submit_exam(data: dict, request: Request):
    """Student submits completed exam — returns score + analysis."""
    sid     = sanitize_text(str(data.get("sid", "")), 100)
    exam_id = sanitize_text(str(data.get("exam_id", "")), 20)
    answers = data.get("answers", {})  # {question_index: "A"}

    session_key = f"{sid}_{exam_id}"
    sessions    = load_exam_sessions()
    session     = sessions.get(session_key)

    if not session:
        raise HTTPException(404, "Exam session not found — may have expired")

    questions   = session["questions"]
    correct     = 0
    breakdown   = []
    wrong_list  = []

    for i, q in enumerate(questions):
        student_ans = answers.get(str(i), "")
        is_correct  = student_ans == q.get("answer", "")
        if is_correct:
            correct += 1
        else:
            wrong_list.append({
                "question":    q.get("question", ""),
                "your_answer": student_ans,
                "correct":     q.get("answer", ""),
                "explanation": q.get("explanation", ""),
            })
        breakdown.append({
            "question":    q.get("question", ""),
            "your_answer": student_ans,
            "correct":     q.get("answer", ""),
            "is_correct":  is_correct,
            "explanation": q.get("explanation", ""),
        })

    total   = len(questions)
    score   = round((correct / total) * 100, 1) if total else 0
    grade   = "A" if score >= 70 else "B" if score >= 60 else "C" if score >= 50 else "F"
    time_taken = ""
    try:
        started = datetime.datetime.fromisoformat(session["started_at"])
        elapsed = (datetime.datetime.now() - started).seconds
        time_taken = f"{elapsed // 60}m {elapsed % 60}s"
    except: pass

    # Save result
    results = load_exam_results()
    results.append({
        "sid":        sid,
        "exam_id":    exam_id,
        "code":       session.get("code", ""),
        "score":      score,
        "correct":    correct,
        "total":      total,
        "grade":      grade,
        "time_taken": time_taken,
        "submitted_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "breakdown":  breakdown,
    })
    save_exam_results(results)

    # Clean up session
    del sessions[session_key]
    save_exam_sessions(sessions)

    return {
        "ok":        True,
        "score":     score,
        "correct":   correct,
        "total":     total,
        "grade":     grade,
        "time_taken": time_taken,
        "breakdown": breakdown,
        "wrong":     wrong_list,
    }


@app.get("/api/exam/results")
async def get_exam_results(exam_id: str, token: str):
    """Lecturer gets all results for an exam with analytics."""
    verify_lecturer(token)
    results = [r for r in load_exam_results() if r["exam_id"] == exam_id]
    if not results:
        return {"results": [], "analytics": {}}

    scores      = [r["score"] for r in results]
    avg         = round(sum(scores) / len(scores), 1)
    highest     = max(scores)
    lowest      = min(scores)
    pass_rate   = round(len([s for s in scores if s >= 50]) / len(scores) * 100, 1)

    # Find hardest questions (most wrong answers)
    wrong_counts = {}
    for r in results:
        for b in r.get("breakdown", []):
            if not b.get("is_correct"):
                q = b.get("question", "")[:80]
                wrong_counts[q] = wrong_counts.get(q, 0) + 1

    hardest = sorted(wrong_counts.items(), key=lambda x: x[1], reverse=True)[:3]

    return {
        "results": results,
        "analytics": {
            "total_submissions": len(results),
            "average_score":     avg,
            "highest_score":     highest,
            "lowest_score":      lowest,
            "pass_rate":         pass_rate,
            "hardest_questions": hardest,
            "grade_distribution": {
                "A": len([s for s in scores if s >= 70]),
                "B": len([s for s in scores if 60 <= s < 70]),
                "C": len([s for s in scores if 50 <= s < 60]),
                "F": len([s for s in scores if s < 50]),
            }
        }
    }


@app.get("/api/exam/student-results")
async def get_student_exam_results(sid: str, code: str = ""):
    """Get all exam results for a student."""
    sid     = sanitize_text(sid, 100)
    results = load_exam_results()
    student_results = [r for r in results if r["sid"] == sid]
    if code:
        student_results = [r for r in student_results if r.get("code") == code.upper()]
    return {"results": student_results}

# ── Health check ──────────────────────────────────────────────

class StudyPlanRequest(BaseModel):
    sid: str
    subject: str
    exam_date: str
    hours_per_day: int = 2

@app.post("/api/study-plan")
async def generate_study_plan(req: StudyPlanRequest, request: Request):
    key = get_client_key(request, req.sid)
    check_rate_limit(key, 5, "study_plan")

    subject = sanitize_text(req.subject, 100)
    if not subject:
        raise HTTPException(400, "Subject required.")

    today = datetime.date.today()
    try:
        exam = datetime.date.fromisoformat(req.exam_date)
    except ValueError:
        raise HTTPException(400, "Invalid date. Use YYYY-MM-DD.")

    days_left = (exam - today).days
    if days_left < 1:
        raise HTTPException(400, "Exam date must be in the future.")
    days_left = min(days_left, 14)

    hours = max(1, min(int(req.hours_per_day), 8))

    p    = load_progress(req.sid)
    weak = weak_topics(p)
    studied = list(p.get("topics", {}).keys())

    prompt = f"""You are Sivarr's study planner. Be specific, realistic and encouraging.
Student: {p.get('name', 'Student')}
Subject: {subject}
Days until exam: {days_left}
Hours per day: {hours}
Topics already studied: {', '.join(studied[:10]) or 'none yet'}
Weak topics needing focus: {', '.join(weak) or 'none identified'}

Create a {days_left}-day study plan. Prioritize weak topics early.
Reply ONLY with a valid JSON array — no markdown, no extra text:
[
  {{"day": 1, "date": "Mon 14 Apr", "focus": "Specific topic name", "tasks": ["Concrete task 1", "Concrete task 2", "Concrete task 3"], "hours": {hours}}},
  ...
]
Make tasks specific and actionable. Each day must have 2-4 tasks."""

    raw = gemini_once(prompt, temp=0.7, tokens=2000)
    if not raw:
        raise HTTPException(503, "Could not generate plan. Try again.")

    try:
        raw   = re.sub(r"```(?:json)?", "", raw).strip().rstrip("`")
        match = re.search(r'\[[\s\S]*\]', raw)
        plan  = json.loads(match.group(0) if match else raw)
    except Exception as e:
        log.error(f"Study plan parse error: {e} | raw: {raw[:200]}")
        raise HTTPException(503, "Could not parse plan. Try again.")

    log.info(f"Study plan generated: {req.sid[:20]} | {subject} | {days_left} days")
    return {"plan": plan, "days_left": days_left, "subject": subject, "exam_date": req.exam_date}

# ── Goals ─────────────────────────────────────────────────────
GOALS_PATH = DATA_DIR / "goals.json"

def load_goals(sid: str) -> list:
    p = DATA_DIR / f"{sid}_goals.json"
    return json.loads(p.read_text()) if p.exists() else []

def save_goals(sid: str, goals: list):
    p = DATA_DIR / f"{sid}_goals.json"
    save_json(p, goals)

@app.get("/api/goals")
async def get_goals(sid: str):
    sid = sanitize_text(sid, 100)
    return {"goals": load_goals(sid)}

@app.post("/api/goals/add")
async def add_goal(data: dict):
    sid     = sanitize_text(str(data.get("sid","")), 100)
    title   = sanitize_text(str(data.get("title","")), 100)
    subject = sanitize_text(str(data.get("subject","")), 100)
    target  = int(data.get("target_score", 70))
    deadline = sanitize_text(str(data.get("deadline","")), 20)
    if not title:
        raise HTTPException(400, "Goal title required.")
    goals = load_goals(sid)
    goal = {
        "id":           str(uuid.uuid4())[:8],
        "title":        title,
        "subject":      subject,
        "target_score": min(max(target, 1), 100),
        "deadline":     deadline,
        "created":      datetime.date.today().isoformat(),
        "progress":     0,
        "completed":    False,
    }
    goals.append(goal)
    save_goals(sid, goals)
    return {"goal": goal}

@app.post("/api/goals/update")
async def update_goal(data: dict):
    sid      = sanitize_text(str(data.get("sid","")), 100)
    goal_id  = sanitize_text(str(data.get("id","")), 20)
    progress = int(data.get("progress", 0))
    completed = bool(data.get("completed", False))
    goals = load_goals(sid)
    for g in goals:
        if g["id"] == goal_id:
            g["progress"]  = min(max(progress, 0), 100)
            g["completed"] = completed
            break
    save_goals(sid, goals)
    return {"ok": True}

@app.post("/api/goals/delete")
async def delete_goal(data: dict):
    sid     = sanitize_text(str(data.get("sid","")), 100)
    goal_id = sanitize_text(str(data.get("id","")), 20)
    goals   = [g for g in load_goals(sid) if g["id"] != goal_id]
    save_goals(sid, goals)
    return {"ok": True}

@app.post("/api/learning-hub/enroll")
async def enroll_course(data: dict):
    sid       = sanitize_text(str(data.get("sid", "")), 100)
    course_id = sanitize_text(str(data.get("course_id", "")), 50)
    if not sid or not course_id:
        raise HTTPException(400, "Missing fields.")
    p = load_progress(sid)
    enrolled = p.get("enrolled_courses", [])
    if course_id not in enrolled:
        enrolled.append(course_id)
        p["enrolled_courses"] = enrolled
        save_progress(sid, p)
    return {"ok": True, "enrolled": enrolled}


@app.get("/api/learning-hub/enrolled")
async def get_enrolled(sid: str):
    sid = sanitize_text(sid, 100)
    p   = load_progress(sid)
    return {"enrolled": p.get("enrolled_courses", [])}


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
