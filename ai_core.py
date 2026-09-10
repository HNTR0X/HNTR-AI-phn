"""
Shared AI/Gemini infrastructure used by routes/ai_chat.py and (in a later pass)
the quiz, weekly-review, Home-brief and writing-assistant routers.

WHY THIS FILE EXISTS
---------------------
Everything here used to live inline in app.py, entangled with billing (which
stays in app.py deliberately — see below) only by coincidence of file
location, not by any real dependency. Splitting it out means an AI-domain
router can be read and understood without loading the rest of app.py, the
same reasoning core.py was built on. Depends only on core.py + database.py +
stdlib + the Gemini SDK, never on app.py. database.py was added in Session 13
for build_retrieval_context() below — safe because database.py itself has no
dependency back on ai_core.py or app.py, so this stays one-directional.

WHAT DELIBERATELY STAYED IN app.py
-----------------------------------
_chat_authorize() and _ai_meter() (per-plan daily AI usage gating) are NOT
here, because they call load_progress()/save_progress()/_plan_caps() —
app.py's central user-state accessor (60+ call sites app-wide: billing,
admin, academic, everything) and its billing plan-tier table. Moving those
would be a billing-domain extraction, not an AI one, and touches code this
pass has no business touching. routes/ai_chat.py takes them as constructor
arguments instead (see build_router() there) — a real, explicit dependency
on billing-gated access rather than a hidden one.
"""

import ast
import asyncio
import datetime
import json
import logging
import os
import re
import time

from core import DATA_DIR, VERSION
import database as db

try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False

try:
    import sentry_sdk
    SENTRY_SDK_AVAILABLE = True
except ImportError:
    SENTRY_SDK_AVAILABLE = False

log = logging.getLogger("sivarr")


# ═══════════════════════════════════════════════════════════════
#  MODEL CONFIG & PROMPTS
# ═══════════════════════════════════════════════════════════════

GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-flash-latest",
    "gemini-pro-latest",
    "gemini-2.5-flash-lite",
]

# Embedding model for AI retrieval (Session 9/10). The older embedding-001 /
# text-embedding-004 models this key's project would default to aren't
# available for embedContent on this account (checked live via
# genai.list_models()) -- gemini-embedding-001 is. It natively returns 3072
# dims; output_dimensionality truncates it (Matryoshka-style, verified live)
# to EMBED_DIM, which must match the `embedding VECTOR(768)` column in
# database.py's schema -- changing one without the other breaks every insert.
EMBED_MODEL = "models/gemini-embedding-001"
EMBED_DIM = 768


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

SYSTEM_PROMPT = f"""You are Sivarr, a brilliant, context-aware AI built into the Sivarr platform.
You are not a generic assistant. You live inside the user's personal workspace and know their tasks, goals, habits, journal, and progress.
Sivarr was founded by a Lead City University student. Mission: student to skilled professional to employed talent to career growth. Version: {VERSION}

Personality:
- Warm, direct, and energetic, like the smartest friend in the room, not a textbook.
- Reference the user's actual data naturally when it's relevant (e.g. "Since you have 3 overdue tasks today...").
- Celebrate wins. Call out patterns. Be proactive, not just reactive.

Rules:
1. Keep answers SHORT: 2 to 4 sentences by default. Expand only when asked.
2. Show step-by-step working ONLY when explicitly requested.
3. Answer ANY question: academics, career, life, creativity, strategy.
4. For math: state the final answer only unless asked for working.
5. If unsure, say so. Never confidently guess wrong.
6. Format cleanly. Use line breaks for readability when helpful.
7. When user context is provided at the start of a message, use it to personalise your response naturally. Do NOT echo it back verbatim.
8. Address the user by their first name occasionally for warmth.
9. Never use em dashes (—) or en dashes used as punctuation. Use commas, periods, or parentheses instead. Write like a real person texting a friend, not like an AI essay.
"""


MATH_PROMPT = """You are Sivarr's math expert.
1. State the final answer clearly and concisely.
2. Do NOT show steps unless asked.
3. One line is enough for simple problems e.g. x = 5.
4. Be casual.
5. If unsure, say so.
6. Never use em dashes. Use commas or periods instead.
"""


