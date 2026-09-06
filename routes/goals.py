import datetime
import uuid

from fastapi import APIRouter, HTTPException

import database as db
from core import get_session_from_token, sanitize_text, _load_user_list, _save_user_list, _resolve_token

router = APIRouter()


# ── Personal goals — server-side mirror ────────────────────────────────────
# Session 16: goals moved from a user_blobs JSONB blob to a real `goals`
# table (see database.py's _SCHEMA), same migration tasks/habits already
# went through, so goals can get real tsvector full-text search
# (routes/search.py) instead of an in-memory substring scan. Every
# endpoint below still does its own whole-list read-modify-write via
# load_goals()/save_goals() exactly as before -- only what's underneath
# those two functions changed, so nothing else in this file needed to.
def load_goals(sid: str) -> list:
    if not db.is_available():
        return _load_user_list(sid, "goals")
    existing = db.get_goals(sid, include_deleted=True)
    if not existing:
        legacy = _load_user_list(sid, "goals")
        if legacy:
            db.replace_all_goals(sid, legacy)
            return db.get_goals(sid, include_deleted=True)
    return existing

def save_goals(sid: str, goals: list):
    if not db.is_available():
        _save_user_list(sid, "goals", goals)
        return
    db.replace_all_goals(sid, goals)


@router.get("/api/goals")
async def get_goals(sid: str = "", token: str = ""):
    # Auth is by session token only; the `sid` query param is ignored (IDOR fix).
    sess = get_session_from_token(sanitize_text(token, 100)) if token else None
    if not sess:
        raise HTTPException(401, "Invalid session.")
    # Soft-deleted goals stay in storage (see delete_goal below) but never show
    # up in the normal list — only in /api/goals/trash.
    goals = [g for g in load_goals(sess["sid"]) if not g.get("deleted_at")]
    return {"goals": goals}


@router.get("/api/goals/trash")
async def get_goals_trash(token: str = ""):
    sess = get_session_from_token(sanitize_text(token, 100)) if token else None
    if not sess:
        raise HTTPException(401, "Invalid session.")
    trashed = [g for g in load_goals(sess["sid"]) if g.get("deleted_at")]
    trashed.sort(key=lambda g: g.get("deleted_at", ""), reverse=True)
    return {"goals": trashed}


def _sanitize_milestones(raw) -> list:
    return [
        {
            "id": sanitize_text(str(m.get("id", "")), 40) or str(uuid.uuid4())[:8],
            "name": sanitize_text(str(m.get("name", "")), 200),
            "done": bool(m.get("done", False)),
        }
        for m in (raw or [])
        if isinstance(m, dict) and str(m.get("name", "")).strip()
    ][:50]


def _sanitize_habit_ids(raw) -> list:
    return [sanitize_text(str(h), 40) for h in (raw or [])][:50]


def _calc_milestone_progress(mode: str, milestones: list, manual_pct, pct_override) -> int:
    """Mirrors js/features/habits.js's _goalPct() exactly -- keep both in
    sync if the percentage rules ever change. Computed server-side too (not
    just in the panel's own render) so any other surface reading a goal's
    plain `progress` int (e.g. the Home dashboard's goal-progress card)
    sees an accurate value for goals made in the newer milestone-driven
    Goals & Habits panel, not just whatever the panel itself displays."""
    total = len(milestones)
    done = sum(1 for m in milestones if m.get("done"))
    milestone_pct = round((done / total) * 100) if total else None
    if mode == "manual":
        return max(0, min(100, int(manual_pct or 0)))
    if mode == "hybrid" and pct_override is not None:
        return max(0, min(100, int(pct_override)))
    return milestone_pct if milestone_pct is not None else 0


