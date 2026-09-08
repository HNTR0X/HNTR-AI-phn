"""
Personal habits.

Same two-storage-path shape as routes/tasks.py — see that file's module
docstring for the full rationale (JSONB blob -> real Postgres table, lazy
migration on first read, db.is_available() branching). Mirrors it closely
enough that most of this file reads as a smaller version of that one.
"""

import datetime as _dt
import uuid

from fastapi import APIRouter, HTTPException

import database as db
from core import get_session_from_token, _resolve_token, sanitize_text, _load_user_list, _save_user_list

router = APIRouter()


def _s(v, maxlen: int) -> str:
    """None-safe sanitize_text — see routes/tasks.py's identical helper for
    why str(None) needs this guard."""
    return sanitize_text(str(v), maxlen) if v is not None else ""


def _int(v) -> int:
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _clean_completions(v) -> list:
    if not isinstance(v, list):
        return []
    return [sanitize_text(str(d), 12) for d in v[:400]]


_HABIT_FIELD_SANITIZERS = {
    "title":        lambda v: _s(v, 100),
    "emoji":        lambda v: _s(v, 10),
    "frequency":    lambda v: _s(v, 20) or "daily",
    "streak":       _int,
    "best_streak":  _int,
    "completions":  _clean_completions,
    # Soft delete — see routes/tasks.py's identical field.
    "deleted_at":   lambda v: _s(v, 30) or None,
}

_HABIT_DEFAULTS = {
    "title": "", "emoji": "", "frequency": "daily", "streak": 0,
    "best_streak": 0, "completions": [], "deleted_at": None,
}

# The client (js/features/habits.js) has always used "freq" for this field,
# never "frequency" — the original /api/habits/sync sanitizer only ever
# recognized "frequency", so every habit's chosen frequency (weekdays/
# weekends/weekly) was silently discarded and defaulted back to "daily" on
# every sync. Accepting the alias here, on both the bulk and per-entity
# paths, is the fix.
_CLIENT_FIELD_ALIASES = {
    "freq": "frequency",
}


def _clean_partial(fields: dict) -> dict:
    out = {}
    for k, v in fields.items():
        key = _CLIENT_FIELD_ALIASES.get(k, k)
        sanitizer = _HABIT_FIELD_SANITIZERS.get(key)
        if sanitizer:
            out[key] = sanitizer(v)
    return out


def _clean_habit(h: dict) -> dict:
    merged = {**_HABIT_DEFAULTS, **h}
    result = {"id": sanitize_text(str(h.get("id", "")), 50)}
    result.update(_clean_partial(merged))
    return result


# ── Compatibility layer — other readers use `from routes.habits import
# load_habits, save_habits` (e.g. the weekly review's streak lookup). ──────

def load_habits(sid: str) -> list:
    if not db.is_available():
        return _load_user_list(sid, "habits")
    existing = db.get_habits(sid, include_deleted=True)
    if not existing:
        legacy = _load_user_list(sid, "habits")
        if legacy:
            db.replace_all_habits(sid, [_clean_habit(h) for h in legacy])
            return db.get_habits(sid, include_deleted=True)
    return existing

def save_habits(sid: str, habits: list):
    if not db.is_available():
        _save_user_list(sid, "habits", habits)
        return
    db.replace_all_habits(sid, [_clean_habit(h) for h in habits])


@router.post("/api/habits/sync")
async def sync_habits(data: dict):
    """Bulk-sync habits from client localStorage to server. Kept as a
    full-resync fallback — live single-habit edits go through the per-entity
    endpoints below instead."""
    token = data.get("token", "")
    sess  = get_session_from_token(token)
    if not sess:
        raise HTTPException(401, "Invalid session.")
    sid    = sess["sid"]
    habits = data.get("habits", [])
    if not isinstance(habits, list):
        raise HTTPException(400, "habits must be a list.")
    clean = [_clean_habit(h) for h in habits[:200]]
    save_habits(sid, clean)
    return {"ok": True, "count": len(clean)}


@router.get("/api/habits/restore")
async def restore_habits(token: str = ""):
    sess = get_session_from_token(token)
    if not sess:
        raise HTTPException(401, "Invalid session.")
    return {"habits": [h for h in load_habits(sess["sid"]) if not h.get("deleted_at")]}