# ═══════════════════════════════════════════════════════════════
#  GEMINI SESSION CACHE
# ═══════════════════════════════════════════════════════════════

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()

_model_name = None
_chat_sessions: dict = {}          # sid → {chat, math, last_used}

CHAT_SESSION_TTL  = 4 * 3600      # evict idle AI sessions after 4 hours

def _evict_stale_chat_sessions():
    cutoff = time.time() - CHAT_SESSION_TTL
    stale  = [k for k, v in _chat_sessions.items() if v.get("last_used", 0) < cutoff]
    for k in stale:
        del _chat_sessions[k]
    if stale:
        log.info(f"Evicted {len(stale)} stale AI chat sessions")

def forget_sid(sid: str) -> None:
    """Evict this sid's live Gemini session (both 'chat' and 'math' sub-sessions)
    from this worker's cache, so the model genuinely stops remembering the
    conversation instead of just having its visible history cleared. Same
    unguarded dict.pop pattern as core.py's delete_session_token — this dict has
    no lock anywhere else either, and per-worker eviction is the same tradeoff
    session revocation already accepts (see core.py's own comment there)."""
    _chat_sessions.pop(sid, None)

def _alert_model_fallback(chosen: str, reason: str) -> None:
    """Every margin figure anywhere in this codebase assumes GEMINI_MODELS[0]
    (flash) is what's actually running. Landing on anything else is silently
    ~4x the per-token cost of flash, and get_model() caches its result for
    the rest of the process's life -- a transient blip at boot (e.g. flash
    briefly missing from list_models()) would otherwise pin the expensive
    model for the whole process with nothing surfacing it anywhere. This is
    the alert that was missing."""
    msg = f"Gemini model fallback: using {chosen!r} instead of {GEMINI_MODELS[0]!r} ({reason})"
    log.error(msg)
    if SENTRY_SDK_AVAILABLE:
        try:
            sentry_sdk.capture_message(msg, level="error")
        except Exception:
            pass  # never let alerting itself take down model selection


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
                if m == GEMINI_MODELS[0]:
                    log.info(f"Gemini model selected: {m}")
                else:
                    _alert_model_fallback(m, f"{GEMINI_MODELS[0]!r} unavailable on this key")
                return m
        _model_name = available[0] if available else GEMINI_MODELS[0]
        _alert_model_fallback(_model_name, "none of GEMINI_MODELS are available")
    except Exception as e:
        log.error(f"Gemini model selection failed: {e}")
        _model_name = GEMINI_MODELS[0]
    return _model_name


def get_sessions(sid, memory=""):
    if len(_chat_sessions) > 500:
        _evict_stale_chat_sessions()
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
        _chat_sessions[sid] = {"chat": mk(system), "math": mk(MATH_PROMPT), "last_used": time.time()}
        log.info(f"New chat session created for: {sid}")
    else:
        _chat_sessions[sid]["last_used"] = time.time()
    return _chat_sessions[sid]


# ═══════════════════════════════════════════════════════════════
#  GEMINI CALL WRAPPERS
# ═══════════════════════════════════════════════════════════════

def friendly_gemini_error(e):
    """Convert raw Gemini exceptions into short readable messages."""
    msg = str(e).lower()
    if "quota" in msg or "429" in msg or "resource_exhausted" in msg:
        return "Sivarr is taking a short break (free tier quota reached). Please wait a minute and try again! ⏳"
    if "api key" in msg or "invalid" in msg or "401" in msg or "403" in msg:
        return "API key issue. Please contact support."
    if "network" in msg or "connection" in msg or "timeout" in msg or "unavailable" in msg:
        return "Connection issue. Check your internet and try again."
    if "404" in msg or "not found" in msg:
        return "AI model unavailable. Try again in a moment."
    return "Something went wrong. Please try again shortly."

_AI_ERROR_PREFIXES = (
    "Sivarr is taking a short break",
    "API key issue",
    "Connection issue",
    "AI model unavailable",
    "Something went wrong",
)

