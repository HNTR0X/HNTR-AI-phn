"""
Org space — multi-user organisation workspace (create/join, members, tasks,
projects, docs, chat (SSE), presence, goals/OKRs, founder mode, AI briefing,
announcements, analytics, Paystack payouts dashboard).

WHY build_router() IS A FACTORY, NOT A BARE ROUTER
-----------------------------------------------------
Same reasoning as routes/ai_chat.py (see that file's module docstring for the
full rationale). A handful of these routes call load_progress() (app.py's
central per-user state accessor), send_email()/send_push() (transactional
email/web-push senders, themselves dependent on app.py-resident provider
config), and _is_valid_admin_session() (the general admin-session check used
26+ places across app.py, not org-specific) — all genuinely app.py-resident,
not org-domain, so they're taken as constructor arguments instead of
imported directly. app.py calls build_router(...) once those four are
defined (send_push in particular is defined very late in app.py, so this
include_router() call sits near the end of the file) and include_router()s
the result.

Everything else below build_router() is a pure helper (only touches `db`,
stdlib, or the conditionally-imported `httpx`) and lives at module level —
no injected dependency needed, and it keeps the diff against the original
app.py code close to a straight relocation.

DATA LAYER
----------
Org data lives in 12 dedicated Postgres tables (orgs, org_members,
org_invites, org_tasks, org_projects, org_docs, org_messages, org_goals,
org_key_results, org_founder, org_announcements, org_integrations) — see
database.py. orgs.settings is a JSONB sub-blob for subscription/seat-plan
state within that row. The org audit log rides on the generic `collections`
table (owner=org_id), not its own table.

/api/org/chat/stream is a real, already-shipped Server-Sent-Events endpoint
that polls Postgres every 2s (not WebSockets) — deliberately, so it survives
a multi-worker deployment (every Gunicorn worker sees the same feed via the
DB rather than an in-process pubsub). It predates and is unrelated to the
WebSocket presence work below.

WEBSOCKET PRESENCE (added after the extraction above, same file)
------------------------------------------------------------------
/api/org/presence/ws is a real WebSocket endpoint — the "later phase"
realtime work the decomposition brief referred to, now built. Postgres
(db.upsert_presence/get_presence, the same functions the polling
GET/POST /api/org/presence endpoints already use) stays the single source
of truth for "who's online" — a WS client's initial snapshot and every
heartbeat still read/write there, so a client that falls back to polling
(WebSocket unsupported, blocked by a proxy, etc.) sees a consistent picture.
Redis is used ONLY as a pub/sub message bus so a join/leave on one Gunicorn
worker reaches WebSocket clients connected to the other 3 instantly, instead
of waiting for their next 30s poll — it holds no presence state of its own.
Degrades gracefully exactly like rcache.py: if REDIS_URL isn't set, or the
connection fails, WS presence still works for clients on the SAME worker
(the common case for a small-team org) but cross-worker instant delivery is
lost; the existing 30s poll (unaffected, still running) is what covers that
gap either way, so there is no path where presence silently stops updating.
"""

import asyncio
import datetime
import hmac
import html
import json
import logging
import os
import secrets
import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, RedirectResponse

import database as db
from ai_core import get_sessions, async_gemini_ask
from core import get_session_from_token, sanitize_text, _resolve_token, get_client_key, check_rate_limit

log = logging.getLogger("sivarr")

# Optional async Redis client for presence pub/sub only — separate from
# rcache.py's sync client (used for fast rate-limit/cache round-trips), since
# a pub/sub listen() loop is long-lived and would block an event loop if it
# weren't genuinely async. Same env var, same graceful-degrade posture: if
# redis isn't importable or REDIS_URL isn't set, presence just runs without
# cross-worker fan-out (see module docstring).
try:
    import redis.asyncio as _aioredis
except ImportError:
    _aioredis = None

_REDIS_URL = os.environ.get("REDIS_URL", "").strip()

# Per-worker state: which local WebSocket connections care about which org's
# presence channel, and the lazily-started background task that fans Redis
# pub/sub messages out to them. Module-level (not inside build_router) since
# build_router() only runs once per worker process anyway, but this makes
# the singleton-per-worker intent explicit regardless of where it's read from.
_PRESENCE_LOCAL: dict[str, set] = {}
# Same shape, keyed by doc_id instead of org_id — one org-wide "live" socket
# (_PRESENCE_LOCAL, presence + task sync) plus a separate per-document socket
# opened only while that doc is actually being edited (live co-editing, see
# org_doc_ws below). Kept as two registries rather than merging doc rooms
# into _PRESENCE_LOCAL under a prefixed key: org_ids and doc_ids are both
# opaque hex strings from the same uuid4().hex[:20] generator, so sharing one
# dict without prefixing would risk an (astronomically unlikely, but free to
# just avoid) key collision between an org and an unrelated document.
_DOC_LOCAL: dict[str, set] = {}
_presence_redis = None
_presence_redis_tried = False
_presence_sub_task = None
_presence_lock = asyncio.Lock()


async def _get_presence_redis():
    """Lazy singleton — one async Redis connection per worker, used for quick
    request/response calls (publish, ping). A short socket_timeout is
    correct here: a publish should never hang. Returns None (permanently,
    for this worker's lifetime) if Redis isn't configured or a first
    connection attempt fails."""
    global _presence_redis, _presence_redis_tried
    if _presence_redis is not None:
        return _presence_redis
    if _presence_redis_tried or not _REDIS_URL or not _aioredis:
        return None
    _presence_redis_tried = True
    try:
        client = _aioredis.from_url(
            _REDIS_URL, decode_responses=True,
            socket_connect_timeout=3, socket_timeout=3,
        )
        await client.ping()
        _presence_redis = client
        log.info("Org presence: Redis pub/sub ready")
    except Exception as exc:
        log.warning(f"Org presence: Redis unavailable, falling back to same-worker-only ({exc})")
    return _presence_redis


async def _get_presence_sub_redis():
    """Separate connection, used only by the long-lived subscriber loop.
    Deliberately no socket_timeout: pubsub.listen() blocks waiting for the
    *next* message, which can legitimately be much longer than any short
    request/response timeout — sharing _get_presence_redis()'s 3s timeout
    here silently killed the listener on any quiet gap over 3 seconds (a
    real bug, found via a live test with normal pauses between edits, not
    by inspection — the earlier presence/task-sync tests happened to always
    have back-to-back traffic dense enough to never hit it)."""
    if not _REDIS_URL or not _aioredis:
        return None
    try:
        client = _aioredis.from_url(
            _REDIS_URL, decode_responses=True,
            socket_connect_timeout=3, socket_timeout=None,
        )
        await client.ping()
        return client
    except Exception as exc:
        log.warning(f"Org presence: subscriber Redis connection failed ({exc})")
        return None


async def _fanout_local(registry: dict, key: str, payload: str):
    """Send a payload to this worker's own locally-connected WebSockets
    registered under `key` in `registry` — the one fan-out code path, used
    both by the Redis subscriber loop (every worker, including the
    publisher, receives its own message back through psubscribe) and
    directly by _publish_org_event when Redis isn't available at all."""
    conns = registry.get(key)
    if not conns:
        return
    dead = []
    for ws in conns:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        conns.discard(ws)


async def _fanout_presence_local(org_id: str, payload: str):
    await _fanout_local(_PRESENCE_LOCAL, org_id, payload)


async def _fanout_doc_local(doc_id: str, payload: str):
    await _fanout_local(_DOC_LOCAL, doc_id, payload)


async def _presence_subscriber_loop():
    """One long-lived task per worker: listens to every org's live channels
    (presence join/leave, live task sync, and — Week 3-4 — live document
    co-editing) and fans each message out to the matching local registry. A
    single psubscribe across all three prefixes rather than per-room
    subscribe/unsubscribe management — org live traffic is tiny, and this
    avoids a whole class of subscribe-lifecycle bugs for a cheap fan-out.
    presence/org_tasks share _PRESENCE_LOCAL (one org-wide socket carries
    both); org_doc has its own _DOC_LOCAL, opened only while a document is
    actually being edited.

    Self-healing: any exception (a dropped Redis connection, a transient
    timeout) reconnects and resubscribes after a short pause instead of
    exiting for good — a WS route only re-triggers _ensure_presence_
    subscriber() on a *new* connection, so a loop that just died on its own
    would silently stop delivering live updates to every already-open
    connection for the rest of the worker's life until someone happened to
    open a new one. Found this the hard way: a real Redis client, reused
    from _get_presence_redis(), has a socket_timeout meant for quick
    publish/ping calls — sharing it here killed the listener on any gap
    between messages longer than that timeout, which a live two-browser
    test with normal pauses between edits hit immediately even though the
    earlier presence/task-sync tests (denser traffic) never did. Fixed by
    giving the listener its own connection with no read timeout, but kept
    this retry loop regardless — a listener with no self-healing is a bug
    waiting to resurface for some other transient reason."""
    while True:
        client = await _get_presence_sub_redis()
        if not client:
            await asyncio.sleep(5)
            continue
        try:
            pubsub = client.pubsub()
            await pubsub.psubscribe("presence:*", "org_tasks:*", "org_doc:*")
            async for message in pubsub.listen():
                if message.get("type") != "pmessage":
                    continue
                channel = message.get("channel", "")
                if ":" not in channel:
                    continue
                prefix, key = channel.split(":", 1)
                if prefix == "org_doc":
                    await _fanout_doc_local(key, message["data"])
                else:
                    await _fanout_presence_local(key, message["data"])
        except Exception as exc:
            log.warning(f"Org presence: subscriber loop dropped, reconnecting ({exc})")
            await asyncio.sleep(2)


async def _ensure_presence_subscriber():
    """Starts the fan-out task at most once per worker. Cheap upfront check
    via _get_presence_redis() (which caches "Redis unavailable" permanently
    per worker) so a worker with no REDIS_URL configured doesn't spin up a
    task that would just sleep-and-retry forever for nothing."""
    global _presence_sub_task
    if _presence_sub_task is not None and not _presence_sub_task.done():
        return
    if not await _get_presence_redis():
        return
    async with _presence_lock:
        if _presence_sub_task is not None and not _presence_sub_task.done():
            return
        _presence_sub_task = asyncio.create_task(_presence_subscriber_loop())