@router.get("/api/habits")
async def list_habits(token: str = ""):
    sess = get_session_from_token(token)
    if not sess:
        raise HTTPException(401, "Invalid session.")
    return {"habits": [h for h in load_habits(sess["sid"]) if not h.get("deleted_at")]}

@router.get("/api/habits/{id}")
async def get_particular_habit(id: str, token: str = ""):
    sess = get_session_from_token(token)
    if not sess:
        raise HTTPException(401, "Invalid session.")
    sid = sess["sid"]
    if db.is_available():
        habit = db.get_habit(id, sid)
    else:
        habits = load_habits(sid)
        habit = next((h for h in habits if h.get("id") == id), None)
    if not habit:
        raise HTTPException(404, "Habit not found.")
    return {"habit": habit}


@router.get("/api/habits/trash")
async def list_trashed_habits(token: str = ""):
    sess = get_session_from_token(token)
    if not sess:
        raise HTTPException(401, "Invalid session.")
    sid = sess["sid"]
    if db.is_available():
        trashed = db.get_trashed_habits(sid)
    else:
        trashed = [h for h in load_habits(sid) if h.get("deleted_at")]
    trashed.sort(key=lambda h: str(h.get("deleted_at") or ""), reverse=True)
    return {"habits": trashed}


@router.post("/api/habits/add")
async def add_habit(data: dict):
    sid, _ = _resolve_token(data)
    title = sanitize_text(str(data.get("title", "")), 100).strip()
    if not title:
        raise HTTPException(400, "Habit title required.")
    habit = _clean_habit(data)
    habit["id"] = habit["id"] or uuid.uuid4().hex[:20]
    habit["title"] = title

    if db.is_available():
        ok = db.create_habit(sid, habit["id"], title, **{k: v for k, v in habit.items() if k not in ("id", "title")})
        if not ok:
            raise HTTPException(500, "Failed to create habit.")
    else:
        habits = _load_user_list(sid, "habits")
        habits.append(habit)
        _save_user_list(sid, "habits", habits)
    return {"ok": True, "habit": habit}


@router.post("/api/habits/update")
async def update_habit_endpoint(data: dict):
    """Partial update — only the fields present in `data` are changed."""
    sid, _ = _resolve_token(data)
    habit_id = sanitize_text(str(data.get("id", "")), 50)
    if not habit_id:
        raise HTTPException(400, "Habit id required.")
    cleaned = _clean_partial({k: v for k, v in data.items() if k not in ("token", "id")})
    if not cleaned:
        return {"ok": True}

    if db.is_available():
        ok = db.update_habit(habit_id, sid, cleaned)
        if not ok:
            raise HTTPException(500, "Failed to update habit.")
    else:
        habits = _load_user_list(sid, "habits")
        current = next((h for h in habits if h.get("id") == habit_id), None)
        if not current:
            raise HTTPException(404, "Habit not found.")
        current.update(cleaned)
        _save_user_list(sid, "habits", habits)

    return {"ok": True}


@router.post("/api/habits/delete")
async def delete_habit(data: dict):
    """Soft delete — sets deleted_at instead of removing the row. Purged by
    the scheduled _purge_deleted_habits job in app.py."""
    sid, _ = _resolve_token(data)
    habit_id = sanitize_text(str(data.get("id", "")), 50)
    if not habit_id:
        raise HTTPException(400, "Habit id required.")
    if db.is_available():
        db.soft_delete_habit(habit_id, sid)
    else:
        habits = _load_user_list(sid, "habits")
        for h in habits:
            if h.get("id") == habit_id:
                h["deleted_at"] = _dt.datetime.utcnow().isoformat()
                break
        _save_user_list(sid, "habits", habits)
    return {"ok": True}


@router.post("/api/habits/undelete")
async def undelete_habit_endpoint(data: dict):
    sid, _ = _resolve_token(data)
    habit_id = sanitize_text(str(data.get("id", "")), 50)
    if not habit_id:
        raise HTTPException(400, "Habit id required.")
    if db.is_available():
        db.undelete_habit(habit_id, sid)
    else:
        habits = _load_user_list(sid, "habits")
        for h in habits:
            if h.get("id") == habit_id:
                h["deleted_at"] = None
                break
        _save_user_list(sid, "habits", habits)
    return {"ok": True}