@router.post("/api/goals/add")
async def add_goal(data: dict):
    sid, _    = _resolve_token(data)
    title     = sanitize_text(str(data.get("title","")), 100)
    subject   = sanitize_text(str(data.get("subject","")), 100)
    target    = int(data.get("target_score", 70))
    # `due` is the newer Goals & Habits panel's field name; `deadline` is the
    # older one. Mirror onto both columns so either reader sees the value.
    deadline  = sanitize_text(str(data.get("deadline","") or data.get("due","")), 20)
    goal_type = sanitize_text(str(data.get("goal_type", "okr")), 20)
    if goal_type not in ("okr", "score"):
        goal_type = "okr"
    if not title:
        raise HTTPException(400, "Goal title required.")

    mode = sanitize_text(str(data.get("mode", "milestone")), 20)
    if mode not in ("milestone", "manual", "hybrid"):
        mode = "milestone"
    manual_pct = max(0, min(100, int(data.get("manual_pct", 0) or 0)))
    pct_override_raw = data.get("pct_override")
    pct_override = max(0, min(100, int(pct_override_raw))) if pct_override_raw is not None else None
    milestones = _sanitize_milestones(data.get("milestones"))
    habit_ids = _sanitize_habit_ids(data.get("habit_ids"))

    goals = load_goals(sid)
    goal = {
        "id":           str(uuid.uuid4())[:8],
        "title":        title,
        "subject":      subject,
        "target_score": min(max(target, 1), 100),
        "deadline":     deadline,
        "due":          deadline,
        "created":      datetime.date.today().isoformat(),
        "goal_type":    goal_type,
        "mode":         mode,
        "manual_pct":   manual_pct,
        "pct_override": pct_override,
        "milestones":   milestones,
        "habit_ids":    habit_ids,
    }
    goal["progress"] = _calc_milestone_progress(mode, milestones, manual_pct, pct_override)
    goal["completed"] = goal["progress"] >= 100
    goals.append(goal)
    save_goals(sid, goals)
    return {"goal": goal}


@router.post("/api/goals/update")
async def update_goal(data: dict):
    sid, _   = _resolve_token(data)
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


@router.post("/api/goals/delete")
async def delete_goal(data: dict):
    """Soft delete — marks the goal deleted_at instead of removing it, so it
    can be recovered from Trash for 30 days. Actually purged by the
    _purge_deleted_goals background job in app.py."""
    sid, _  = _resolve_token(data)
    goal_id = sanitize_text(str(data.get("id","")), 20)
    goals   = load_goals(sid)
    for g in goals:
        if g["id"] == goal_id:
            g["deleted_at"] = datetime.datetime.utcnow().isoformat()
            break
    save_goals(sid, goals)
    return {"ok": True}


@router.post("/api/goals/restore")
async def restore_goal(data: dict):
    sid, _  = _resolve_token(data)
    goal_id = sanitize_text(str(data.get("id","")), 20)
    goals   = load_goals(sid)
    for g in goals:
        if g["id"] == goal_id:
            g["deleted_at"] = None
            break
    save_goals(sid, goals)
    return {"ok": True}


@router.post("/api/goals/edit")
async def edit_goal(data: dict):
    sid, _  = _resolve_token(data)
    goal_id = sanitize_text(str(data.get("id","")), 20)
    goals   = load_goals(sid)
    for g in goals:
        if g["id"] == goal_id:
            if data.get("title"):
                g["title"] = sanitize_text(str(data["title"]), 200)
            if "subject" in data:
                g["subject"] = sanitize_text(str(data.get("subject", "")), 100)
            if "deadline" in data or "due" in data:
                dl = data.get("deadline") or data.get("due") or None
                val = sanitize_text(str(dl), 20) if dl else None
                g["deadline"] = val
                g["due"] = val
            if "mode" in data:
                m = sanitize_text(str(data.get("mode", "milestone")), 20)
                g["mode"] = m if m in ("milestone", "manual", "hybrid") else "milestone"
            if "manual_pct" in data:
                g["manual_pct"] = max(0, min(100, int(data.get("manual_pct") or 0)))
            if "pct_override" in data:
                po = data.get("pct_override")
                g["pct_override"] = max(0, min(100, int(po))) if po is not None else None
            if "milestones" in data:
                g["milestones"] = _sanitize_milestones(data.get("milestones"))
            if "habit_ids" in data:
                g["habit_ids"] = _sanitize_habit_ids(data.get("habit_ids"))
            if any(k in data for k in ("mode", "manual_pct", "pct_override", "milestones")):
                g["progress"] = _calc_milestone_progress(
                    g.get("mode", "milestone"), g.get("milestones", []),
                    g.get("manual_pct", 0), g.get("pct_override"),
                )
                g["completed"] = g["progress"] >= 100
            break
    save_goals(sid, goals)
    return {"ok": True}