async def _publish_org_event(channel_prefix: str, key: str, event: dict):
    """Broadcast an event on `{channel_prefix}:{key}` — shared by presence
    (join/leave), live task sync (create/update/delete), and live doc
    co-editing, see _presence_subscriber_loop's docstring for the registry
    each rides. Publishes to Redis when available — every worker's
    subscriber loop (including this one) fans it out to its own local
    connections from there. Without Redis (unset, or a publish failure),
    falls straight back to a direct local-only fan-out, so same-worker
    clients still see live updates even with no Redis at all — only cross-
    worker delivery is lost, never live updates outright."""
    payload = json.dumps(event)
    client = await _get_presence_redis()
    if client:
        try:
            await client.publish(f"{channel_prefix}:{key}", payload)
            return
        except Exception:
            pass
    if channel_prefix == "org_doc":
        await _fanout_doc_local(key, payload)
    else:
        await _fanout_presence_local(key, payload)


async def _publish_presence(org_id: str, event: dict):
    await _publish_org_event("presence", org_id, event)


async def _publish_org_doc_event(doc_id: str, event: dict):
    await _publish_org_event("org_doc", doc_id, event)


async def _publish_org_task_event(org_id: str, event: dict):
    await _publish_org_event("org_tasks", org_id, event)

# These four are plain env-derived constants also defined in app.py (used by
# 50+ non-org call sites there, so not worth relocating and re-importing —
# see this module's docstring for why the stateful deps above ARE injected
# instead). Duplicated here with the exact same env var + default as app.py;
# if either default ever changes, change both.
BASE_URL      = os.environ.get("BASE_URL", "https://sivarr.up.railway.app")
CRON_SECRET   = os.environ.get("CRON_SECRET", "")
PAYSTACK_API  = "https://api.paystack.co"
DEFAULT_CHANNELS = [
    {"id": "general",     "name": "general",     "desc": "Team-wide announcements"},
    {"id": "engineering", "name": "engineering", "desc": "Engineering discussions"},
    {"id": "product",     "name": "product",     "desc": "Product and design"},
    {"id": "sales",       "name": "sales",       "desc": "Sales and growth"},
    {"id": "design",      "name": "design",      "desc": "Design assets and feedback"},
    {"id": "random",      "name": "random",      "desc": "Off-topic conversations"},
]

# httpx is optional app-wide (see app.py's own try/except at import time) —
# mirrored here rather than injected since it's a pure library import with
# no app-state dependency.
try:
    import httpx as _httpx
except ImportError:
    _httpx = None

def _email_org_invite_html(inviter_name: str, org_name: str, join_url: str, role: str) -> str:
    # Escape attacker-controlled values (org name + inviter's display name) — they are
    # interpolated into HTML sent to arbitrary recipients (prevents HTML/phishing injection).
    inviter_name = html.escape(inviter_name or "")
    org_name     = html.escape(org_name or "")
    role         = html.escape(role or "")
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:24px;color:#1a1a1a">
  <div style="margin-bottom:28px">
    <span style="font-size:1.3rem;font-weight:800;color:#41076B;letter-spacing:-.03em">Sivarr</span>
  </div>
  <h2 style="margin:0 0 10px;font-size:1.4rem">You're invited to join <strong>{org_name}</strong></h2>
  <p style="color:#555;line-height:1.6;margin:0 0 8px">
    <strong>{inviter_name}</strong> has invited you to join <strong>{org_name}</strong> on Sivarr as a <strong>{role}</strong>.
  </p>
  <p style="color:#555;line-height:1.6;margin:0 0 28px">
    Sivarr brings your team's tasks, projects, docs, AI, and chat into one workspace.
    Accept below to jump in. This invite expires in <strong>7 days</strong>.
  </p>
  <a href="{join_url}"
     style="display:inline-block;background:#41076B;color:#fff;padding:13px 32px;
            border-radius:9px;text-decoration:none;font-weight:700;font-size:.95rem">
    Accept Invite &amp; Join {org_name} →
  </a>
  <p style="color:#999;font-size:.78rem;margin-top:32px;line-height:1.5">
    If you weren't expecting this, you can safely ignore this email.
  </p>
  <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
  <p style="color:#bbb;font-size:.72rem;text-align:center;margin:0">Sivarr · Your productivity OS</p>
</body></html>"""

def _email_org_mention_html(recipient_name: str, sender_name: str, org_name: str,
                            channel: str, preview: str) -> str:
    # Escape all org/member-controlled values — they're interpolated into HTML
    # emailed to other members (prevents stored-HTML / phishing injection).
    first        = html.escape((recipient_name.split()[0] if recipient_name else "") or "")
    sender_name  = html.escape(sender_name or "")
    org_name     = html.escape(org_name or "")
    channel      = html.escape(channel or "")
    safe_preview = html.escape((preview or "")[:300])
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:24px;color:#1a1a1a">
  <div style="margin-bottom:24px">
    <span style="font-size:1.3rem;font-weight:800;color:#41076B;letter-spacing:-.03em">Sivarr</span>
  </div>
  <h2 style="margin:0 0 6px;font-size:1.3rem;font-weight:800">You were mentioned, {first}</h2>
  <p style="color:#666;font-size:.9rem;margin:0 0 20px">
    <strong>{sender_name}</strong> mentioned you in <strong>#{channel}</strong> · {org_name}
  </p>
  <div style="background:#f6f6f6;border-left:3px solid #41076B;border-radius:4px;
              padding:14px 16px;margin-bottom:28px;font-size:.95rem;line-height:1.6;color:#333">
    {safe_preview}
  </div>
  <a href="{BASE_URL}/app"
     style="display:inline-block;background:#41076B;color:#fff;padding:12px 28px;
            border-radius:9px;text-decoration:none;font-weight:700;font-size:.92rem">
    View in Sivarr →
  </a>
  <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
  <p style="color:#bbb;font-size:.7rem;text-align:center;margin:0;line-height:1.6">
    Sivarr · Your productivity OS<br>
    You're getting this because you're a member of {org_name}.
  </p>
</body></html>"""

def _email_org_announcement_html(recipient_name: str, org_name: str,
                                  author_name: str, title: str, body: str) -> str:
    # Escape all org/member-controlled values — interpolated into HTML emailed
    # to other members (prevents stored-HTML / phishing injection).
    first       = html.escape((recipient_name.split()[0] if recipient_name else "") or "")
    org_name    = html.escape(org_name or "")
    author_name = html.escape(author_name or "")
    title       = html.escape(title or "")
    safe_body   = html.escape((body or "")[:1000]).replace("\n", "<br>")
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:24px;color:#1a1a1a">
  <div style="margin-bottom:24px">
    <span style="font-size:1.3rem;font-weight:800;color:#41076B;letter-spacing:-.03em">Sivarr</span>
  </div>
  <div style="font-size:.75rem;font-weight:700;color:#7B2CAD;text-transform:uppercase;
              letter-spacing:.06em;margin-bottom:8px">📢 Announcement · {org_name}</div>
  <h2 style="margin:0 0 6px;font-size:1.3rem;font-weight:800">{title}</h2>
  <p style="color:#888;font-size:.82rem;margin:0 0 20px">Posted by {author_name}</p>
  <p style="color:#555;font-size:.9rem;line-height:1.6;margin:0 0 16px">
    Hi {first}, {author_name} just posted an announcement in {org_name}:
  </p>
  {"<div style='background:#f6f6f6;border-radius:8px;padding:16px;margin-bottom:28px;font-size:.95rem;line-height:1.7;color:#333'>" + safe_body + "</div>" if body else ""}
  <a href="{BASE_URL}/app"
     style="display:inline-block;background:#7B2CAD;color:#fff;padding:12px 28px;
            border-radius:9px;text-decoration:none;font-weight:700;font-size:.92rem">
    View Announcement →
  </a>
  <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
  <p style="color:#bbb;font-size:.7rem;text-align:center;margin:0;line-height:1.6">
    Sivarr · Your productivity OS<br>
    You're getting this because you're a member of {org_name}.
  </p>
</body></html>"""

def _email_org_progress_html(recipient_name: str, org_name: str, period: str,
                              tasks_done: int, tasks_total: int,
                              goals: list, top_contributors: list) -> str:
    first = recipient_name.split()[0] if recipient_name else recipient_name
    completion_pct = round((tasks_done / tasks_total * 100) if tasks_total else 0)
    bar_w = min(completion_pct, 100)

    goal_rows = "".join(
        f'<tr>'
        f'<td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#333;font-size:.88rem">{g.get("title","")}</td>'
        f'<td style="padding:8px 0;border-bottom:1px solid #f0f0f0;text-align:right;font-size:.88rem">'
        f'<span style="color:#41076B;font-weight:700">{g.get("progress",0)}%</span></td>'
        f'</tr>'
        for g in goals[:5]
    ) if goals else '<tr><td colspan="2" style="padding:8px 0;color:#aaa;font-size:.85rem">No active goals this week.</td></tr>'

    contrib_rows = "".join(
        f'<li style="margin-bottom:6px;font-size:.88rem;color:#333">'
        f'<strong>{c["name"]}</strong>: {c["done"]} task{"s" if c["done"]!=1 else ""} completed</li>'
        for c in top_contributors[:5]
    ) if top_contributors else '<li style="color:#aaa;font-size:.85rem">No activity data yet.</li>'

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:40px auto;padding:24px;color:#1a1a1a">
  <div style="margin-bottom:24px;display:flex;align-items:center;gap:10px">
    <div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#41076B,#7B2CAD);
                display:inline-flex;align-items:center;justify-content:center">
      <span style="color:#fff;font-weight:900;font-size:.75rem">S</span>
    </div>
    <span style="font-size:1.1rem;font-weight:800;color:#41076B;letter-spacing:-.03em">Sivarr</span>
  </div>
  <div style="font-size:.75rem;font-weight:700;color:#41076B;text-transform:uppercase;
              letter-spacing:.06em;margin-bottom:8px">Weekly Progress Report · {org_name}</div>
  <h2 style="margin:0 0 4px;font-size:1.35rem;font-weight:800">Here's how the team did, {first} 📊</h2>
  <p style="color:#888;font-size:.82rem;margin:0 0 28px">{period}</p>

  <!-- Task completion -->
  <h3 style="font-size:.88rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
             color:#888;margin:0 0 10px">Task Completion</h3>
  <div style="background:#f0f0f0;border-radius:6px;height:10px;overflow:hidden;margin-bottom:8px">
    <div style="width:{bar_w}%;height:100%;background:linear-gradient(90deg,#41076B,#7B2CAD);border-radius:6px"></div>
  </div>
  <p style="font-size:.88rem;color:#555;margin:0 0 28px">
    <strong>{tasks_done}</strong> of <strong>{tasks_total}</strong> tasks completed this week
    <span style="color:#41076B;font-weight:700;margin-left:6px">({completion_pct}%)</span>
  </p>

  <!-- Goals -->
  <h3 style="font-size:.88rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
             color:#888;margin:0 0 10px">Goal Progress</h3>
  <table style="width:100%;border-collapse:collapse;margin-bottom:28px">
    {goal_rows}
  </table>

  <!-- Top contributors -->
  <h3 style="font-size:.88rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
             color:#888;margin:0 0 10px">Top Contributors</h3>
  <ul style="padding-left:18px;margin:0 0 28px;line-height:1.8">{contrib_rows}</ul>

  <a href="{BASE_URL}/app"
     style="display:inline-block;background:#41076B;color:#fff;padding:13px 32px;
            border-radius:9px;text-decoration:none;font-weight:700;font-size:.92rem">
    Open Sivarr →
  </a>
  <hr style="border:none;border-top:1px solid #f0f0f0;margin:32px 0 20px">
  <p style="color:#bbb;font-size:.7rem;text-align:center;margin:0;line-height:1.6">
    Sivarr · Your productivity OS<br>
    You're getting this because you're a member of {org_name}.
  </p>
</body></html>"""

