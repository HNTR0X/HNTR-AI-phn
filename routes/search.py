"""
Unified search — extracted verbatim in spirit from app.py's old
`unified_search`, but with tasks, community posts, and now (Session 16)
goals and docs backed by real Postgres full-text search (search_vector
GENERATED tsvector columns + GIN indexes, see database.py's _SCHEMA)
instead of an in-memory substring scan.

Skills, finance and journal stay on the substring scan, unchanged. They
are not per-record Postgres tables -- they're whole-list JSON blobs in
user_blobs (core.py's _load_user_list/_save_user_list), one row per user
holding an entire array, so there's no per-record column a tsvector could
attach to without a real storage migration for each of them (the exact
migration goals and docs both just went through, mirroring tasks/habits'
own earlier one). Genuinely smaller/lower-volume sources than goals/docs
per the brief that scoped this session -- left for whoever picks that up
next, rather than doing it silently as a drive-by.

Org docs and org messages ARE real per-record Postgres tables, but still
use a plain ILIKE substring match (database.py's search_org_docs/
search_org_messages) rather than a tsvector column -- adding one is a schema
migration on tables this file doesn't own, same boundary as above, just for
a different reason (real table, but out of scope to alter here).

No dedicated "calendar events" source exists to search: there is no
calendar_events table or similar (grepped for one -- none exists) and no
cached copy of a connected Google Calendar's events either. The Calendar
panel is entirely derived client-side from task due-dates and goal
deadlines (js/app.js's calRender()), both of which are already covered by
the Tasks and Goals blocks below -- adding a separate "calendar" result type
here would mean either fabricating data that doesn't exist server-side, or
silently duplicating Tasks/Goals hits under a second label. Instead, the
Tasks block's `meta` now surfaces the task's date (it used to show only
status), so a date-driven search actually shows the date without inventing
a parallel source for data that's already searchable.

Every result gets a `score` float added on top of the original response
shape ({type, icon, title, meta, id}) -- real ts_rank for tasks/posts, a
small heuristic (exact title match > startswith > contains) for the
substring-matched sources, so the combined list can be sorted by one field
instead of just concatenated blocks by source type like the old version did.
`score` is additive, not a replacement of any existing key, so the existing
frontend fields (type/icon/title/meta/id) keep working unchanged.

Pagination: `limit`/`offset` apply to the final combined, score-sorted list
across every source (not per-source), so page 2 continues where page 1 left
off regardless of which type each hit was.
"""

from fastapi import APIRouter, HTTPException

import database as db
from core import get_session_from_token, sanitize_text
from routes.tasks import load_tasks
from routes.habits import load_habits
from routes.goals import load_goals
from routes.docs_notes import load_docs
from routes.journal import load_journal

router = APIRouter()


def _substring_score(q: str, title: str) -> float:
    """Heuristic relevance for the sources that don't have a real Postgres
    rank -- lets them interleave reasonably with ts_rank-scored hits instead
    of always sorting below (or above) them as an undifferentiated block."""
    title_l = title.lower()
    if title_l == q:
        return 1.0
    if title_l.startswith(q):
        return 0.5
    return 0.1


def _task_meta(t: dict) -> str:
    status = t.get("status", "todo")
    date = t.get("date", "")
    return f"{status} · {date}" if date else status