def _is_ai_error(text: str) -> bool:
    return any(text.startswith(p) for p in _AI_ERROR_PREFIXES)


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
        # Quota/429 is an expected, already-handled condition on the free
        # tier (every caller falls back gracefully when this returns None,
        # e.g. home_brief's generic greeting) — kept at warning so it stops
        # cluttering Sentry's error feed. Every other failure (bad API key,
        # outage, etc.) stays at error since those genuinely need attention.
        # Same detection `friendly_gemini_error()` already uses below.
        msg = str(e).lower()
        if "quota" in msg or "429" in msg or "resource_exhausted" in msg:
            log.warning(f"Gemini once error: {e}")
        else:
            log.error(f"Gemini once error: {e}")
        return None


# ── AI circuit breaker ────────────────────────────────────────────────────────
# Per-worker breaker: after repeated Gemini failures (outage / quota wall), stop
# hammering the API for a short cooldown so failing calls don't tie up worker
# threads and cascade into slow requests for everyone. In-memory per worker is
# fine — each worker protects its own thread pool. All AI flows through the two
# wrappers below, so this covers every endpoint at once.
_AI_BREAKER = {"fails": 0, "open_until": 0.0}
_AI_BREAK_THRESHOLD = int(os.environ.get("AI_BREAK_THRESHOLD", 8))   # consecutive fails to trip
_AI_BREAK_COOLDOWN  = int(os.environ.get("AI_BREAK_COOLDOWN", 30))   # seconds to stay open


def _ai_breaker_open() -> bool:
    return time.time() < _AI_BREAKER["open_until"]


def _ai_breaker_record(ok: bool) -> None:
    if ok:
        _AI_BREAKER["fails"] = 0
        return
    _AI_BREAKER["fails"] += 1
    if _AI_BREAKER["fails"] >= _AI_BREAK_THRESHOLD:
        _AI_BREAKER["open_until"] = time.time() + _AI_BREAK_COOLDOWN
        _AI_BREAKER["fails"] = 0
        log.error(f"AI circuit breaker OPEN for {_AI_BREAK_COOLDOWN}s after repeated Gemini failures")


async def async_gemini_once(prompt, temp=0.8, tokens=600):
    """Non-blocking wrapper — runs gemini_once in a thread so the event loop stays free."""
    if _ai_breaker_open():
        return None
    result = await asyncio.to_thread(gemini_once, prompt, temp, tokens)
    _ai_breaker_record(result is not None)
    return result


async def async_gemini_ask(session, question):
    """Non-blocking wrapper — runs gemini_ask in a thread so the event loop stays free."""
    if _ai_breaker_open():
        return friendly_gemini_error(Exception("AI temporarily unavailable — please retry shortly."))
    answer = await asyncio.to_thread(gemini_ask, session, question)
    _ai_breaker_record(not _is_ai_error(answer))
    return answer


# ═══════════════════════════════════════════════════════════════
#  EMBEDDINGS — AI retrieval (Session 9: indexing; Session 10: query side)
# ═══════════════════════════════════════════════════════════════