def _org_sub_active(org: dict) -> bool:
    """True if the org holds an active, non-expired seat subscription."""
    sub = ((org or {}).get("settings") or {}).get("subscription") or {}
    if sub.get("status") != "active":
        return False
    exp = sub.get("expires")
    if exp:
        try:
            if datetime.datetime.utcnow() > datetime.datetime.strptime(exp, "%Y-%m-%d"):
                return False
        except ValueError:
            pass
    return True

def _org_audit(org_id: str, actor_sid: str, actor_name: str, action: str):
    """Append an admin action to the org audit log (collections, owner=org_id)."""
    try:
        aid = uuid.uuid4().hex[:12]
        db.coll_put("org_audit", aid,
                    {"id": aid, "ts": datetime.datetime.utcnow().isoformat(),
                     "actor_sid": actor_sid, "actor": actor_name or "", "action": action},
                    owner=org_id)
    except Exception as exc:
        log.error(f"org audit failed: {exc}")

def _org_member_sid(m: dict) -> str:
    return m.get("sid") or m.get("user_sid") or ""

async def _ps_call(secret_key: str, path: str, params: dict | None = None) -> dict:
    """Proxy a GET request to the Paystack API with the given secret key."""
    headers = {"Authorization": f"Bearer {secret_key}"}
    url = f"{PAYSTACK_API}{path}"
    async with _httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, headers=headers, params=params or {})
    return resp.json()


async def _ps_post(secret_key: str, path: str, json_body: dict | None = None) -> dict:
    """Proxy a POST request to the Paystack API with the given secret key. Only
    the invoice (Payment Request) + Customer endpoints below use this -- every
    other Paystack endpoint in this file is read-only (GET via _ps_call)."""
    headers = {"Authorization": f"Bearer {secret_key}"}
    url = f"{PAYSTACK_API}{path}"
    async with _httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, headers=headers, json=json_body or {})
    return resp.json()

def _org_check(token: str) -> tuple[dict, str]:
    """Validate token and return (session, org_id). Raises HTTPException on failure.

    Previously read org_id from the user's personal progress blob
    (p.get("org_id","")) — a field nothing in the codebase ever writes, so
    this always raised 403 for every caller, including org owners. Every
    other org endpoint resolves membership via db.get_org_by_member(sid);
    this now matches that pattern.
    """
    sess = get_session_from_token(token)
    if not sess:
        raise HTTPException(401, "Invalid session.")
    org = db.get_org_by_member(sess["sid"])
    if not org:
        raise HTTPException(403, "Not in an organisation.")
    return sess, org["id"]

def _org_admin_check(token: str) -> tuple[dict, str]:
    """Like _org_check but also verifies admin/owner role."""
    sess, org_id = _org_check(token)
    # Check role via org_members
    conn = db._get_conn()
    if conn:
        try:
            with conn.cursor(cursor_factory=__import__('psycopg2').extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT role FROM org_members WHERE org_id=%s AND user_sid=%s",
                    (org_id, sess["sid"])
                )
                row = cur.fetchone()
        finally:
            db._release(conn)
    else:
        row = None

    # Also allow owner check via orgs table
    org = db.get_org(org_id) if hasattr(db, 'get_org') else None
    is_owner = org and org.get("owner_sid") == sess["sid"]
    is_admin = row and row["role"] in ("admin", "owner")
    if not (is_owner or is_admin):
        raise HTTPException(403, "Admin access required.")
    return sess, org_id

def _ps_key_for_org(org_id: str) -> str:
    row = db.get_org_integration(org_id, "paystack")
    if not row or not row.get("secret_key"):
        raise HTTPException(402, "Paystack not connected. Go to Org → Financials → Connect.")
    return row["secret_key"]