@router.get("/api/search")
async def unified_search(q: str = "", token: str = "", limit: int = 30, offset: int = 0):
    sess = get_session_from_token(sanitize_text(token, 100)) if token else None
    if not sess:
        raise HTTPException(401, "Invalid session.")
    sid = sess["sid"]
    q   = q.strip().lower()
    if len(q) < 2:
        return {"results": [], "total": 0, "has_more": False}
    limit  = max(1, min(limit, 50))
    offset = max(0, offset)

    results = []

    # ── Tasks — real Postgres full-text search when available ──────────
    if db.is_available():
        for t in db.search_tasks(sid, q):
            results.append({
                "type":  "task",
                "icon":  "✅" if t.get("done") else "☐",
                "title": t["title"],
                "meta":  _task_meta(t),
                "id":    t.get("id", ""),
                "score": float(t.get("rank") or 0),
            })
    else:
        # JSON-fallback path -- exercised locally and in CI, where no
        # DATABASE_URL means db.is_available() is always False. Same
        # substring-scan logic the old unified_search used for tasks.
        for t in load_tasks(sid):
            if t.get("deleted_at"):
                continue
            title = t.get("title", "")
            if q in title.lower():
                results.append({
                    "type":  "task",
                    "icon":  "✅" if t.get("done") else "☐",
                    "title": title,
                    "meta":  _task_meta(t),
                    "id":    t.get("id", ""),
                    "score": _substring_score(q, title),
                })

    # ── Habits ─────────────────────────────────────────────────────────
    for h in load_habits(sid):
        if h.get("deleted_at"):
            continue
        title = h.get("title", "")
        if q in title.lower():
            streak = h.get("streak", 0)
            meta = f"{streak}-day streak" if streak else "habit"
            results.append({
                "type":  "habit",
                "icon":  h.get("emoji") or "⚡",
                "title": title,
                "meta":  meta,
                "id":    h.get("id", ""),
                "score": _substring_score(q, title),
            })

    # ── Goals — real Postgres full-text search when available ──────────
    if db.is_available():
        for g in db.search_goals(sid, q):
            results.append({
                "type":  "goal",
                "icon":  "🎯",
                "title": g["title"],
                "meta":  f'{g.get("progress", 0)}% complete',
                "id":    g.get("id", ""),
                "score": float(g.get("rank") or 0),
            })
    else:
        # JSON-fallback path -- same substring-scan logic as before this
        # session's migration, unchanged.
        for g in load_goals(sid):
            if g.get("deleted_at"):
                continue
            title = g.get("title", "")
            if q in title.lower() or q in g.get("subject", "").lower():
                results.append({
                    "type":  "goal",
                    "icon":  "🎯",
                    "title": title,
                    "meta":  f'{g.get("progress", 0)}% complete',
                    "id":    g.get("id", ""),
                    "score": _substring_score(q, title),
                })

    # ── Docs — real Postgres full-text search when available ───────────
    if db.is_available():
        for d in db.search_docs(sid, q):
            title = d.get("title", "") or "Untitled"
            content = d.get("content", "") or ""
            snippet = ""
            idx = content.lower().find(q)
            if idx >= 0:
                snippet = content[max(0, idx - 30): idx + 70].strip()
            results.append({
                "type":  "doc",
                "icon":  "📄",
                "title": title,
                "meta":  snippet or "",
                "id":    str(d.get("id", "")),
                "score": float(d.get("rank") or 0),
            })
    else:
        # JSON-fallback path -- same substring-scan logic as before this
        # session's migration, unchanged.
        for d in load_docs(sid):
            if d.get("deleted_at"):
                continue
            title   = d.get("title", "")
            content = d.get("content", "").lower()
            if q in title.lower() or q in content:
                snippet = ""
                idx = content.find(q)
                if idx >= 0:
                    snippet = d["content"][max(0, idx - 30): idx + 70].strip()
                results.append({
                    "type":  "doc",
                    "icon":  "📄",
                    "title": title or "Untitled",
                    "meta":  snippet or "",
                    "id":    str(d.get("id", "")),
                    "score": _substring_score(q, title),
                })

    # ── Journal entries ──────────────────────────────────────────────
    for e in load_journal(sid):
        text = e.get("text", "") or e.get("content", "") or e.get("entry", "")
        if q in text.lower():
            snippet = text.strip()
            idx = text.lower().find(q)
            if idx >= 0:
                snippet = text[max(0, idx - 30): idx + 70].strip()
            results.append({
                "type":  "journal",
                "icon":  "✍️",
                "title": snippet[:80] or "Journal entry",
                "meta":  e.get("date", ""),
                "id":    e.get("date", ""),  # journal has no id -- entries are one-per-date
                "score": _substring_score(q, text),
            })

    # ── Org docs / org messages — scoped to the user's own org only ────
    # Reuses routes/org.py's exact membership check (db.get_org_by_member),
    # not a new one, per this session's brief. get_org_by_member already
    # returns None for a user in no org, so this block is a no-op for them
    # -- no separate "is a member" branch needed. Postgres-only, same as
    # every other org.py route (org has no JSON-fallback storage path).
    if db.is_available():
        org = db.get_org_by_member(sid)
        if org:
            org_id = org["id"]
            for d in db.search_org_docs(org_id, q, limit=10):
                title = d.get("title", "")
                content = d.get("content", "") or ""
                meta = ""
                idx = content.lower().find(q)
                if idx >= 0:
                    meta = content[max(0, idx - 30): idx + 70].strip()
                results.append({
                    "type":  "org_doc",
                    "icon":  "📄",
                    "title": title or "Untitled",
                    "meta":  meta,
                    "id":    str(d.get("id", "")),
                    "score": _substring_score(q, title),
                })
            for m in db.search_org_messages(org_id, q, limit=10):
                content = m.get("content", "")
                results.append({
                    "type":  "org_message",
                    "icon":  "💬",
                    "title": content[:80],
                    "meta":  m.get("author_name", ""),
                    "id":    str(m.get("id", "")),
                    "score": _substring_score(q, content),
                })

    # ── Community posts — real Postgres full-text search ───────────────
    # search_community_posts previously did not exist (AttributeError,
    # silently swallowed by the try/except this block used to have) --
    # community posts have never actually appeared in search results in
    # production. Implemented for real now; the try/except is no longer
    # load-bearing for a missing function but stays as defense against any
    # unexpected DB error not surfacing as a 500 for the rest of the search.
    if db.is_available():
        try:
            for p in db.search_community_posts(q, limit=5):
                title = (p.get("body") or "")[:80]
                results.append({
                    "type":  "post",
                    "icon":  "💬",
                    "title": title,
                    "meta":  p.get("author_name", ""),
                    "id":    str(p.get("id", "")),
                    "score": float(p.get("rank") or 0),
                })
        except Exception:
            pass

    # ── Skills ───────────────────────────────────────────────────────
    if db.is_available():
        try:
            sk_blob = db.get_user_blob(sid, "skills") or {}
            for s in (sk_blob.get("skills") or []):
                name = s.get("name", "")
                cat  = s.get("category", "")
                if q in name.lower() or q in cat.lower():
                    results.append({
                        "type":  "skill",
                        "icon":  s.get("emoji", "🧠"),
                        "title": name,
                        "meta":  f'{s.get("level",0)}% · {cat}',
                        "id":    s.get("id", ""),
                        "score": _substring_score(q, name),
                    })
        except Exception:
            pass

    # ── Finance transactions ─────────────────────────────────────────
    if db.is_available():
        try:
            fin_blob = db.get_user_blob(sid, "finance") or {}
            for t in (fin_blob.get("transactions") or []):
                note = t.get("note", "")
                cat  = t.get("category", "")
                if q in note.lower() or q in cat.lower():
                    title = note or cat
                    results.append({
                        "type":  "transaction",
                        "icon":  "💰" if t.get("type") == "income" else "💸",
                        "title": title,
                        "meta":  f'₦{t.get("amount",0):,.0f} · {t.get("date","")}',
                        "id":    t.get("id", ""),
                        "score": _substring_score(q, title),
                    })
        except Exception:
            pass

    results.sort(key=lambda r: r["score"], reverse=True)
    page = results[offset: offset + limit]
    return {
        "results":  page,
        "total":    len(results),
        "has_more": offset + limit < len(results),
    }
