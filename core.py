"""
Shared primitives used by app.py and every module under routes/.

WHY THIS FILE EXISTS
--------------------
Route modules used to do `from app import get_session_from_token, sanitize_text, ...`,
which imports from a *partially loaded* app module. That only works if app.py's
`include_router(...)` calls sit physically below every helper the routers need —
an ordering constraint on a 12,000-line file that gets more fragile with every
router added (see the comment that used to live at the top of routes/tasks.py).

Everything here is leaf-level: it imports database.py and the standard library,
never app.py. That makes the dependency direction one-way

    core.py  ←  app.py
    core.py  ←  routes/*.py

so routers can be imported at the top of app.py like any normal module, and a
new router never needs to think about where in app.py it gets included.

NOTE ON _session_tokens: app.py does `from core import _session_tokens` and then
mutates it in ~20 places (admin session listing, revoke-on-logout, the stale
eviction sweep). That works because the import binds the *same dict object* —
mutation is shared. Never rebind it (`_session_tokens = {}`); clear it in place
(`.clear()`) if that is ever needed.
"""

from __future__ import annotations

import collections
import datetime
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import time
import uuid
from contextvars import ContextVar
from pathlib import Path

from fastapi import HTTPException, Request

import database as db
import rcache  # optional Redis layer (rate limiting + shared cache); degrades gracefully

log = logging.getLogger("sivarr")

# ═══════════════════════════════════════════════════════════════
#  PATHS & LIMITS
# ═══════════════════════════════════════════════════════════════

VERSION = "3"