def build_router(load_progress, send_email, send_push, _is_valid_admin_session, session_cookie_key, has_plan) -> APIRouter:
    router = APIRouter()

    @router.post("/api/org/get")
    async def org_get(data: dict):
        """Return the org the current user belongs to, or null."""
        sid, name = _resolve_token(data)
        if not db.is_available():
            raise HTTPException(503, "Database unavailable.")
        db.init_db()  # cheap no-op once schema is ready; guards the cold-boot race
        org = await asyncio.to_thread(db.get_org_by_member, sid)
        if not org:
            return {"org": None}
        # These six reads are independent — run them concurrently (each grabs its own
        # pooled connection) instead of six sequential cross-region round-trips, and
        # off the event loop so the worker stays responsive.
        members, tasks, projects, docs, goals, founder = await asyncio.gather(
            asyncio.to_thread(db.get_org_members,  org["id"]),
            asyncio.to_thread(db.get_org_tasks,    org["id"]),
            asyncio.to_thread(db.get_org_projects, org["id"]),
            asyncio.to_thread(db.get_org_docs,     org["id"]),
            asyncio.to_thread(db.get_org_goals,    org["id"]),
            asyncio.to_thread(db.get_org_founder,  org["id"]),
        )
        _org_sub = (org.get("settings") or {}).get("subscription") or None
        return {
            "org": {
                "id":          org["id"],
                "name":        org["name"],
                "description": org.get("description", ""),
                "logo":        org.get("logo", ""),
                "plan":        org.get("plan", "free"),
                "member_role": org.get("member_role", "member"),
                "owner_sid":   org.get("owner_sid", ""),
                "created_at":  str(org.get("created_at", "")),
                "subscription": _org_sub,
                "sub_active":   _org_sub_active(org),
                "seats_paid":   (_org_sub or {}).get("seats"),
                "seats_used":   len(members),
            },
            "members":  members,
            "tasks":    tasks,
            "projects": projects,
            "docs":     docs,
            "goals":    goals,
            "founder":  founder,
        }


    @router.get("/api/org/debug")
    async def org_debug(token: str = ""):
        """Full diagnostic: DB state, tables, schema, user row, org row. Requires admin token."""
        if not _is_valid_admin_session(sanitize_text(token, 200)):
            raise HTTPException(401, "Unauthorized")
        out = {}

        # 1. Basic DB connectivity
        out["db_test"] = db.db_test()

        if not out["db_test"].get("ping"):
            return out

        conn = db._get_conn()
        if not conn:
            out["conn"] = "failed"
            return out

        try:
            with conn.cursor() as cur:
                # 2. Which tables exist in the public schema?
                cur.execute("""
                    SELECT table_name FROM information_schema.tables
                    WHERE table_schema = 'public' ORDER BY table_name
                """)
                out["tables"] = [r[0] for r in cur.fetchall()]

                # 3. Specifically check for org tables
                org_tables = {"orgs", "org_members", "org_tasks", "org_projects",
                              "org_docs", "org_messages", "org_goals", "org_founder"}
                out["org_tables_present"] = [t for t in org_tables if t in out["tables"]]
                out["org_tables_missing"] = [t for t in org_tables if t not in out["tables"]]

            conn.rollback()

            # 4. Try init_db and report result
            try:
                ok = db.init_db()
                out["init_db_result"] = "success" if ok else "failed"
            except Exception as e:
                out["init_db_result"] = f"exception: {e}"

            # 5. If token provided, check the user row and any existing org
            if token:
                entry = get_session_from_token(token)
                if entry:
                    sid = entry["sid"]
                    out["session_sid"] = sid[:8] + "…"
                    with conn.cursor() as cur:
                        cur.execute("SELECT sid, name, email FROM users WHERE sid=%s", (sid,))
                        row = cur.fetchone()
                        out["user_row_in_db"] = bool(row)
                        if row:
                            out["user_name"] = row[1]
                    conn.rollback()
                    org = db.get_org_by_member(sid)
                    out["existing_org"] = org["name"] if org else None
                else:
                    out["session"] = "invalid or expired token"

        except Exception as e:
            out["error"] = str(e)
        finally:
            db._release(conn)

        return out


    @router.post("/api/org/create")
    async def org_create(data: dict, bg: BackgroundTasks):
        sid, uname = _resolve_token(data)
        diag = db.db_test()
        if not diag.get("ping"):
            raise HTTPException(503, f"DB unavailable: {diag.get('error','unknown')}")
        # Ensure schema exists — handles Railway startup race where DB wasn't ready at boot
        db.init_db()
        existing = db.get_org_by_member(sid)
        if existing:
            raise HTTPException(409, "You already belong to an organization.")
        org_name = sanitize_text(str(data.get("name", "")).strip(), 80)
        if not org_name or len(org_name) < 2:
            raise HTTPException(400, "Organization name must be at least 2 characters.")
        org_id = uuid.uuid4().hex[:20]
        ok, err = db.create_org(sid, org_name, org_id, owner_name=uname)
        if not ok:
            log.error(f"org_create failed for {sid}: {err}")
            raise HTTPException(500, f"Failed to create organization: {err or 'check server logs'}")
        log.info(f"Org created: {org_name} ({org_id}) by {sid}")
        return {"ok": True, "org_id": org_id, "name": org_name}


    @router.post("/api/org/update")
    async def org_update(data: dict):
        sid, actor = _resolve_token(data)
        if not db.is_available():
            raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org:
            raise HTTPException(404, "You don't belong to an organization.")
        if org.get("owner_sid") != sid:
            raise HTTPException(403, "Only the owner can update the organization.")
        updates = {}
        if "name" in data:
            name = sanitize_text(str(data["name"]).strip(), 80)
            if len(name) < 2:
                raise HTTPException(400, "Name must be at least 2 characters.")
            updates["name"] = name
        if "description" in data:
            updates["description"] = sanitize_text(str(data.get("description", "")), 500)
        if not updates:
            raise HTTPException(400, "Nothing to update.")
        db.update_org(org["id"], sid, updates)
        _org_audit(org["id"], sid, actor, "Updated organisation profile")
        return {"ok": True, **updates}


    @router.post("/api/org/delete")
    async def org_delete(data: dict):
        """Owner-only, permanent. Requires the caller to echo the org's exact
        current name back as confirm_name -- checked here server-side, not
        just in the client's typed-confirmation modal, the same
        never-trust-client-side-only principle _validate_auth_input uses for
        login. db.delete_org cascades every org_* table via FK ON DELETE
        CASCADE; nothing else needs to be told about this individually."""
        sid, actor = _resolve_token(data)
        if not db.is_available():
            raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org:
            raise HTTPException(404, "You don't belong to an organization.")
        if org.get("owner_sid") != sid:
            raise HTTPException(403, "Only the owner can delete the organization.")
        confirm_name = sanitize_text(str(data.get("confirm_name", "")), 80).strip()
        if confirm_name != org.get("name", ""):
            raise HTTPException(400, "Organization name confirmation did not match.")
        if not db.delete_org(org["id"], sid):
            raise HTTPException(500, "Failed to delete organization.")
        log.info(f"Org deleted: {org.get('name')} ({org['id']}) by {sid}")
        return {"ok": True}


    @router.post("/api/org/member/role")
    async def org_member_role(data: dict):
        sid, actor = _resolve_token(data)
        if not db.is_available():
            raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org:
            raise HTTPException(404, "You don't belong to an organization.")
        if org.get("owner_sid") != sid:
            raise HTTPException(403, "Only the owner can change member roles.")
        target = sanitize_text(str(data.get("sid", "")), 40)
        role   = sanitize_text(str(data.get("role", "")), 20)
        if role not in ("admin", "manager", "member", "guest"):
            raise HTTPException(400, "Invalid role.")
        if target == org.get("owner_sid"):
            raise HTTPException(400, "The owner's role can't be changed.")
        if not db.set_org_member_role(org["id"], target, role):
            raise HTTPException(404, "Member not found.")
        members = db.get_org_members(org["id"])
        tname = next((m.get("name") for m in members if _org_member_sid(m) == target), target[:8])
        _org_audit(org["id"], sid, actor, f"Set {tname}'s role to {role}")
        return {"ok": True}


    @router.post("/api/org/member/remove")
    async def org_member_remove(data: dict):
        sid, actor = _resolve_token(data)
        if not db.is_available():
            raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org:
            raise HTTPException(404, "You don't belong to an organization.")
        if org.get("member_role") not in ("owner", "admin"):
            raise HTTPException(403, "Only owners and admins can remove members.")
        target = sanitize_text(str(data.get("sid", "")), 40)
        if target == sid:
            raise HTTPException(400, "You can't remove yourself.")
        tgt = next((m for m in db.get_org_members(org["id"]) if _org_member_sid(m) == target), None)
        if not tgt:
            raise HTTPException(404, "Member not found.")
        trole = tgt.get("role", "member")
        if trole == "owner":
            raise HTTPException(400, "The owner can't be removed.")
        if org.get("member_role") == "admin" and trole in ("admin", "manager"):
            raise HTTPException(403, "Admins can only remove members and guests.")
        if not db.remove_org_member(org["id"], target):
            raise HTTPException(404, "Member not found.")
        _org_audit(org["id"], sid, actor, f"Removed {tgt.get('name', target[:8])} ({trole})")
        return {"ok": True}


    @router.post("/api/org/audit")
    async def org_audit_list(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available():
            raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org:
            raise HTTPException(404, "You don't belong to an organization.")
        if org.get("member_role") not in ("owner", "admin"):
            raise HTTPException(403, "Only owners and admins can view the audit log.")
        rows = sorted(db.coll_list("org_audit", owner=org["id"]), key=lambda a: a.get("ts", ""), reverse=True)
        return {"ok": True, "audit": rows[:100]}


    @router.post("/api/org/invite")
    async def org_invite(data: dict, request: Request, bg: BackgroundTasks):
        sid, uname = _resolve_token(data)
        # Throttle invites: this endpoint emails an attacker-supplied address from our
        # trusted domain, so cap it per inviter to prevent spam/phishing relay abuse.
        check_rate_limit(get_client_key(request, sid), 10, "org_invite")
        if not db.is_available():
            raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org:
            raise HTTPException(404, "You don't belong to an organization.")
        if org.get("member_role") not in ("owner", "admin", "manager"):
            raise HTTPException(403, "Only owners, admins, and managers can invite members.")
        # Seat enforcement (only once the org is on a paid seat plan — legacy orgs unaffected).
        if _org_sub_active(org):
            seats_paid = ((org.get("settings") or {}).get("subscription") or {}).get("seats", 0)
            if db.count_org_members(org["id"]) >= seats_paid:
                raise HTTPException(402, f"All {seats_paid} seats are in use. Add seats to invite more members.")
        email = sanitize_text(str(data.get("email", "")).strip().lower(), 120)
        if not email or "@" not in email:
            raise HTTPException(400, "Valid email required.")
        role  = sanitize_text(str(data.get("role", "member")), 20)
        if role not in ("admin", "manager", "member", "guest"):
            role = "member"
        token      = secrets.token_urlsafe(32)
        expires_at = datetime.datetime.utcnow() + datetime.timedelta(days=7)
        ok = db.create_org_invite(org["id"], email, role, sid, token, expires_at)
        if not ok:
            raise HTTPException(500, "Failed to create invite.")
        join_url = f"{BASE_URL}/?org_invite={token}"
        bg.add_task(send_email, email,
                    f"You're invited to join {org['name']} on Sivarr",
                    _email_org_invite_html(uname, org["name"], join_url, role))
        # If the invitee already has a Sivarr account, also web-push them (pop-up)
        # so the invite reaches them in-app, not just by email.
        existing = db.get_user_by_email(email) if db.is_available() else None
        if existing and existing.get("sid"):
            bg.add_task(send_push, existing["sid"], f"📨 Invited to {org['name']}",
                        f"{uname} invited you to join {org['name']} on Sivarr.", "/app", f"orginvite_{org['id']}")
        log.info(f"Org invite: {email} → {org['name']} as {role}")
        return {"ok": True}


    @router.get("/api/org/invites/pending")
    async def org_invites_pending(token: str = ""):
        """Pending (unused, unexpired) org invites for the signed-in user's email —
        surfaced in-app on sign-in so an invite isn't lost if the email is missed."""
        sess = get_session_from_token(token)
        if not sess:
            raise HTTPException(401, "Invalid session.")
        if not db.is_available():
            return {"invites": []}
        email = sess.get("email", "") or load_progress(sess["sid"]).get("email", "")
        if not email:
            return {"invites": []}
        invs = await asyncio.to_thread(db.get_pending_invites_for_email, email)
        return {"invites": [
            {"token": i["token"], "org_id": i["org_id"],
             "org_name": i.get("org_name", ""), "role": i.get("role", "member")}
            for i in invs
        ]}


    @router.get("/api/org/join/{token}")
    async def org_join_link(token: str):
        """Redirect invite links to the app — the client handles actual join."""
        return RedirectResponse(url=f"/?org_invite={token}", status_code=302)


    @router.post("/api/org/join")
    async def org_join(data: dict, bg: BackgroundTasks):
        """Accept an org invite — called by the client after the user logs in."""
        sid, _ = _resolve_token(data)
        if not db.is_available():
            raise HTTPException(503, "Database unavailable.")
        # BUG FIX: the invite token arrives as `invite_token` (the body's `token`
        # field is the SESSION token, consumed by _resolve_token above). Reading
        # `token` here looked up the invite under the session token → never found →
        # the member was never added.
        invite_token = sanitize_text(str(data.get("invite_token", "")), 100)
        if not invite_token:
            raise HTTPException(400, "Invite token required.")
        invite = db.get_org_invite(invite_token)
        if not invite:
            raise HTTPException(404, "Invite not found or already used.")
        # expires_at is a tz-aware TIMESTAMPTZ from the DB; comparing it against a
        # naive utcnow() raises TypeError (offset-naive vs offset-aware) → 500 on
        # every join. Normalise both to aware-UTC before comparing.
        _exp = invite["expires_at"]
        if _exp.tzinfo is None:
            _exp = _exp.replace(tzinfo=datetime.timezone.utc)
        if _exp < datetime.datetime.now(datetime.timezone.utc):
            raise HTTPException(410, "This invite link has expired.")
        # Seat enforcement at the authoritative point (covers invites created before the
        # seat limit was hit). Only applies to orgs on a paid seat plan.
        _join_org = db.get_org(invite["org_id"])
        if _join_org and _org_sub_active(_join_org):
            seats_paid = ((_join_org.get("settings") or {}).get("subscription") or {}).get("seats", 0)
            if db.count_org_members(invite["org_id"]) >= seats_paid:
                raise HTTPException(402, "All seats in this organisation are in use. Ask the owner to add seats.")
        ok = db.use_org_invite(invite_token, sid)
        if not ok:
            raise HTTPException(500, "Failed to join organization.")
        org = db.get_org_by_member(sid)
        org_name = org["name"] if org else ""
        # Notify the new member: web push (pop-up) now they're in the app, plus the
        # org owner gets a heads-up that someone joined.
        if org:
            bg.add_task(send_push, sid, f"🎉 Welcome to {org_name}",
                        f"You're now a member of {org_name}.", "/app", f"orgjoin_{org['id']}")
            owner_sid = org.get("owner_sid")
            if owner_sid and owner_sid != sid:
                bg.add_task(send_push, owner_sid, f"👥 {org_name}: new member",
                            "Someone just joined your organization.", "/app", f"orgjoined_{org['id']}")
        return {"ok": True, "org_name": org_name}


    @router.post("/api/org/tasks")
    async def org_tasks_list(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        project_id = data.get("project_id")
        limit  = min(int(data.get("limit",  500)), 1000)
        offset = max(int(data.get("offset", 0)),   0)
        tasks = db.get_org_tasks(org["id"], project_id, limit=limit, offset=offset)
        return {"tasks": tasks}


    @router.post("/api/org/tasks/create")
    async def org_task_create(data: dict, bg: BackgroundTasks):
        sid, uname = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        title = sanitize_text(str(data.get("title", "")).strip(), 200)
        if not title: raise HTTPException(400, "Task title required.")
        task_id    = uuid.uuid4().hex[:20]
        status     = sanitize_text(str(data.get("status", "todo")), 20)
        priority   = sanitize_text(str(data.get("priority", "normal")), 20)
        desc       = sanitize_text(str(data.get("description", "")), 2000)
        assignee   = sanitize_text(str(data.get("assignee_sid", "")), 40) or None
        project_id = sanitize_text(str(data.get("project_id", "")), 40) or None
        due_date   = sanitize_text(str(data.get("due_date", "")), 10) or None
        ok = db.create_org_task(org["id"], task_id, title, sid, status, priority, desc, assignee, project_id, due_date)
        if not ok: raise HTTPException(500, "Failed to create task.")
        # C1: notify the assignee on delegation (web push; no-op if they have no
        # push subscription). Skip self-assignment.
        if assignee and assignee != sid:
            bg.add_task(send_push, assignee,
                        f"📋 {org.get('name', 'Your team')}: new task assigned",
                        f"{uname} assigned you: {title}", "/app", f"orgtask_{task_id}")
        # Real-time collab Week 2: live task sync — every org member connected
        # to /api/org/presence/ws sees this appear without a refresh.
        await _publish_org_task_event(org["id"], {
            "type": "task_created",
            "task": {
                "id": task_id, "org_id": org["id"], "title": title, "description": desc,
                "status": status, "priority": priority, "assignee_sid": assignee,
                "created_by": sid, "project_id": project_id, "due_date": due_date,
            },
        })
        return {"ok": True, "task_id": task_id}


    @router.post("/api/org/tasks/update")
    async def org_task_update(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        task_id = sanitize_text(str(data.get("task_id", "")), 40)
        if not task_id: raise HTTPException(400, "task_id required.")
        allowed = {"title", "description", "status", "priority", "assignee_sid", "project_id", "due_date"}
        # v can be None (clearing due_date/assignee_sid/project_id) — str(None) would send
        # the literal "None" to a `date`/uuid column and 500. Pass nulls through untouched.
        updates = {k: (v if v is None else sanitize_text(str(v), 2000)) for k, v in data.items() if k in allowed}
        ok = db.update_org_task(task_id, updates, org["id"])
        # Only broadcast a write that actually landed — publishing on a
        # silent DB failure would show other members a change that a refresh
        # would then immediately revert.
        if ok:
            await _publish_org_task_event(org["id"], {
                "type": "task_updated", "task_id": task_id, "updates": updates,
            })
        return {"ok": True}


    @router.post("/api/org/tasks/delete")
    async def org_task_delete(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        task_id = sanitize_text(str(data.get("task_id", "")), 40)
        if not task_id: raise HTTPException(400, "task_id required.")
        ok = db.delete_org_task(task_id, org["id"])
        if ok:
            await _publish_org_task_event(org["id"], {"type": "task_deleted", "task_id": task_id})
        return {"ok": True}


    @router.post("/api/org/projects")
    async def org_projects_list(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        return {"projects": db.get_org_projects(org["id"])}


    @router.post("/api/org/projects/create")
    async def org_project_create(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        name = sanitize_text(str(data.get("name", "")).strip(), 120)
        if not name: raise HTTPException(400, "Project name required.")
        project_id = uuid.uuid4().hex[:20]
        desc  = sanitize_text(str(data.get("description", "")), 500)
        color = sanitize_text(str(data.get("color", "#41076B")), 20)
        ok = db.create_org_project(org["id"], project_id, name, sid, desc, color)
        if not ok: raise HTTPException(500, "Failed to create project.")
        return {"ok": True, "project_id": project_id}


    @router.post("/api/org/projects/update")
    async def org_project_update(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        project_id = sanitize_text(str(data.get("project_id", "")), 40)
        if not project_id: raise HTTPException(400, "project_id required.")
        allowed = {"name", "description", "status", "color"}
        updates = {k: sanitize_text(str(v), 500) for k, v in data.items() if k in allowed}
        db.update_org_project(project_id, updates, org["id"])
        return {"ok": True}


    @router.post("/api/org/docs")
    async def org_docs_list(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        return {"docs": db.get_org_docs(org["id"])}


    @router.post("/api/org/docs/save")
    async def org_doc_save(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        doc_id  = sanitize_text(str(data.get("doc_id", "") or uuid.uuid4().hex[:20]), 40)
        title   = sanitize_text(str(data.get("title", "Untitled Doc")).strip(), 200)
        content = sanitize_text(str(data.get("content", "")), 50000)
        # IDOR fix: save_org_doc() upserts by id alone (ON CONFLICT (id), no
        # org_id filter in the UPDATE), so a caller supplying another org's
        # doc_id could silently overwrite that org's title/content/yjs_state.
        # Same bug class already fixed on org_doc_get below; mirrored here.
        existing = db.get_org_doc(doc_id)
        if existing and existing.get("org_id") != org["id"]:
            raise HTTPException(404, "Doc not found.")
        # yjs_state: base64 Y.Doc snapshot (Y.encodeStateAsUpdate), opaque to
        # the server. Present whenever the save comes from the live collab
        # editor -- lets every future opener of this doc seed their Y.Doc via
        # Y.applyUpdate from this exact CRDT state instead of independently
        # re-deriving one from the HTML (see js/features/org.js orgOpenDoc:
        # two separately-`setContent()`-seeded Y.Docs are NOT merge-compatible
        # even when they render identical text, since each gets its own
        # internal item/clock structure). Absent for older, non-collab saves.
        yjs_state_raw = data.get("yjs_state")
        yjs_state = sanitize_text(str(yjs_state_raw), 2_000_000) if yjs_state_raw else None
        ok = db.save_org_doc(org["id"], doc_id, title, content, sid, yjs_state)
        if not ok: raise HTTPException(500, "Failed to save doc.")
        return {"ok": True, "doc_id": doc_id}


    @router.post("/api/org/docs/get")
    async def org_doc_get(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        doc_id = sanitize_text(str(data.get("doc_id", "")), 40)
        if not doc_id: raise HTTPException(400, "doc_id required.")
        doc = db.get_org_doc(doc_id)
        # IDOR fix: get_org_doc() looks up by id alone (no org filter — every
        # other org_doc_* route already scopes its query by org_id, this one
        # didn't), so any authenticated user who knew or guessed a doc_id
        # could read another org's private document content. Found while
        # adding live co-editing to this same endpoint family, fixed here
        # rather than filed separately since it's the same few lines.
        if not doc or doc.get("org_id") != org["id"]:
            raise HTTPException(404, "Doc not found.")
        return {"doc": doc}


    @router.post("/api/org/docs/delete")
    async def org_doc_delete(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        doc_id = sanitize_text(str(data.get("doc_id", "")), 40)
        if not doc_id: raise HTTPException(400, "doc_id required.")
        db.delete_org_doc(doc_id, org["id"])
        return {"ok": True}


    @router.websocket("/api/org/docs/{doc_id}/ws")
    async def org_doc_ws(websocket: WebSocket, doc_id: str):
        """Real-time collab Week 3-4: live document co-editing transport.
        Relays JSON envelopes (opaque to the server — see this module's
        docstring and js/features/org.js's _orgDocConnectWS) between every
        client that has this doc open, using the exact same Redis-pub/sub-
        with-local-fallback shape as presence/task sync above. The server
        never decodes the Yjs payload or inspects message `type` — Y.Doc's
        CRDT merge logic and the join-sync handshake run entirely client-
        side, this is purely a relay. Persisted content (org_docs.content,
        org_docs.yjs_state) is saved separately via the existing
        POST /api/org/docs/save, debounced client-side — this socket only
        carries the live, in-session delta, never touches Postgres itself."""
        token = websocket.cookies.get(session_cookie_key, "") or websocket.query_params.get("token", "")
        token = sanitize_text(token, 100)
        entry = get_session_from_token(token)
        if not entry:
            await websocket.close(code=4401)
            return
        if not db.is_available():
            await websocket.close(code=4503)
            return
        sid = entry["sid"]
        org = await asyncio.to_thread(db.get_org_by_member, sid)
        if not org:
            await websocket.close(code=4404)
            return
        doc = await asyncio.to_thread(db.get_org_doc, doc_id)
        if not doc or doc.get("org_id") != org["id"]:
            await websocket.close(code=4404)
            return

        await websocket.accept()
        _DOC_LOCAL.setdefault(doc_id, set()).add(websocket)
        await _ensure_presence_subscriber()  # no-op if Redis isn't available

        try:
            while True:
                # Generic envelope relay -- the client drives the protocol
                # (currently "update" for incremental Yjs updates, plus
                # "sync-request"/"sync-response" for the join handshake, see
                # js/features/org.js). The server only ever stamps from_sid
                # and republishes; it never inspects `type` or the payload,
                # so adding future message kinds needs no server change.
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                msg["from_sid"] = sid
                await _publish_org_doc_event(doc_id, msg)
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            log.warning(f"org_doc_ws: {exc}")
        finally:
            _DOC_LOCAL.get(doc_id, set()).discard(websocket)


    @router.post("/api/org/messages")
    async def org_messages_list(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        channel = sanitize_text(str(data.get("channel", "general")), 60)
        msgs = db.get_org_messages(org["id"], channel)
        return {"messages": msgs}


    @router.post("/api/org/messages/send")
    async def org_message_send(data: dict, bg: BackgroundTasks):
        sid, uname = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        content = sanitize_text(str(data.get("content", "")).strip(), 2000)
        if not content: raise HTTPException(400, "Message content required.")
        channel = sanitize_text(str(data.get("channel", "general")), 60)
        msg = db.send_org_message(org["id"], channel, sid, uname, content)
        if not msg: raise HTTPException(500, "Failed to send message.")

        # ── @mention email notifications ─────────────────────────────
        import re as _re
        raw_mentions = _re.findall(r'@(\w+)', content)
        if raw_mentions:
            members = db.get_org_members(org["id"])
            for m in members:
                if m["sid"] == sid:
                    continue  # don't notify the sender
                first_word = (m["name"] or "").split()[0].lower()
                if any(mention.lower() == first_word for mention in raw_mentions):
                    bg.add_task(
                        send_email,
                        m["email"],
                        f"{uname} mentioned you in #{channel} · {org['name']}",
                        _email_org_mention_html(m["name"], uname, org["name"], channel, content),
                    )

        return {"ok": True}


    @router.get("/api/org/chat/stream")
    async def org_chat_stream(token: str = "", last_id: int = 0, request: Request = None):
        """SSE endpoint — polls PostgreSQL for new messages so all Gunicorn workers see the same feed."""
        token = sanitize_text(token, 100)
        entry = get_session_from_token(token)
        if not entry: raise HTTPException(401, "Invalid token.")
        sid = entry["sid"]
        if not db.is_available(): raise HTTPException(503, "DB unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        org_id = org["id"]
        cursor = max(0, int(last_id))

        async def stream():
            nonlocal cursor
            # Announcement cursor: baseline to the DB clock so we only push announcements
            # created *after* this connection (existing ones load via /api/org/announcements).
            ann_cursor = await asyncio.to_thread(db.db_now)
            while True:
                if request and await request.is_disconnected():
                    break
                sent = False
                # ── New chat messages ──
                msgs = await asyncio.to_thread(db.get_org_messages_since, org_id, cursor)
                for msg in msgs:
                    cursor = msg["id"]
                    payload = {
                        "id":          msg["id"],
                        "channel":     msg["channel"],
                        "content":     msg["content"],
                        "author_sid":  msg["author_sid"],
                        "author_name": msg["author_name"],
                        "created_at":  msg["created_at"].isoformat() if hasattr(msg["created_at"], "isoformat") else str(msg["created_at"]),
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
                    sent = True
                # ── New announcements (org-wide) ──
                if ann_cursor is not None:
                    anns = await asyncio.to_thread(db.get_org_announcements_since, org_id, ann_cursor)
                    for a in anns:
                        ann_cursor = a["created_at"]
                        ann = {
                            "id":          a["id"],
                            "org_id":      a.get("org_id", org_id),
                            "title":       a["title"],
                            "body":        a.get("body", ""),
                            "author_sid":  a.get("author_sid", ""),
                            "author_name": a.get("author_name", ""),
                            "pinned":      a.get("pinned", False),
                            "created_at":  a["created_at"].isoformat() if hasattr(a["created_at"], "isoformat") else str(a["created_at"]),
                        }
                        yield f"data: {json.dumps({'type': 'announcement', 'ann': ann})}\n\n"
                        sent = True
                if not sent:
                    yield ": ping\n\n"
                await asyncio.sleep(2)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control":    "no-cache",
                "X-Accel-Buffering":"no",
                "Connection":       "keep-alive",
            },
        )


    @router.get("/api/org/channels")
    async def org_channels(token: str = ""):
        token = sanitize_text(token, 100)
        entry = get_session_from_token(token)
        if not entry: raise HTTPException(401, "Invalid token.")
        return {"channels": DEFAULT_CHANNELS}


    @router.post("/api/org/presence")
    async def org_presence_ping(data: dict):
        sid, uname = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "DB unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization.")
        await asyncio.to_thread(db.upsert_presence, sid, org["id"], uname)
        return {"ok": True}


    @router.get("/api/org/presence")
    async def org_presence_list(token: str = ""):
        token = sanitize_text(token, 100)
        entry = get_session_from_token(token)
        if not entry: raise HTTPException(401, "Invalid token.")
        if not db.is_available(): return {"online": []}
        org = db.get_org_by_member(entry["sid"])
        if not org: return {"online": []}
        online = await asyncio.to_thread(db.get_presence, org["id"])
        return {"online": online}


    @router.websocket("/api/org/presence/ws")
    async def org_presence_ws(websocket: WebSocket):
        """Real-time presence — see module docstring. Auth mirrors the
        request.cookies-or-query-token pattern used elsewhere in app.py for
        non-body-token routes; the query-injecting _BearerTokenMiddleware only
        runs on http-type ASGI scopes, not websocket ones, so this route reads
        the cookie itself instead of relying on that middleware."""
        token = websocket.cookies.get(session_cookie_key, "") or websocket.query_params.get("token", "")
        token = sanitize_text(token, 100)
        entry = get_session_from_token(token)
        if not entry:
            await websocket.close(code=4401)
            return
        if not db.is_available():
            await websocket.close(code=4503)
            return
        sid = entry["sid"]
        uname = entry.get("name", "")
        org = await asyncio.to_thread(db.get_org_by_member, sid)
        if not org:
            await websocket.close(code=4404)
            return
        org_id = org["id"]

        await websocket.accept()
        _PRESENCE_LOCAL.setdefault(org_id, set()).add(websocket)
        await _ensure_presence_subscriber()  # no-op if Redis isn't available

        await asyncio.to_thread(db.upsert_presence, sid, org_id, uname)
        online = await asyncio.to_thread(db.get_presence, org_id)
        try:
            await websocket.send_text(json.dumps({"type": "snapshot", "online": online}))
        except Exception:
            _PRESENCE_LOCAL.get(org_id, set()).discard(websocket)
            return

        await _publish_presence(org_id, {"type": "join", "sid": sid, "name": uname})

        try:
            while True:
                # Client sends a small ping frame every ~20s purely to keep the
                # Postgres presence row's staleness cutoff (get_presence's 90s
                # window) fresh — the payload itself is never inspected.
                await websocket.receive_text()
                await asyncio.to_thread(db.upsert_presence, sid, org_id, uname)
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            log.warning(f"org_presence_ws: {exc}")
        finally:
            _PRESENCE_LOCAL.get(org_id, set()).discard(websocket)
            await _publish_presence(org_id, {"type": "leave", "sid": sid, "name": uname})


    @router.post("/api/org/goals")
    async def org_goals_list(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        goals = db.get_org_goals(org["id"])
        return {"goals": goals}


    @router.post("/api/org/goals/create")
    async def org_goal_create(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        title = sanitize_text(str(data.get("title", "")).strip(), 200)
        if not title: raise HTTPException(400, "Goal title required.")
        goal_id = f"og_{sid[:8]}_{int(__import__('time').time()*1000)}"
        db.create_org_goal(
            org_id=org["id"], goal_id=goal_id, title=title,
            created_by=sid,
            description=sanitize_text(str(data.get("description", "")), 500),
            goal_type=sanitize_text(str(data.get("type", "okr")), 20),
            owner_sid=sid,
            due_date=data.get("due_date") or None,
        )
        return {"ok": True, "goal_id": goal_id}


    @router.post("/api/org/goals/update")
    async def org_goal_update(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        goal_id = str(data.get("goal_id", ""))
        if not goal_id: raise HTTPException(400, "goal_id required.")
        db.update_org_goal(
            goal_id=goal_id, org_id=org["id"],
            title=sanitize_text(str(data["title"]), 200) if "title" in data else None,
            description=sanitize_text(str(data["description"]), 500) if "description" in data else None,
            status=data.get("status"),
            progress=int(data["progress"]) if "progress" in data else None,
            due_date=data.get("due_date"),
        )
        return {"ok": True}


    @router.post("/api/org/goals/delete")
    async def org_goal_delete(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        goal_id = str(data.get("goal_id", ""))
        if not goal_id: raise HTTPException(400, "goal_id required.")
        db.delete_org_goal(goal_id, org["id"])
        return {"ok": True}


    @router.post("/api/org/goals/kr/create")
    async def org_kr_create(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        goal_id = str(data.get("goal_id", ""))
        title   = sanitize_text(str(data.get("title", "")).strip(), 200)
        if not goal_id or not title: raise HTTPException(400, "goal_id and title required.")
        kr_id = f"kr_{sid[:8]}_{int(__import__('time').time()*1000)}"
        db.create_org_key_result(
            kr_id=kr_id, goal_id=goal_id, org_id=org["id"], title=title,
            target_value=float(data.get("target_value", 100)),
            unit=sanitize_text(str(data.get("unit", "%")), 20),
        )
        return {"ok": True, "kr_id": kr_id}


    @router.post("/api/org/goals/kr/update")
    async def org_kr_update(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        kr_id = str(data.get("kr_id", ""))
        if not kr_id: raise HTTPException(400, "kr_id required.")
        db.update_org_key_result(
            kr_id=kr_id, org_id=org["id"],
            current_value=float(data["current_value"]) if "current_value" in data else None,
            status=data.get("status"),
        )
        return {"ok": True}


    @router.post("/api/org/founder/get")
    async def org_founder_get(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        # Founder data (burn rate, cash balance, MRR/ARR, investor pipeline)
        # is sensitive and the UI already hides this tab from non-owners
        # (_founderTabVisibility() in org.js) -- but this endpoint had no
        # role check at all, so any member/guest could read it directly.
        # Matches the bar org_founder_save already enforces.
        if org.get("member_role") not in ("owner", "admin"):
            raise HTTPException(403, "Only owners and admins can view founder data.")
        # Founder Mode is a paid feature (js/app.js's _GUARDED gate requires a
        # Team or Creator plan) -- but that gate was client-side only. Nothing
        # server-side ever checked payment, so the feature was free to any
        # owner/admin regardless of subscription. Matches the client's own
        # requirement exactly (has_plan uses the same tier ordering as
        # _hasPlan/_PLAN_LEVELS in js/app.js).
        if not has_plan(load_progress(sid), "Team"):
            raise HTTPException(402, "Founder Mode requires a Team or Creator plan.")
        founder = db.get_org_founder(org["id"])
        return {"founder": founder}


    @router.post("/api/org/founder/save")
    async def org_founder_save(data: dict):
        sid, _ = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")
        if org.get("member_role") not in ("owner", "admin"):
            raise HTTPException(403, "Only owners and admins can edit founder data.")
        if not has_plan(load_progress(sid), "Team"):
            raise HTTPException(402, "Founder Mode requires a Team or Creator plan.")
        db.save_org_founder(
            org_id=org["id"],
            burn_rate=float(data.get("burn_rate", 0)),
            cash_balance=float(data.get("cash_balance", 0)),
            mrr=float(data.get("mrr", 0)),
            arr=float(data.get("arr", 0)),
            funding_stage=sanitize_text(str(data.get("funding_stage", "pre-seed")), 50),
            total_raised=float(data.get("total_raised", 0)),
            investors=data.get("investors", []),
            milestones=data.get("milestones", []),
        )
        return {"ok": True}


    @router.post("/api/org/ai/briefing")
    async def org_ai_briefing(data: dict):
        sid, uname = _resolve_token(data)
        if not db.is_available(): raise HTTPException(503, "Database unavailable.")
        org = db.get_org_by_member(sid)
        if not org: raise HTTPException(404, "No organization found.")

        tasks    = db.get_org_tasks(org["id"], limit=100)
        members  = db.get_org_members(org["id"])
        projects = db.get_org_projects(org["id"])
        goals    = db.get_org_goals(org["id"])
        founder  = db.get_org_founder(org["id"])

        from datetime import date
        today = date.today().isoformat()
        open_tasks   = [t for t in tasks if t["status"] != "done"]
        done_tasks   = [t for t in tasks if t["status"] == "done"]
        overdue      = [t for t in open_tasks if t.get("due_date") and str(t["due_date"]) < today]
        high_pri     = [t for t in open_tasks if t.get("priority") == "high"]
        active_goals = [g for g in goals if g.get("status") == "active"]

        context = f"""You are Sivarr, the AI operating intelligence for {org['name']}.
    Generate a concise executive briefing for {uname} (role: {org.get('member_role','member')}).

    Organization snapshot ({today}):
    - Members: {len(members)}
    - Open tasks: {len(open_tasks)} | Done: {len(done_tasks)} | Overdue: {len(overdue)} | High priority: {len(high_pri)}
    - Projects: {len(projects)} active
    - Goals: {len(active_goals)} active OKRs
    - MRR: ₦{founder.get('mrr', 0):,.0f} | Burn rate: ₦{founder.get('burn_rate', 0):,.0f}/mo | Runway: {round(founder['cash_balance']/founder['burn_rate']) if founder.get('burn_rate',0) > 0 and founder.get('cash_balance',0) > 0 else 'N/A'} months

    Top overdue tasks: {', '.join([t['title'] for t in overdue[:3]]) or 'None'}
    High priority: {', '.join([t['title'] for t in high_pri[:3]]) or 'None'}

    Write a 3–5 sentence executive briefing. Be direct and actionable. Highlight risks, wins, and the #1 priority today. No bullet points, flowing prose. Never use em dashes, use commas or periods instead."""

        sessions = get_sessions(sid)
        briefing = await async_gemini_ask(sessions["chat"], context)
        return {"briefing": briefing}


    @router.post("/api/org/announce")
    async def org_announce(data: dict, bg: BackgroundTasks):
        """Post a new org-wide announcement (admin/owner only)."""
        token = data.get("token","")
        sess  = get_session_from_token(token)
        if not sess:
            raise HTTPException(401, "Invalid session.")
        sid = sess["sid"]
        org = db.get_org_by_member(sid)
        if not org:
            raise HTTPException(403, "Not in an organisation.")
        org_id = org["id"]
        role   = org.get("member_role", "member")
        if role not in ("owner","admin"):
            raise HTTPException(403, "Only admins can post announcements.")
        p = load_progress(sid)
        author_name = p.get("name","")
        title  = sanitize_text(data.get("title",""), 200)
        body   = sanitize_text(data.get("body",""), 2000)
        pinned = bool(data.get("pinned", False))
        if not title:
            raise HTTPException(400, "title required.")
        ann_id = str(uuid.uuid4())
        ok = db.create_org_announcement(org_id, ann_id, title, body, sid, author_name, pinned)
        if not ok:
            raise HTTPException(500, "Failed to save announcement.")
        ann = {"id": ann_id, "org_id": org_id, "title": title, "body": body,
               "author_sid": sid, "author_name": author_name,
               "pinned": pinned, "created_at": datetime.datetime.utcnow().isoformat()}
        # Live delivery to every member is handled by the org SSE stream, which DB-polls
        # org_announcements so it works across all Gunicorn workers (in-memory broadcast did not).

        # ── Email all org members (except the author) ─────────────────
        members = db.get_org_members(org_id)
        for m in members:
            if m["sid"] == sid or not m.get("email"):
                continue
            bg.add_task(
                send_email,
                m["email"],
                f"📢 {title} · {org['name']}",
                _email_org_announcement_html(m["name"], org["name"], author_name, title, body),
            )

        return {"ok": True, "ann": ann}


    @router.get("/api/org/announcements")
    async def org_announcements_list(token: str = ""):
        """List org announcements for the current user's org."""
        sess = get_session_from_token(token)
        if not sess:
            raise HTTPException(401, "Invalid session.")
        org = db.get_org_by_member(sess["sid"])
        if not org:
            raise HTTPException(403, "Not in an organisation.")
        return {"announcements": db.get_org_announcements(org["id"])}


    @router.delete("/api/org/announce/{ann_id}")
    async def org_announce_delete(ann_id: str, token: str = ""):
        """Delete an announcement (admin/owner only)."""
        sess = get_session_from_token(token)
        if not sess:
            raise HTTPException(401, "Invalid session.")
        org = db.get_org_by_member(sess["sid"])
        if not org:
            raise HTTPException(403, "Not in an organisation.")
        role = org.get("member_role", "member")
        if role not in ("owner","admin"):
            raise HTTPException(403, "Only admins can delete announcements.")
        db.delete_org_announcement(ann_id)
        return {"ok": True}


    @router.get("/api/org/analytics")
    async def org_analytics(token: str = ""):
        """Return analytics for the current user's org."""
        sess = get_session_from_token(token)
        if not sess:
            raise HTTPException(401, "Invalid session.")
        org = db.get_org_by_member(sess["sid"])
        if not org:
            raise HTTPException(403, "Not in an organisation.")
        data = db.get_org_analytics(org["id"])
        if not data:
            return {"members": 0, "tasks_total": 0, "tasks_done": 0,
                    "completion_rate": 0, "messages": 0, "docs": 0,
                    "status_breakdown": {}, "msg_trend": []}
        return data


    @router.post("/api/org/paystack/connect")
    async def ps_connect(data: dict):
        """Save org Paystack secret key (admin/owner only)."""
        token      = data.get("token", "")
        secret_key = data.get("secret_key", "").strip()
        if not secret_key:
            raise HTTPException(400, "secret_key required.")
        if not (secret_key.startswith("sk_live_") or secret_key.startswith("sk_test_")):
            raise HTTPException(400, "Invalid Paystack key format.")
        sess, org_id = _org_admin_check(token)
        # Verify key works before saving
        try:
            result = await _ps_call(secret_key, "/balance")
            if not result.get("status"):
                raise HTTPException(400, "Paystack rejected this key. Check it and try again.")
        except _httpx.HTTPError:
            raise HTTPException(502, "Could not reach Paystack to verify key.")
        db.save_org_integration(org_id, "paystack", secret_key)
        return {"ok": True}


    @router.delete("/api/org/paystack/disconnect")
    async def ps_disconnect(token: str = ""):
        sess, org_id = _org_admin_check(token)
        db.delete_org_integration(org_id, "paystack")
        return {"ok": True}


    @router.get("/api/org/paystack/status")
    async def ps_status(token: str = ""):
        sess, org_id = _org_check(token)
        row = db.get_org_integration(org_id, "paystack")
        return {"connected": bool(row and row.get("secret_key"))}


    @router.get("/api/org/paystack/overview")
    async def ps_overview(token: str = ""):
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        # Fetch in parallel
        import asyncio
        txn_task = _ps_call(key, "/transaction", {"perPage": 50, "page": 1})
        bal_task  = _ps_call(key, "/balance")
        stl_task  = _ps_call(key, "/settlement", {"perPage": 5})
        txns_r, bal_r, stl_r = await asyncio.gather(txn_task, bal_task, stl_task, return_exceptions=True)

        txns   = txns_r.get("data", []) if isinstance(txns_r, dict) else []
        total  = txns_r.get("meta", {}).get("total", len(txns)) if isinstance(txns_r, dict) else 0
        bal    = bal_r.get("data", [{}])[0] if isinstance(bal_r, dict) else {}
        stl    = stl_r.get("data", []) if isinstance(stl_r, dict) else []

        success = [t for t in txns if t.get("status") == "success"]
        failed  = [t for t in txns if t.get("status") == "failed"]
        volume  = sum(t.get("amount", 0) for t in success)
        channels: dict = {}
        for t in success:
            ch = t.get("channel", "other")
            channels[ch] = channels.get(ch, 0) + 1

        pending_stl = next((s.get("settlement_date") for s in stl if s.get("status") == "pending"), None)
        pending_amt = next((s.get("total_amount", 0) for s in stl if s.get("status") == "pending"), 0)

        recent = []
        for t in txns[:8]:
            recent.append({
                "reference": t.get("reference", ""),
                "customer":  t.get("customer", {}).get("email", ""),
                "amount":    t.get("amount", 0),
                "channel":   t.get("channel", ""),
                "status":    t.get("status", ""),
                "paid_at":   t.get("paid_at") or t.get("created_at", ""),
                "card_type": t.get("authorization", {}).get("card_type", ""),
                "last4":     t.get("authorization", {}).get("last4", ""),
            })

        return {
            "volume":          volume,
            "txn_count":       total,
            "success_count":   len(success),
            "fail_count":      len(failed),
            "success_rate":    round(len(success) / len(txns) * 100, 1) if txns else 0,
            "available_bal":   bal.get("balance", 0),
            "currency":        bal.get("currency", "NGN"),
            "pending_stl_amt": pending_amt,
            "pending_stl_date":pending_stl,
            "channels":        channels,
            "recent_txns":     recent,
        }


    @router.get("/api/org/paystack/transactions")
    async def ps_transactions(token: str = "", page: int = 1, perPage: int = 20,
                               status: str = "", channel: str = ""):
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        params: dict = {"perPage": perPage, "page": page}
        if status:  params["status"]  = status
        if channel: params["channel"] = channel
        r = await _ps_call(key, "/transaction", params)
        txns = r.get("data", [])
        meta = r.get("meta", {})
        rows = []
        for t in txns:
            rows.append({
                "reference": t.get("reference", ""),
                "customer":  t.get("customer", {}).get("email", ""),
                "customer_name": (t.get("customer", {}).get("first_name", "") + " " +
                                  t.get("customer", {}).get("last_name", "")).strip(),
                "amount":    t.get("amount", 0),
                "channel":   t.get("channel", ""),
                "card_type": t.get("authorization", {}).get("card_type", ""),
                "last4":     t.get("authorization", {}).get("last4", ""),
                "fees":      t.get("fees", 0),
                "status":    t.get("status", ""),
                "paid_at":   t.get("paid_at") or t.get("created_at", ""),
            })
        return {"transactions": rows, "total": meta.get("total", len(rows)),
                "page": page, "perPage": perPage}


    @router.get("/api/org/paystack/balance")
    async def ps_balance(token: str = ""):
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        import asyncio
        bal_r, txn_r = await asyncio.gather(
            _ps_call(key, "/balance"),
            _ps_call(key, "/transaction", {"perPage": 10, "page": 1}),
            return_exceptions=True
        )
        bal   = bal_r.get("data", [{}])[0] if isinstance(bal_r, dict) else {}
        txns  = txn_r.get("data", []) if isinstance(txn_r, dict) else []
        history = []
        for t in txns:
            if t.get("status") == "success":
                history.append({
                    "date":    (t.get("paid_at") or t.get("created_at", ""))[:10],
                    "desc":    f"Payment from {t.get('customer',{}).get('email','')}",
                    "type":    "transaction",
                    "change":  t.get("amount", 0) - t.get("fees", 0),
                })
        return {
            "available": bal.get("balance", 0),
            "currency":  bal.get("currency", "NGN"),
            "history":   history,
        }


    @router.get("/api/org/paystack/settlements")
    async def ps_settlements(token: str = "", page: int = 1):
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        r = await _ps_call(key, "/settlement", {"perPage": 20, "page": page})
        rows = []
        for s in r.get("data", []):
            rows.append({
                "id":         s.get("id", ""),
                "settled_by": s.get("settled_by", ""),
                "status":     s.get("status", ""),
                "total_amount": s.get("total_amount", 0),
                "total_fees":   s.get("total_fees", 0),
                "txn_count":    s.get("total_transactions", 0),
                "settlement_date": s.get("settlement_date", ""),
                "bank_name":   s.get("bank_name", ""),
                "account_number": s.get("account_number", ""),
            })
        return {"settlements": rows, "total": r.get("meta", {}).get("total", len(rows))}


    # ── Invoices (Paystack "Payment Requests") ──────────────────────────
    # Endpoints/params verified against Paystack's own official Python
    # client docs (github.com/PaystackOSS/paystack-python), not just
    # assumed: POST /paymentrequest to create, GET /paymentrequest to list,
    # POST /paymentrequest/notify/{code} and /archive/{code}. Amounts are in
    # kobo everywhere else in this file (see _psNgn in js/app.js dividing by
    # 100 for display) -- naira-in from the client, *100 going out here.
    @router.get("/api/org/paystack/invoices")
    async def ps_invoices(token: str = "", page: int = 1, status: str = ""):
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        params: dict = {"perPage": 20, "page": page}
        if status:
            params["status"] = status
        r = await _ps_call(key, "/paymentrequest", params)
        rows = []
        for inv in r.get("data", []):
            cust = inv.get("customer") or {}
            if not isinstance(cust, dict):
                cust = {}
            rows.append({
                "id":                inv.get("id", ""),
                "request_code":      inv.get("request_code", ""),
                "offline_reference": inv.get("offline_reference", ""),
                "customer_email":    cust.get("email", ""),
                "customer_name":     (cust.get("first_name", "") + " " + cust.get("last_name", "")).strip(),
                "amount":            inv.get("amount", 0),
                "description":       inv.get("description", ""),
                "status":            inv.get("status", ""),
                "paid":              bool(inv.get("paid")),
                "due_date":          inv.get("due_date", ""),
                "created_at":        (inv.get("created_at") or inv.get("createdAt", ""))[:10],
            })
        return {"invoices": rows, "total": r.get("meta", {}).get("total", len(rows))}


    @router.post("/api/org/paystack/invoices/create")
    async def ps_invoice_create(data: dict):
        token = data.get("token", "")
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)

        email = sanitize_text(str(data.get("customer_email", "")).strip().lower(), 200)
        if not email or "@" not in email:
            raise HTTPException(400, "A valid customer email is required.")
        name = sanitize_text(str(data.get("customer_name", "")).strip(), 100)
        description = sanitize_text(str(data.get("description", "")).strip(), 300)
        if not description:
            raise HTTPException(400, "A description is required.")
        try:
            amount_naira = float(data.get("amount", 0))
        except (TypeError, ValueError):
            amount_naira = 0
        if amount_naira <= 0:
            raise HTTPException(400, "Amount must be greater than zero.")
        due_date = sanitize_text(str(data.get("due_date", "") or ""), 30)

        # Find-or-create the Paystack customer for this email. Paystack's
        # fetch-by-code endpoint also accepts an email in place of the code;
        # if that lookup fails for any reason (not found, or otherwise),
        # falling straight through to create is still correct -- worst case
        # is a harmless duplicate customer record on Paystack's side, never
        # a broken invoice.
        customer_code = None
        try:
            found = await _ps_call(key, f"/customer/{email}")
            if found.get("status") and found.get("data"):
                customer_code = found["data"].get("customer_code")
        except _httpx.HTTPError:
            pass
        if not customer_code:
            parts = name.split(" ", 1)
            created = await _ps_post(key, "/customer", {
                "email": email,
                "first_name": parts[0] if parts else "",
                "last_name": parts[1] if len(parts) > 1 else "",
            })
            if not created.get("status"):
                raise HTTPException(502, created.get("message") or "Could not create Paystack customer.")
            customer_code = created["data"]["customer_code"]

        body = {
            "customer": customer_code,
            "amount": round(amount_naira * 100),
            "description": description,
            "send_notification": True,
        }
        if due_date:
            body["due_date"] = due_date

        r = await _ps_post(key, "/paymentrequest", body)
        if not r.get("status"):
            raise HTTPException(502, r.get("message") or "Paystack rejected the invoice.")
        inv = r.get("data", {})
        return {"ok": True, "invoice": {
            "id":                inv.get("id", ""),
            "request_code":      inv.get("request_code", ""),
            "offline_reference": inv.get("offline_reference", ""),
            "amount":            inv.get("amount", 0),
            "status":            inv.get("status", ""),
        }}


    @router.post("/api/org/paystack/invoices/{code}/notify")
    async def ps_invoice_notify(code: str, data: dict):
        token = data.get("token", "")
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        r = await _ps_post(key, f"/paymentrequest/notify/{code}")
        if not r.get("status"):
            raise HTTPException(502, r.get("message") or "Could not send the invoice notification.")
        return {"ok": True}


    @router.post("/api/org/paystack/invoices/{code}/archive")
    async def ps_invoice_archive(code: str, data: dict):
        token = data.get("token", "")
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        r = await _ps_post(key, f"/paymentrequest/archive/{code}")
        if not r.get("status"):
            raise HTTPException(502, r.get("message") or "Could not archive the invoice.")
        return {"ok": True}


    @router.get("/api/org/paystack/customers")
    async def ps_customers(token: str = "", page: int = 1):
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        r = await _ps_call(key, "/customer", {"perPage": 20, "page": page})
        rows = []
        for c in r.get("data", []):
            rows.append({
                "id":          c.get("id", ""),
                "email":       c.get("email", ""),
                "name":        (c.get("first_name", "") + " " + c.get("last_name", "")).strip(),
                "phone":       c.get("phone", ""),
                "txn_count":   c.get("transactions", {}).get("total", 0) if isinstance(c.get("transactions"), dict) else 0,
                "total_spend": c.get("transactions", {}).get("total_volume", 0) if isinstance(c.get("transactions"), dict) else 0,
                "created_at":  c.get("createdAt", "")[:10],
            })
        return {"customers": rows, "total": r.get("meta", {}).get("total", len(rows))}


    @router.get("/api/org/paystack/refunds")
    async def ps_refunds(token: str = ""):
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        import asyncio
        ref_r, dis_r = await asyncio.gather(
            _ps_call(key, "/refund", {"perPage": 20}),
            _ps_call(key, "/dispute", {"perPage": 20}),
            return_exceptions=True
        )
        refunds = []
        for r in (ref_r.get("data", []) if isinstance(ref_r, dict) else []):
            refunds.append({
                "id":         r.get("id", ""),
                "transaction":r.get("transaction", ""),
                "customer":   r.get("customer_note", ""),
                "amount":     r.get("amount", 0),
                "status":     r.get("status", ""),
                "created_at": r.get("createdAt", "")[:10],
            })
        disputes = []
        for d in (dis_r.get("data", []) if isinstance(dis_r, dict) else []):
            disputes.append({
                "id":          d.get("id", ""),
                "reference":   d.get("transaction", {}).get("reference", "") if isinstance(d.get("transaction"), dict) else "",
                "amount":      d.get("transaction", {}).get("amount", 0) if isinstance(d.get("transaction"), dict) else 0,
                "status":      d.get("status", ""),
                "message":     d.get("resolution", "") or d.get("refund_note", ""),
                "created_at":  d.get("createdAt", "")[:10],
            })
        return {"refunds": refunds, "disputes": disputes}


    @router.get("/api/org/paystack/analytics")
    async def ps_analytics(token: str = ""):
        sess, org_id = _org_admin_check(token)
        key = _ps_key_for_org(org_id)
        r = await _ps_call(key, "/transaction", {"perPage": 100, "page": 1})
        txns = r.get("data", [])

        from collections import defaultdict
        by_day   = defaultdict(int)
        by_weekday = defaultdict(int)
        total_fees = 0
        success = failed = 0

        for t in txns:
            st  = t.get("status", "")
            amt = t.get("amount", 0)
            fee = t.get("fees", 0) or 0
            paid = (t.get("paid_at") or t.get("created_at") or "")[:10]
            if st == "success":
                success += 1
                total_fees += fee
                if paid:
                    by_day[paid] += amt
                    try:
                        import datetime
                        wd = datetime.date.fromisoformat(paid).strftime("%a")
                        by_weekday[wd] += amt
                    except Exception:
                        pass
            elif st == "failed":
                failed += 1

        total = success + failed
        return {
            "success": success,
            "failed":  failed,
            "success_rate": round(success / total * 100, 1) if total else 0,
            "total_fees":   total_fees,
            "by_day":  dict(sorted(by_day.items())[-14:]),
            "by_weekday": dict(by_weekday),
        }


    @router.post("/api/org/notifications/progress-report")
    async def org_progress_report(request: Request):
        """Send a weekly progress report email to all members of every org."""
        if CRON_SECRET:
            auth = request.headers.get("Authorization", "")
            if not hmac.compare_digest(auth, f"Bearer {CRON_SECRET}"):
                raise HTTPException(403, "Forbidden")

        if not db.is_available():
            return {"ok": False, "reason": "db_unavailable"}

        today     = datetime.date.today()
        week_ago  = (today - datetime.timedelta(days=7)).isoformat()
        period    = f"{week_ago} → {today.isoformat()}"
        sent, skipped = 0, 0

        for org in db.get_all_orgs():
            org_id   = org["id"]
            org_name = org["name"]
            members  = db.get_org_members(org_id)
            if not members:
                continue

            # Build stats for this org
            all_tasks  = db.get_org_tasks(org_id)
            all_goals  = db.get_org_goals(org_id)
            tasks_done = [t for t in all_tasks if t.get("status") == "done"]
            active_goals = [
                {"title": g["title"], "progress": g.get("progress", 0)}
                for g in all_goals if g.get("status") == "active"
            ]

            # Top contributors — count done tasks per assignee name
            contrib_map: dict = {}
            for t in tasks_done:
                name = t.get("assignee_name") or t.get("author_name") or "Unknown"
                contrib_map[name] = contrib_map.get(name, 0) + 1
            top_contributors = sorted(
                [{"name": n, "done": c} for n, c in contrib_map.items()],
                key=lambda x: x["done"], reverse=True
            )

            # Skip if there's nothing meaningful to report
            if not tasks_done and not active_goals:
                skipped += len(members)
                continue

            for m in members:
                if not m.get("email"):
                    skipped += 1
                    continue
                ok, _ = send_email(
                    m["email"],
                    f"Weekly progress report · {org_name}",
                    _email_org_progress_html(
                        m["name"], org_name, period,
                        len(tasks_done), len(all_tasks),
                        active_goals, top_contributors,
                    ),
                )
                sent += 1 if ok else 0
                skipped += 0 if ok else 1

        return {"ok": True, "sent": sent, "skipped": skipped}


    return router