def _calc_goal_progress(g: dict) -> int:
    krs = g.get("key_results", [])
    if not krs:
        return g.get("progress", 0)
    pcts = [min(100.0, (kr["current"] / max(0.01, kr["target"])) * 100) for kr in krs]
    return round(sum(pcts) / len(krs))


@router.post("/api/goals/kr/add")
async def add_goal_kr(data: dict):
    sid, _  = _resolve_token(data)
    goal_id = sanitize_text(str(data.get("goal_id","")), 20)
    title   = sanitize_text(str(data.get("title","")), 200)
    target  = float(data.get("target", 100))
    current = float(data.get("current", 0))
    unit    = sanitize_text(str(data.get("unit","")), 50)
    if not title:
        raise HTTPException(400, "KR title required.")
    goals = load_goals(sid)
    for g in goals:
        if g["id"] == goal_id:
            kr = {"id": str(uuid.uuid4())[:8], "title": title,
                  "target": max(0.1, target), "current": max(0.0, current), "unit": unit}
            g.setdefault("key_results", []).append(kr)
            g["progress"] = _calc_goal_progress(g)
            break
    save_goals(sid, goals)
    return {"ok": True}


@router.post("/api/goals/kr/update")
async def update_goal_kr(data: dict):
    sid, _  = _resolve_token(data)
    goal_id = sanitize_text(str(data.get("goal_id","")), 20)
    kr_id   = sanitize_text(str(data.get("kr_id","")), 20)
    current = float(data.get("current", 0))
    goals   = load_goals(sid)
    for g in goals:
        if g["id"] == goal_id:
            for kr in g.get("key_results", []):
                if kr["id"] == kr_id:
                    kr["current"] = max(0.0, current)
                    break
            g["progress"] = _calc_goal_progress(g)
            if g["progress"] >= 100:
                g["completed"] = True
            break
    save_goals(sid, goals)
    return {"ok": True}


@router.post("/api/goals/kr/delete")
async def delete_goal_kr(data: dict):
    sid, _  = _resolve_token(data)
    goal_id = sanitize_text(str(data.get("goal_id","")), 20)
    kr_id   = sanitize_text(str(data.get("kr_id","")), 20)
    goals   = load_goals(sid)
    for g in goals:
        if g["id"] == goal_id:
            g["key_results"] = [kr for kr in g.get("key_results", []) if kr["id"] != kr_id]
            g["progress"] = _calc_goal_progress(g)
            break
    save_goals(sid, goals)
    return {"ok": True}


@router.post("/api/import/goals")
async def import_goals(data: dict):
    token = data.get("token", "")
    sess  = get_session_from_token(token)
    if not sess:
        raise HTTPException(401, "Invalid session.")
    sid  = sess["sid"]
    rows = data.get("goals", [])
    if not isinstance(rows, list):
        raise HTTPException(400, "goals must be a list.")
    existing = load_goals(sid)
    imported = []
    for r in rows[:200]:
        title = sanitize_text(str(r.get("title", "")), 100).strip()
        if not title:
            continue
        try:
            target = min(max(int(float(r.get("target_score", 70))), 1), 100)
        except (ValueError, TypeError):
            target = 70
        imported.append({
            "id":           str(uuid.uuid4())[:8],
            "title":        title,
            "subject":      sanitize_text(str(r.get("subject", "")), 100),
            "target_score": target,
            "deadline":     sanitize_text(str(r.get("deadline", "")), 20),
            "created":      datetime.date.today().isoformat(),
            "progress":     0,
            "completed":    str(r.get("completed", "")).lower() in ("yes", "true", "1"),
        })
    save_goals(sid, existing + imported)
    return {"ok": True, "imported": len(imported)}