# Railway persistent volume if mounted, else the repo root.
_BASE       = Path(os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", "."))
DATA_DIR    = _BASE / "data"
UPLOADS_DIR = _BASE / "uploads"
SHARES_DIR  = _BASE / "shares"
LOG_DIR     = _BASE / "logs"

MAX_MESSAGE_LEN = 2000    # max characters in a chat message

SESSION_TTL_DAYS = max(1, min(int(os.environ.get("SESSION_TTL_DAYS", "30")), 90))
SESSION_REVALIDATE_SECONDS = 30    # how often a cached session is re-checked against the DB


# ═══════════════════════════════════════════════════════════════
#  RATE LIMITING
# ═══════════════════════════════════════════════════════════════

RATE_LIMIT_WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW", 60))    # window in seconds


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
                data = json.loads(self._path.read_text(encoding="utf-8"))
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
                tmp = str(self._path) + f".{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
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

# How many proxies sit in front of the app (Railway = 1; add 1 for Cloudflare, etc.).
# The client can spoof the *leftmost* X-Forwarded-For entries, so we trust only the
# IP appended by our own outermost proxy — the Nth entry from the right.
_TRUSTED_PROXY_HOPS = max(1, int(os.environ.get("TRUSTED_PROXY_HOPS", "1")))


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            idx = len(parts) - _TRUSTED_PROXY_HOPS
            return parts[idx] if 0 <= idx < len(parts) else parts[0]
    return request.client.host if request.client else "unknown"


def get_client_key(request: Request, sid: str = "") -> str:
    """Get a unique key for rate limiting — prefer student ID, fall back to IP.
    Uses the proxy-appended client IP (spoof-resistant), not the raw leftmost XFF."""
    if sid:
        return f"student_{sid}"
    return f"ip_{_client_ip(request)}"


def check_rate_limit(key: str, limit: int, endpoint: str) -> None:
    """Raise 429 if rate limit exceeded. Uses PostgreSQL when available (multi-worker safe)."""
    full_key = f"{endpoint}_{key}"
    # Redis first (atomic, keeps rate-limit traffic off Postgres); falls back to
    # the DB limiter, then the per-worker in-memory limiter, if Redis is unavailable.
    allowed = rcache.rate_allow(full_key, limit, RATE_LIMIT_WINDOW)
    if allowed is None:
        if db.is_available():
            allowed = db.db_check_rate_limit(full_key, limit, RATE_LIMIT_WINDOW)
        else:
            allowed = limiter.is_allowed(full_key, limit)
    if not allowed:
        log.warning(f"Rate limit exceeded | key={key} | endpoint={endpoint}")
        raise HTTPException(
            status_code=429,
            detail=f"Too many requests. Please wait {RATE_LIMIT_WINDOW} seconds before trying again.",
            headers={"Retry-After": str(RATE_LIMIT_WINDOW)},
        )


# ═══════════════════════════════════════════════════════════════
#  INPUT VALIDATION
# ═══════════════════════════════════════════════════════════════

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def sanitize_text(text: str, max_len: int = MAX_MESSAGE_LEN) -> str:
    """
    Clean and validate text input.
    - Strips whitespace
    - Removes null bytes and control characters
    - Enforces max length

    NOTE: this does NOT strip path-traversal sequences (../, /, \\). For any
    value interpolated into a filesystem path (e.g. sid), use validate_sid().
    """
    if not text:
        return ""
    # Remove null bytes and non-printable control chars (keep newlines/tabs)
    text = _CONTROL_CHARS_RE.sub("", text)
    text = text.strip()
    if len(text) > max_len:
        text = text[:max_len]
        log.info(f"Input truncated to {max_len} chars")
    return text


# ── Password policy ──────────────────────────────────────────────
# Enforced on account creation and password reset only -- NEVER on sign-in.
# Existing accounts predate this policy and must still be able to log in; the
# place to upgrade them is a reset, not a lockout.
#
# bcrypt only hashes the first 72 bytes, so the max exists to bound input size
# rather than for strength. Keep MIN/MAX and the rule list in sync with the
# client-side checklist in js/app.js (_pwRules) -- the client is a courtesy,
# this function is the authority.
MIN_PASSWORD_LEN = 8
MAX_PASSWORD_LEN = 200


def password_policy_error(pw: str) -> str | None:
    """Return a human-readable reason the password is unacceptable, or None if
    it passes. The caller decides whether to surface the reason or a generic
    message (registration uses a generic one to avoid leaking which field
    failed; reset surfaces it, since the user is already authenticated by a
    single-use token)."""
    pw = pw or ""
    if len(pw) < MIN_PASSWORD_LEN:
        return f"Password must be at least {MIN_PASSWORD_LEN} characters."
    if len(pw) > MAX_PASSWORD_LEN:
        return f"Password must be {MAX_PASSWORD_LEN} characters or fewer."
    if not any(c.isupper() for c in pw):
        return "Password must include an uppercase letter."
    if not any(c.islower() for c in pw):
        return "Password must include a lowercase letter."
    if not any(c.isdigit() for c in pw):
        return "Password must include a number."
    return None


def safe_url(url: str, max_len: int = 500) -> str:
    """Return `url` if it is safe to render in an href, else "".

    sanitize_text() strips control characters but says nothing about the SCHEME,
    so `javascript:...` passes through it untouched and then executes when a
    victim clicks the rendered link. script-src still carries 'unsafe-inline'
    (Session 19), which is exactly what allows that.

    Two of these values are chosen by users, not by us:
      - a lecturer's live-class link (POST /api/acad/live/set), rendered to
        every student in the class
      - an opportunity's link (POST /api/opportunities), open to any account
        and rendered to everyone browsing the board

    js/core/dom.js's safeUrl() does the same check at render time. This is the
    authoritative half: it stops the value being stored at all.

    Whitespace and control characters are removed before the scheme test because
    browsers ignore them when resolving a URL, so "java\tscript:x" navigates
    fine and testing the raw string would miss it.
    """
    raw = sanitize_text(str(url or ""), max_len)
    probe = re.sub(r"[\x00-\x20]", "", raw).lower()
    if not probe or probe[0] in "/#?":
        return raw                                   # relative / anchor / query
    m = re.match(r"^([a-z][a-z0-9+.\-]*):", probe)
    if not m:
        return raw                                   # no scheme -> relative
    return raw if m.group(1) in ("http", "https", "mailto") else ""


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


# ═══════════════════════════════════════════════════════════════
#  ATOMIC JSON WRITE
# ═══════════════════════════════════════════════════════════════

def save_json(p, data):
    tmp = str(p) + f".{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    shutil.move(tmp, str(p))


def _load_json_file(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default


def _save_json_file(path: Path, data):
    # Unique tmp name per call: with 4 Gunicorn workers sharing this file, a fixed
    # ".tmp" name lets two processes race — the second one's .replace() fails with
    # FileNotFoundError because the first already consumed/renamed it away.
    tmp = str(path) + f".{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    Path(tmp).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    Path(tmp).replace(path)


# ═══════════════════════════════════════════════════════════════
#  TOKEN-BASED SESSION MANAGEMENT
# ═══════════════════════════════════════════════════════════════

_session_tokens: dict = {}   # token → {sid, name, email, expires, checked}


def create_session_token(sid: str, name: str, email: str,
                          user_agent: str = "", ip: str = "") -> str:
    token   = secrets.token_urlsafe(32)
    expires = datetime.datetime.utcnow() + datetime.timedelta(days=SESSION_TTL_DAYS)
    _session_tokens[token] = {"sid": sid, "name": name, "email": email, "expires": expires,
                              "checked": datetime.datetime.utcnow()}
    if db.is_available():
        db.create_db_session(token, sid, name, email, expires, user_agent, ip)
    return token


def create_session_token_for_existing(token: str, sid: str, name: str, email: str,
                                       user_agent: str = "", ip: str = "") -> None:
    """Register an already-issued token on this worker (cross-worker session recovery)."""
    expires = datetime.datetime.utcnow() + datetime.timedelta(days=SESSION_TTL_DAYS)
    _session_tokens[token] = {"sid": sid, "name": name, "email": email, "expires": expires,
                              "checked": datetime.datetime.utcnow()}
    if db.is_available():
        db.create_db_session(token, sid, name, email, expires, user_agent, ip)


def delete_all_sessions(sid: str, except_token: str | None = None) -> None:
    """Revoke every session for a user (optionally keeping the current one).
    Called on password change/reset. The DB delete is authoritative across workers;
    other workers drop their cached copy within SESSION_REVALIDATE_SECONDS via the
    re-check in get_session_from_token."""
    if db.is_available():
        db.delete_sessions_for_sid(sid, except_token)
    # Purge this worker's in-memory cache immediately.
    for tok in [t for t, e in list(_session_tokens.items())
                if e.get("sid") == sid and t != except_token]:
        _session_tokens.pop(tok, None)


def get_session_from_token(token: str) -> dict | None:
    if not token:
        return None
    # Check in-memory first
    entry = _session_tokens.get(token)
    if entry:
        if datetime.datetime.utcnow() >= entry["expires"]:
            del _session_tokens[token]
            return None
        # Periodically re-validate against the DB so a session revoked on another
        # worker (e.g. password reset) stops working within SESSION_REVALIDATE_SECONDS
        # instead of lingering in this worker's cache until its 30-day TTL.
        if db.is_available():
            checked = entry.get("checked")
            if checked is None or (datetime.datetime.utcnow() - checked).total_seconds() > SESSION_REVALIDATE_SECONDS:
                if db.get_db_session(token) is None:
                    del _session_tokens[token]
                    return None
                entry["checked"] = datetime.datetime.utcnow()
                db.touch_session_last_seen(token)
        return entry
    # Fallback: check DB and warm this worker's cache for subsequent requests
    if db.is_available():
        db_entry = db.get_db_session(token)
        if not db_entry:
            return None
        # Normalise the DB row to the in-memory shape before caching. get_db_session
        # returns a tz-aware "expires_at" (TIMESTAMPTZ); the in-memory cache + the
        # stale-eviction sweep expect a naive-UTC "expires". Caching the raw DB shape
        # makes the next lookup KeyError on entry["expires"] and the eviction sweep
        # treat the entry as already-expired (v.get("expires", now) <= now) — both of
        # which silently log the user out on reload. Map the key and drop the tzinfo.
        exp = db_entry.get("expires_at")
        if exp is not None and exp.tzinfo is not None:
            exp = exp.astimezone(datetime.timezone.utc).replace(tzinfo=None)
        entry = {
            "sid":     db_entry["sid"],
            "name":    db_entry["name"],
            "email":   db_entry["email"],
            "expires": exp,
            "checked": datetime.datetime.utcnow(),
        }
        _session_tokens[token] = entry
        db.touch_session_last_seen(token)
        return entry
    return None


def delete_session_token(token: str) -> None:
    _session_tokens.pop(token, None)
    if db.is_available():
        db.delete_db_session(token)


# Per-request token carried outside the JSON body (httpOnly cookie / Bearer
# header). app.py's _BearerTokenMiddleware does `_req_token.set(...)` on this
# exact object each request — importing it here binds the same ContextVar, so
# the set() in app.py and the get() in _resolve_token below see each other.
_req_token: ContextVar[str] = ContextVar("sivarr_req_token", default="")


def _resolve_token(data: dict) -> tuple[str, str]:
    """Return (sid, name) from a token or raise 401.

    Token source: the JSON body `token` first (current clients), then the
    per-request `_req_token` ContextVar (P3b: httpOnly cookie / Bearer header),
    so the backend authenticates cookie-only requests too — additive."""
    token = sanitize_text(str(data.get("token", "")), 100)
    if not token:
        token = sanitize_text(_req_token.get(""), 100)
    if not token:
        raise HTTPException(401, "Token required.")
    entry = get_session_from_token(token)
    if not entry:
        raise HTTPException(401, "Session expired.")
    return entry["sid"], entry["name"]


# ═══════════════════════════════════════════════════════════════
#  PER-USER JSON LISTS  (goals / tasks / habits / journal / docs)
# ═══════════════════════════════════════════════════════════════

def _load_user_list(sid: str, key: str) -> list:
    """Load a per-user JSON list (goals/tasks/journal). DB-first via the user_blobs
    table — atomic row writes, shared across workers/instances, included in Supabase
    backups, and free of the whole-file read-modify-write races the per-user JSON
    files had. Lazily migrates a legacy `{sid}_{key}.json` file into the DB on first
    access. Falls back to the file only when no DB is configured."""
    legacy = DATA_DIR / f"{sid}_{key}.json"
    if db.is_available():
        blob = db.get_user_blob(sid, key)
        if isinstance(blob, list):
            return blob
        if legacy.exists():
            try:
                items = json.loads(legacy.read_text(encoding="utf-8"))
                if isinstance(items, list):
                    db.save_user_blob(sid, key, items)
                    return items
            except Exception as exc:
                log.warning(f"{key} file→DB migrate failed for {sid[:8]}: {exc}")
        return []
    return json.loads(legacy.read_text(encoding="utf-8")) if legacy.exists() else []


def _save_user_list(sid: str, key: str, items: list) -> None:
    if db.is_available():
        db.save_user_blob(sid, key, items)
        return
    save_json(DATA_DIR / f"{sid}_{key}.json", items)


# ═══════════════════════════════════════════════════════════════
#  CONTENT-HASHED STATIC ASSETS
# ═══════════════════════════════════════════════════════════════
#
# /css/, /js/ and /static/ are served with `Cache-Control: immutable,
# max-age=31536000` (_StaticCacheMiddleware in app.py), so a browser that has
# loaded `/js/app.js?v=X` will NEVER re-check the server for that exact URL.
# The version string is the only thing that busts it.
#
# That used to be a hand-maintained date string (`?v=20260815a`) repeated across
# every <link>/<script> tag in index.html. Forgetting to bump it shipped a fix
# that silently never reached anyone who had opened the app before — which looks
# exactly like the fix not working, and cost several debugging rounds. Worse, the
# js/features/*.js and css/features/*.css tags added during the first extraction
# pass carried NO version string at all, so those files could never be updated in
# a returning user's browser.
#
# asset() replaces that with a hash of the file's actual bytes. Change a file and
# its URL changes automatically; don't change it and the URL stays stable so the
# cached copy keeps being used. There is nothing left to remember to bump.

_ASSET_HASHES: dict[str, str] = {}

# Re-stat files on every call in development so edits show up without a restart.
# In production the hash is computed once per worker and cached forever.
_ASSET_DEV_MODE = os.environ.get("RAILWAY_ENVIRONMENT", "production") == "development"


def _hash_file(fs_path: Path) -> str:
    h = hashlib.sha256()
    with open(fs_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:10]


_ASSET_URL_OVERRIDES: dict[str, str] = {}


def _dist_counterpart(url_path: str) -> Path | None:
    """For "/js/<rest>" or "/css/<rest>", the minified build at
    js/dist/<rest> or css/dist/<rest> (written by `npm run build`, see
    build.js), if `npm run build` has actually been run and produced one.
    None for anything outside js/ or css/ (static/, vendor bundles that are
    already prebuilt, anything with no build step) or if no build ran.

    Nothing needs to know this convention besides asset() and build.js —
    app.py's existing `/js` and `/css` StaticFiles mounts already serve
    js/dist/* and css/dist/* for free, since dist/ lives inside the
    directories they already mount. No route or template change needed.
    """
    parts = url_path.lstrip("/").split("/", 1)
    if len(parts) != 2 or parts[0] not in ("js", "css"):
        return None
    candidate = Path(parts[0]) / "dist" / parts[1]
    return candidate if candidate.is_file() else None


def asset(url_path: str) -> str:
    """Return `url_path` with a content-hash cache-buster appended.

        asset("/js/app.js")  ->  "/js/app.js?v=3f9a2b1c04"

    Falls back to the bare path if the file is missing, so a typo in a template
    degrades to an un-busted (but still working) URL rather than a 500.

    Outside dev mode, prefers a minified build counterpart over raw source
    when `npm run build` has produced one (see _dist_counterpart) — both the
    hash and the returned URL point at the built file in that case:

        asset("/js/app.js")  ->  "/js/dist/app.js?v=<hash-of-built-file>"

    Local dev never has js/dist//css/dist unless someone runs the build by
    hand, so this is a no-op there — dev always sees raw, readable source,
    without needing to check _ASSET_DEV_MODE explicitly for this part.
    """
    if not _ASSET_DEV_MODE and url_path in _ASSET_HASHES:
        resolved = _ASSET_URL_OVERRIDES.get(url_path, url_path)
        return f"{resolved}?v={_ASSET_HASHES[url_path]}"

    resolved_path = url_path
    fs_path = Path(url_path.lstrip("/"))
    if not _ASSET_DEV_MODE:
        dist = _dist_counterpart(url_path)
        if dist is not None:
            fs_path = dist
            resolved_path = "/" + str(dist).replace("\\", "/")

    try:
        digest = _hash_file(fs_path)
    except OSError:
        log.warning(f"asset() — file not found, serving unversioned: {url_path}")
        return url_path

    _ASSET_HASHES[url_path] = digest
    _ASSET_URL_OVERRIDES[url_path] = resolved_path
    return f"{resolved_path}?v={digest}"


# The set of assets the service worker precaches. Kept here so sw_cache_version()
# and js/sw.js's PRECACHE list can never drift apart.
SW_PRECACHE_ASSETS = [
    "/static/sivarrai.png",
    "/static/manifest.json",
    "/css/base.css",
    "/css/layout.css",
    "/css/panels.css",
    "/css/mobile.css",
    "/js/app.js",
]


def sw_cache_version() -> str:
    """A short hash over every precached asset's content hash.

    js/sw.js names its Cache Storage bucket `sivarr-<this>`, so changing any
    precached file changes the bucket name, which makes the service worker's
    activate handler drop the old bucket and re-fetch everything. That used to be
    a hand-incremented `sivarr-v8` that was easy to forget.
    """
    combined = "|".join(asset(p) for p in SW_PRECACHE_ASSETS)
    return hashlib.sha256(combined.encode()).hexdigest()[:10]