def embed_text(text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> list | None:
    """Returns an EMBED_DIM-length float vector, or None on any failure
    (no key, SDK missing, empty text, quota, outage) — every caller treats
    None as "skip this item," never as an exception to handle. Use
    task_type="RETRIEVAL_DOCUMENT" when indexing content and
    "RETRIEVAL_QUERY" when embedding a user's chat message to search
    against it — Gemini's retrieval models are asymmetric, trained
    differently for the two sides of that pair."""
    if not API_KEY or not GEMINI_AVAILABLE or not text or not text.strip():
        return None
    try:
        genai.configure(api_key=API_KEY)
        r = genai.embed_content(
            model=EMBED_MODEL,
            content=text[:8000],  # embedContent has a request size limit; chunk_text is already short
            task_type=task_type,
            output_dimensionality=EMBED_DIM,
        )
        return r["embedding"]
    except Exception as e:
        msg = str(e).lower()
        if "quota" in msg or "429" in msg or "resource_exhausted" in msg:
            log.warning(f"Gemini embed error: {e}")
        else:
            log.error(f"Gemini embed error: {e}")
        return None


async def async_embed_text(text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> list | None:
    """Non-blocking wrapper — same breaker-gated shape as async_gemini_once."""
    if _ai_breaker_open():
        return None
    result = await asyncio.to_thread(embed_text, text, task_type)
    _ai_breaker_record(result is not None)
    return result


RETRIEVAL_TOP_K = int(os.environ.get("RETRIEVAL_TOP_K", 5))


async def build_retrieval_context(sid: str, query: str, k: int = RETRIEVAL_TOP_K) -> str:
    """Embed `query` and retrieve up to k of THIS sid's own indexed workspace
    items (tasks/goals/docs/journal — see app.py's _index_embeddings) to
    ground the next Gemini call. Returns "" — never raises — when pgvector
    isn't available, embedding fails, or nothing relevant turns up; routes/
    ai_chat.py treats an empty string as "nothing to inject," so a chat
    message must work identically with retrieval on or entirely absent.

    Always scoped by sid, with no code path here that isn't: the caller
    passes in whatever sid its own auth already resolved (chat_authorize()
    in app.py) — this function has no way to see or use anything else, by
    construction, not by a check it could get wrong.
    """
    try:
        if not db.embeddings_available():
            return ""
        query_vec = await async_embed_text(query, task_type="RETRIEVAL_QUERY")
        if not query_vec:
            return ""
        results = db.search_embeddings(sid, query_vec, limit=k)
        if not results:
            return ""
        lines = [
            f"[{r['source_type']}:{r['source_id']}] {r['chunk_text'][:300]}"
            for r in results
        ]
        return (
            "Relevant items from the user's own workspace — use them only if "
            "actually relevant to the question below, and when you do, cite "
            "the item inline with its bracketed tag exactly as shown (e.g. "
            "[task:abc123]):\n" + "\n".join(lines)
        )
    except Exception as e:
        log.warning(f"build_retrieval_context failed, continuing without it: {e}")
        return ""


# ═══════════════════════════════════════════════════════════════
#  LOCAL MATH SOLVER
# ═══════════════════════════════════════════════════════════════

def _safe_eval_node(node):
    """Recursive arithmetic evaluator — no eval() call, only safe AST nodes."""
    if isinstance(node, ast.Expression):
        return _safe_eval_node(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        v = _safe_eval_node(node.operand)
        return -v if isinstance(node.op, ast.USub) else v
    if isinstance(node, ast.BinOp):
        left  = _safe_eval_node(node.left)
        right = _safe_eval_node(node.right)
        if isinstance(node.op, ast.Add):  return left + right
        if isinstance(node.op, ast.Sub):  return left - right
        if isinstance(node.op, ast.Mult): return left * right
        if isinstance(node.op, ast.Div):
            if right == 0: raise ZeroDivisionError
            return left / right
        if isinstance(node.op, ast.Pow):
            if abs(right) > 100: raise ValueError("exponent too large")
            return left ** right
    raise ValueError(f"unsafe node: {type(node).__name__}")


def solve_local(text):
    if not re.fullmatch(r"[\d+\-*/().^ \s]+", text.strip()):
        return None
    for c in [text] + re.findall(r"[\d+\-*/().^ ]+", text):
        try:
            tree = ast.parse(c.strip(), mode="eval")
            r = _safe_eval_node(tree)
            display = int(r) if isinstance(r, float) and r.is_integer() else round(r, 6)
            return f"Result = {display}"
        except Exception:
            continue
    return None


def is_math(text):
    return any(t in text.lower() for t in MATH_TRIGGERS)


def is_uncertain(text):
    return any(p in text.lower() for p in UNCERTAINTY_PHRASES)


# ═══════════════════════════════════════════════════════════════
#  TOPIC ANSWER CACHE
# ═══════════════════════════════════════════════════════════════

def lpath():     return DATA_DIR / "library.json"
def bpath():     return DATA_DIR / "bank.json"


def load_json(p):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


CACHE_EXPIRY  = 30

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


