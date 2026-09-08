"""
Sivarr database layer — PostgreSQL via psycopg2.
Set DATABASE_URL to a Supabase (or any Postgres) connection string.
Tables are created automatically on startup.
Falls back silently to JSON file storage when DATABASE_URL is not set.
"""

import json
import logging
import os
import pathlib
import time
import traceback
from contextlib import contextmanager

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pgpool

try:
    from pgvector.psycopg2 import register_vector
    PGVECTOR_PY_AVAILABLE = True
except ImportError:
    PGVECTOR_PY_AVAILABLE = False

log = logging.getLogger("sivarr")

SLOW_QUERY_MS = 200  # log any DB function that takes longer than this

_slow_query_count = 0  # cumulative count of queries over SLOW_QUERY_MS (for /api/health)

@contextmanager
def _timed(label: str):
    """Context manager — logs a warning when a DB call exceeds SLOW_QUERY_MS."""
    global _slow_query_count
    t = time.monotonic()
    yield
    ms = (time.monotonic() - t) * 1000
    if ms > SLOW_QUERY_MS:
        _slow_query_count += 1
        log.warning(f"SLOW_QUERY [{ms:.0f}ms] {label}")

_DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
# Railway sometimes prepends the word "railway" to the URL value (e.g. "railwaypostgresql://...")
# Strip it so psycopg2 receives a valid "postgresql://" URL.
if _DATABASE_URL.startswith("railway") and "://" in _DATABASE_URL:
    _DATABASE_URL = _DATABASE_URL[len("railway"):]
# Supabase and some providers use postgres:// — psycopg2 needs postgresql://
if _DATABASE_URL.startswith("postgres://"):
    _DATABASE_URL = _DATABASE_URL.replace("postgres://", "postgresql://", 1)

# ── Encryption-at-rest for stored third-party secret keys (org integrations) ──
# Enabled when APP_ENCRYPTION_KEY is set (a Fernet key, or any passphrase we derive
# one from). When unset, values are stored as-is so nothing breaks — a warning is
# logged on first use. Reads are back-compatible: only "enc:"-prefixed values are
# decrypted, so existing plaintext rows still work and re-encrypt on next save.
try:
    from cryptography.fernet import Fernet as _Fernet
except Exception:
    _Fernet = None

def _build_cipher():
    if _Fernet is None:
        return None
    raw = os.environ.get("APP_ENCRYPTION_KEY", "").strip()
    if not raw:
        return None
    try:
        return _Fernet(raw.encode())
    except Exception:
        import base64, hashlib
        return _Fernet(base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest()))

_cipher = _build_cipher()
_enc_warned = False

def _enc_secret(s: str) -> str:
    global _enc_warned
    if not s:
        return s
    if not _cipher:
        if not _enc_warned:
            _enc_warned = True
            log.warning("APP_ENCRYPTION_KEY not set — third-party secrets stored UNENCRYPTED at rest.")
        return s
    try:
        return "enc:" + _cipher.encrypt(s.encode()).decode()
    except Exception:
        return s

def _dec_secret(s):
    if not isinstance(s, str) or not s.startswith("enc:") or not _cipher:
        return s
    try:
        return _cipher.decrypt(s[4:].encode()).decode()
    except Exception:
        return s


def encryption_active() -> bool:
    """True when APP_ENCRYPTION_KEY is set + the Fernet cipher built — i.e.
    third-party/org secrets are encrypted at rest. Exposes no key material."""
    return _cipher is not None

def encrypt_secret(s: str) -> str:
    """Public wrapper so callers outside this module (e.g. app.py's Google
    Calendar OAuth token storage) can use the same at-rest encryption as
    org integration secret keys, instead of each rolling their own."""
    return _enc_secret(s)

def decrypt_secret(s):
    return _dec_secret(s)

# ThreadedConnectionPool (lock-protected) — NOT SimpleConnectionPool. FastAPI runs
# sync endpoints and asyncio.to_thread DB calls on a threadpool, so getconn/putconn
# are called from multiple threads concurrently; SimpleConnectionPool has no internal
# lock and corrupts its state under that (double-handed connections, PoolError) at load.
_pool: pgpool.ThreadedConnectionPool | None = None

# Pool size is env-tunable so it can be matched to the Supabase plan's connection
# limit without a code change. Client connections ≈ workers × DB_POOL_MAX, multiplexed
# by the Supabase transaction pooler onto its server slots. Default 5 → 4 workers × 5 =
# 20 client conns, sized for the free plan's pooler "Pool Size" of 15. Raise DB_POOL_MAX
# after upgrading Supabase (Pro has a larger pool).
_POOL_MIN = max(1, int(os.environ.get("DB_POOL_MIN", "1")))
_POOL_MAX = max(_POOL_MIN, int(os.environ.get("DB_POOL_MAX", "5")))


def is_available() -> bool:
    return bool(_DATABASE_URL)


_pool_error: str = ""   # stores the last pool creation failure reason


def _get_pool() -> pgpool.ThreadedConnectionPool | None:
    global _pool, _pool_error
    if _pool is not None:
        return _pool
    if not _DATABASE_URL:
        return None
    # Try plain URL first, then with sslmode=require (needed on some Railway configs)
    sep = "&" if "?" in _DATABASE_URL else "?"
    variants = [_DATABASE_URL]
    if "sslmode=" not in _DATABASE_URL:
        variants.append(_DATABASE_URL + sep + "sslmode=require")
        variants.append(_DATABASE_URL + sep + "sslmode=disable")
    for url in variants:
        try:
            _pool = pgpool.ThreadedConnectionPool(
                _POOL_MIN, _POOL_MAX, url, connect_timeout=10,
                keepalives=1, keepalives_idle=60,
                keepalives_interval=10, keepalives_count=5,
            )
            _pool_error = ""
            log.info(f"DB connection pool ready (variant: {'plain' if url == _DATABASE_URL else url.split(sep)[-1]})")
            return _pool
        except Exception as exc:
            _pool_error = str(exc)
            log.error(f"DB pool init failed [{url.split(sep)[-1] if sep in url else 'plain'}]: {exc}")
            _pool = None
    return _pool


def _get_conn():
    global _pool
    p = _get_pool()
    if not p:
        return None
    last_exc = None
    for attempt in range(3):
        try:
            return p.getconn()
        except pgpool.PoolError as exc:
            last_exc = exc
            if attempt < 2:
                time.sleep(0.05 * (2 ** attempt))  # 50 ms → 100 ms
                log.warning(f"DB pool exhausted (attempt {attempt + 1}/3) — retrying")
        except Exception as exc:
            log.error(f"_get_conn: {exc}")
            return None
    log.error(f"_get_conn: pool exhausted after 3 attempts: {last_exc}")
    return None


def _release(conn):
    p = _get_pool()
    if not p or not conn:
        return
    # conn.closed: 0=open, 1=closed, 2=broken (server-side kill)
    # If non-zero, discard from pool — do NOT return it for reuse.
    if conn.closed:
        try: p.putconn(conn, close=True)
        except Exception: pass
        return
    try:
        conn.rollback()
    except Exception:
        try: p.putconn(conn, close=True)
        except Exception: pass
        return
    p.putconn(conn)


def _discard(conn):
    """Drop a dead/broken connection from the pool — never return it for reuse."""
    p = _get_pool()
    if not conn:
        return
    try:
        if p:
            p.putconn(conn, close=True)
        else:
            conn.close()
    except Exception:
        try: conn.close()
        except Exception: pass


def _with_conn(label: str, fn, default):
    """Run fn(conn) with a single transparent retry on a dead pooled connection.

    The Supabase transaction pooler (PgBouncer) culls server-side connections,
    so a connection handed out by the pool can already be dead. The first query
    then raises OperationalError/InterfaceError even though the DB is healthy.
    We discard that connection and retry once on a fresh one. Any other error
    (or a second failure) degrades to `default`, matching the rest of the layer.

    `fn` must be idempotent — it may run twice. Used only for reads and
    idempotent upserts (ON CONFLICT), never for non-idempotent writes.
    """
    for attempt in (0, 1):
        conn = _get_conn()
        if not conn:
            return default
        try:
            return fn(conn)
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as exc:
            _discard(conn)
            conn = None
            if attempt == 0:
                log.warning(f"{label}: stale DB connection, retrying on a fresh one ({exc})")
                continue
            log.error(f"{label}: query failed after retry: {exc}")
            return default
        except Exception as exc:
            log.error(f"{label}: query failed: {exc}")
            return default
        finally:
            if conn is not None:
                _release(conn)
    return default


def pool_stats() -> dict:
    """Best-effort snapshot of pool usage for monitoring. Reads psycopg2
    ThreadedConnectionPool internals defensively (they're private but stable)."""
    p = _pool
    if p is None:
        return {"in_use": 0, "idle": 0, "max": 0}
    try:
        return {
            "in_use": len(getattr(p, "_used", {})),
            "idle":   len(getattr(p, "_pool", [])),
            "max":    getattr(p, "maxconn", 0),
        }
    except Exception:
        return {"in_use": 0, "idle": 0, "max": 0}


def slow_query_count() -> int:
    return _slow_query_count


def db_test() -> dict:
    """Return diagnostics: pool state + a live SELECT 1."""
    result = {
        "pool": _pool is not None,
        "db_url_set": bool(_DATABASE_URL),
        "pool_error": _pool_error or None,
        "ping": False,
        "error": None,
    }

    # If pool is broken, try a raw direct connect to surface the real error
    if not _pool and _DATABASE_URL:
        sep = "&" if "?" in _DATABASE_URL else "?"
        for label, url in [
            ("plain", _DATABASE_URL),
            ("sslmode=require", _DATABASE_URL + sep + "sslmode=require"),
            ("sslmode=disable", _DATABASE_URL + sep + "sslmode=disable"),
        ]:
            try:
                import psycopg2 as _pg
                c = _pg.connect(url, connect_timeout=8)
                c.cursor().execute("SELECT 1")
                c.close()
                result[f"direct_{label}"] = "OK"
                result["error"] = f"direct connect works with {label} but pool failed"
            except Exception as e:
                result[f"direct_{label}"] = str(e)

    conn = _get_conn()
    if not conn:
        if not result["error"]:
            result["error"] = result["pool_error"] or "could not get connection from pool"
        return result
    try:
        t0 = time.monotonic()
        conn.cursor().execute("SELECT 1")
        conn.rollback()
        result["ping"] = True
        result["latency_ms"] = round((time.monotonic() - t0) * 1000, 1)
    except Exception as exc:
        result["error"] = str(exc)
    finally:
        _release(conn)
    return result


# ── Schema ────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    sid           TEXT PRIMARY KEY,
    name          TEXT NOT NULL DEFAULT '',
    matric        TEXT NOT NULL DEFAULT '',
    email         TEXT          DEFAULT '',
    phone         TEXT          DEFAULT '',
    password_hash TEXT          DEFAULT '',
    created_at    TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS user_progress (
    sid        TEXT PRIMARY KEY REFERENCES users(sid) ON DELETE CASCADE,
    data       JSONB NOT NULL   DEFAULT '{}',
    updated_at TIMESTAMPTZ      DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
    token      TEXT PRIMARY KEY,
    sid        TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ   DEFAULT NOW(),
    expires_at TIMESTAMPTZ   NOT NULL,
    user_agent TEXT          NOT NULL DEFAULT '',
    ip         TEXT          NOT NULL DEFAULT '',
    last_seen  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_sid     ON user_sessions(sid);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);

-- Migrations for existing installs (Settings redesign: Sessions & Devices)
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS ip TEXT NOT NULL DEFAULT '';
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS spaces (
    id         TEXT PRIMARY KEY,
    user_sid   TEXT REFERENCES users(sid) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    icon       TEXT DEFAULT '🧩',
    color      TEXT DEFAULT '#4f6ef7',
    space_type TEXT DEFAULT 'personal',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spaces_user ON spaces(user_sid);

CREATE TABLE IF NOT EXISTS space_data (
    space_id   TEXT NOT NULL,
    user_sid   TEXT NOT NULL REFERENCES users(sid) ON DELETE CASCADE,
    data       JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ    DEFAULT NOW(),
    PRIMARY KEY (space_id, user_sid)
);
CREATE INDEX IF NOT EXISTS idx_space_data_user ON space_data(user_sid);

-- ── Agents Marketplace ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
    id                TEXT PRIMARY KEY,
    user_sid          TEXT REFERENCES users(sid) ON DELETE CASCADE,
    display_name      TEXT NOT NULL DEFAULT '',
    bio               TEXT DEFAULT '',
    speciality        JSONB DEFAULT '[]',
    profile_photo_url TEXT,
    stripe_account_id TEXT,
    status            TEXT DEFAULT 'applied',
    verified          BOOLEAN DEFAULT false,
    follower_count    INTEGER DEFAULT 0,
    total_downloads   INTEGER DEFAULT 0,
    avg_rating        NUMERIC(3,2) DEFAULT 0.0,
    pending_earnings  NUMERIC(10,2) DEFAULT 0.0,
    total_earned      NUMERIC(10,2) DEFAULT 0.0,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agents_user   ON agents(user_sid);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

CREATE TABLE IF NOT EXISTS agent_templates (
    id                TEXT PRIMARY KEY,
    agent_id          TEXT REFERENCES agents(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    short_description TEXT DEFAULT '',
    full_description  TEXT DEFAULT '',
    category          TEXT NOT NULL DEFAULT 'workspace',
    tags              JSONB DEFAULT '[]',
    thumbnail_color   TEXT DEFAULT '#4f6ef7',
    price             NUMERIC(8,2) DEFAULT 0.00,
    price_ngn         NUMERIC(10,2),
    contents          JSONB NOT NULL DEFAULT '{}',
    included_items    JSONB DEFAULT '[]',
    status            TEXT DEFAULT 'draft',
    download_count    INTEGER DEFAULT 0,
    avg_rating        NUMERIC(3,2) DEFAULT 0.0,
    review_count      INTEGER DEFAULT 0,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_tpl_agent  ON agent_templates(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tpl_status ON agent_templates(status);

CREATE TABLE IF NOT EXISTS template_downloads (
    id                TEXT PRIMARY KEY,
    template_id       TEXT REFERENCES agent_templates(id),
    buyer_sid         TEXT REFERENCES users(sid),
    agent_id          TEXT REFERENCES agents(id),
    gross_amount      NUMERIC(8,2) DEFAULT 0.00,
    sivarr_fee        NUMERIC(8,2) DEFAULT 0.00,
    agent_earnings    NUMERIC(8,2) DEFAULT 0.00,
    stripe_session_id TEXT,
    status            TEXT DEFAULT 'completed',
    downloaded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dl_buyer    ON template_downloads(buyer_sid);
CREATE INDEX IF NOT EXISTS idx_dl_template ON template_downloads(template_id);

CREATE TABLE IF NOT EXISTS template_reviews (
    id           TEXT PRIMARY KEY,
    template_id  TEXT REFERENCES agent_templates(id),
    reviewer_sid TEXT REFERENCES users(sid),
    rating       INTEGER CHECK (rating BETWEEN 1 AND 5),
    review_text  TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(template_id, reviewer_sid)
);

CREATE TABLE IF NOT EXISTS agent_follows (
    follower_sid TEXT REFERENCES users(sid),
    agent_id     TEXT REFERENCES agents(id),
    followed_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (follower_sid, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_follows_agent ON agent_follows(agent_id);

CREATE TABLE IF NOT EXISTS agent_payouts (
    id                 TEXT PRIMARY KEY,
    agent_id           TEXT REFERENCES agents(id),
    amount             NUMERIC(10,2) NOT NULL,
    stripe_transfer_id TEXT,
    status             TEXT DEFAULT 'pending',
    period_month       INTEGER,
    period_year        INTEGER,
    paid_at            TIMESTAMPTZ,
    created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_payouts_agent ON agent_payouts(agent_id);

-- ── Migrations for existing installs ──────────────────────────
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS price_ngn NUMERIC(10,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;

-- Session 20: user-facing TOTP 2FA. totp_secret holds a pending (unconfirmed)
-- or active base32 secret. totp_enabled only flips true once the user proves
-- possession of it via /api/auth/2fa/confirm. totp_recovery_codes is a JSONB
-- array of bcrypt hashes (never plaintext), same convention as password_hash.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_codes JSONB DEFAULT '[]';


CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token      TEXT PRIMARY KEY,
    sid        TEXT NOT NULL,
    email      TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used       BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS email_verify_tokens (
    token      TEXT PRIMARY KEY,
    sid        TEXT NOT NULL,
    email      TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used       BOOLEAN DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS feedback (
    id         SERIAL PRIMARY KEY,
    sid        TEXT NOT NULL,
    rating     SMALLINT,
    text       TEXT NOT NULL,
    page       TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Global app config (durable key-value, e.g. the USD→NGN rate) ────
CREATE TABLE IF NOT EXISTS app_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Multi-user Organisations ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS orgs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    owner_sid   TEXT REFERENCES users(sid) ON DELETE SET NULL,
    logo        TEXT DEFAULT '',
    description TEXT DEFAULT '',
    plan        TEXT DEFAULT 'free',
    settings    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orgs_owner ON orgs(owner_sid);

CREATE TABLE IF NOT EXISTS org_members (
    id          SERIAL PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_sid    TEXT NOT NULL REFERENCES users(sid) ON DELETE CASCADE,
    role        TEXT DEFAULT 'member',
    invited_by  TEXT,
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(org_id, user_sid)
);
CREATE INDEX IF NOT EXISTS idx_org_members_org  ON org_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_sid);

CREATE TABLE IF NOT EXISTS org_invites (
    token       TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    role        TEXT DEFAULT 'member',
    invited_by  TEXT,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_invites_org   ON org_invites(org_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON org_invites(email);

CREATE TABLE IF NOT EXISTS org_tasks (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT DEFAULT '',
    status       TEXT DEFAULT 'todo',
    priority     TEXT DEFAULT 'normal',
    assignee_sid TEXT REFERENCES users(sid) ON DELETE SET NULL,
    created_by   TEXT REFERENCES users(sid) ON DELETE SET NULL,
    project_id   TEXT,
    due_date     DATE,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_tasks_org      ON org_tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_org_tasks_project  ON org_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_org_tasks_assignee ON org_tasks(assignee_sid);

CREATE TABLE IF NOT EXISTS org_projects (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT DEFAULT '',
    status       TEXT DEFAULT 'active',
    color        TEXT DEFAULT '#41076B',
    created_by   TEXT REFERENCES users(sid) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_projects_org ON org_projects(org_id);

CREATE TABLE IF NOT EXISTS org_docs (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    content      TEXT DEFAULT '',
    yjs_state    TEXT DEFAULT '',
    created_by   TEXT REFERENCES users(sid) ON DELETE SET NULL,
    updated_by   TEXT REFERENCES users(sid) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_docs_org ON org_docs(org_id);
-- Kept for databases created before yjs_state moved into the CREATE above.
ALTER TABLE org_docs ADD COLUMN IF NOT EXISTS yjs_state TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS org_messages (
    id           SERIAL PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    channel      TEXT DEFAULT 'general',
    content      TEXT NOT NULL,
    author_sid   TEXT REFERENCES users(sid) ON DELETE SET NULL,
    author_name  TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_messages_org     ON org_messages(org_id);
CREATE INDEX IF NOT EXISTS idx_org_messages_channel ON org_messages(org_id, channel);

CREATE TABLE IF NOT EXISTS org_goals (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT DEFAULT '',
    type         TEXT DEFAULT 'okr',
    status       TEXT DEFAULT 'active',
    owner_sid    TEXT REFERENCES users(sid) ON DELETE SET NULL,
    due_date     DATE,
    progress     INTEGER DEFAULT 0,
    created_by   TEXT REFERENCES users(sid) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_goals_org ON org_goals(org_id);

CREATE TABLE IF NOT EXISTS org_key_results (
    id            TEXT PRIMARY KEY,
    goal_id       TEXT NOT NULL REFERENCES org_goals(id) ON DELETE CASCADE,
    org_id        TEXT NOT NULL,
    title         TEXT NOT NULL,
    target_value  FLOAT DEFAULT 100,
    current_value FLOAT DEFAULT 0,
    unit          TEXT DEFAULT '%',
    status        TEXT DEFAULT 'active',
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_kr_goal ON org_key_results(goal_id);
CREATE INDEX IF NOT EXISTS idx_org_kr_org  ON org_key_results(org_id);

CREATE TABLE IF NOT EXISTS org_founder (
    org_id        TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
    burn_rate     FLOAT DEFAULT 0,
    cash_balance  FLOAT DEFAULT 0,
    mrr           FLOAT DEFAULT 0,
    arr           FLOAT DEFAULT 0,
    funding_stage TEXT DEFAULT 'pre-seed',
    total_raised  FLOAT DEFAULT 0,
    investors     JSONB DEFAULT '[]',
    milestones    JSONB DEFAULT '[]',
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org_announcements (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',
    author_sid   TEXT REFERENCES users(sid) ON DELETE SET NULL,
    author_name  TEXT NOT NULL DEFAULT '',
    pinned       BOOLEAN DEFAULT FALSE,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_ann_org ON org_announcements(org_id);

CREATE TABLE IF NOT EXISTS org_integrations (
    org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,
    secret_key  TEXT NOT NULL DEFAULT '',
    public_key  TEXT NOT NULL DEFAULT '',
    meta        JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (org_id, provider)
);

-- Multi-worker rate limiting: one row per request hit, pruned by window
CREATE TABLE IF NOT EXISTS rate_limit_hits (
    key  TEXT        NOT NULL,
    ts   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rate_hits_key_ts ON rate_limit_hits(key, ts);

-- Multi-worker presence: upserted on each heartbeat ping
CREATE TABLE IF NOT EXISTS user_presence (
    sid       TEXT        NOT NULL,
    org_id    TEXT        NOT NULL,
    name      TEXT        NOT NULL DEFAULT '',
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sid, org_id)
);
CREATE INDEX IF NOT EXISTS idx_presence_org_seen ON user_presence(org_id, last_seen);

-- Short-lived one-time codes for Google OAuth token exchange (multi-worker safe)
CREATE TABLE IF NOT EXISTS google_exchange_codes (
    code       TEXT PRIMARY KEY,
    token      TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS user_blobs (
    sid        TEXT NOT NULL,
    key        TEXT NOT NULL,
    data       JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sid, key)
);

-- Personal tasks — a real table, one row per task, replacing the
-- user_blobs(key='tasks') JSONB-blob-per-user pattern. Mirrors org_tasks'
-- shape deliberately (same id/column/index conventions) since that table is
-- this codebase's own proven precedent for "per-entity personal-space data as
-- a real table." id is app-generated TEXT (uuid.uuid4().hex[:20] or the
-- client's own id), not DB-generated, matching org_tasks and every other
-- per-entity table in this schema.
CREATE TABLE IF NOT EXISTS tasks (
    id                  TEXT NOT NULL,
    sid                 TEXT NOT NULL REFERENCES users(sid) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    status              TEXT DEFAULT 'todo',
    done                BOOLEAN DEFAULT FALSE,
    date                TEXT DEFAULT '',
    time                TEXT DEFAULT '',
    priority            TEXT DEFAULT 'normal',
    type                TEXT DEFAULT 'other',
    goal_id             TEXT DEFAULT '',
    parent_id           TEXT DEFAULT '',
    recurrence          TEXT,
    recurrence_spawned  BOOLEAN DEFAULT FALSE,
    -- Fields the old whole-array sync silently dropped on every save (its
    -- per-item rebuild whitelist never included them, even though the client
    -- modal/detail-panel UI has always written them onto the local task
    -- object) — real columns now, closing that gap as part of this migration.
    description         TEXT DEFAULT '',
    assignee            TEXT DEFAULT '',
    summary             TEXT DEFAULT '',
    attach_name         TEXT DEFAULT '',
    -- Detail-panel "Notes" box — a distinct field from description in the
    -- client UI (js/features/tasks.js shOpenDetail), not an alias for it.
    notes               TEXT DEFAULT '',
    deleted_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    -- (sid, id), NOT a bare `id TEXT PRIMARY KEY` — client-generated ids are
    -- Date.now() timestamps (see js/features/tasks.js), unique per browser
    -- session but NOT globally unique. Two different users creating a task
    -- in the same millisecond would collide under a global PK. The old
    -- user_blobs-per-user JSONB blob never had this risk since each user's
    -- array was independent storage. Caught by testing this schema against a
    -- real Postgres instance before shipping, not by inspection: a same-id
    -- INSERT across two different sids failed exactly this way.
    -- (Note for future schema comments in this file: init_db() splits
    -- _SCHEMA on bare semicolons, including ones inside comments, so a
    -- semicolon used as punctuation here would silently truncate this
    -- statement. Learned that the hard way writing this very comment.)
    PRIMARY KEY (sid, id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_sid_deleted ON tasks(sid, deleted_at);

-- Same migration as `tasks` above (user_blobs(key='habits') blob -> real
-- table), same id-collision reasoning (client-generated ids, PRIMARY KEY on
-- (sid, id) not a bare id). completions is a JSONB array of "YYYY-MM-DD"
-- strings rather than a Postgres TEXT[] to match this schema's existing
-- convention for per-row arrays (see tags/speciality/likes above).
CREATE TABLE IF NOT EXISTS habits (
    id                  TEXT NOT NULL,
    sid                 TEXT NOT NULL REFERENCES users(sid) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    emoji               TEXT DEFAULT '',
    frequency           TEXT DEFAULT 'daily',
    streak              INTEGER DEFAULT 0,
    best_streak         INTEGER DEFAULT 0,
    completions         JSONB DEFAULT '[]',
    deleted_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sid, id)
);
CREATE INDEX IF NOT EXISTS idx_habits_sid_deleted ON habits(sid, deleted_at);

-- Personal goals (Session 16) -- same migration as tasks/habits above,
-- user_blobs(key='goals') JSONB-blob-per-user -> a real table, same
-- (sid, id) PRIMARY KEY reasoning. key_results stays a JSONB column
-- rather than its own child table (unlike org_goals/org_key_results,
-- which are separate tables): each key-result is small, always read and
-- written as part of its parent goal (routes/goals.py's kr/add,
-- kr/update, kr/delete endpoints all load the whole goal, mutate the
-- list, save the whole goal back), and search only needs to index
-- title/subject -- normalizing key_results into its own table would add
-- a join for no caller that needs one. goal_type default matches
-- add_goal's own default -- import_goals never sets it today (a
-- pre-existing gap, unrelated to this migration) so the column default
-- papers over that the same way tasks' column defaults already do for
-- tasks.py's own equivalent gaps.
-- due/mode/manual_pct/pct_override/milestones/habit_ids (2026-09) belong to
-- the newer merged Goals & Habits panel (js/features/habits.js), which has
-- its own goal-progress model (milestone-driven / manual / hybrid, tracked
-- per-goal in `mode`) independent of the older target_score/goal_type/
-- key_results OKR model above -- both coexist on the same row rather than
-- migrating one into the other, since existing goals created by the old
-- panel already have real target_score/goal_type/key_results data that
-- would otherwise need a lossy conversion. `due` mirrors `deadline` (kept
-- separate, not reusing the column, since the old panel's `deadline`
-- writes/reads shouldn't have to change shape). habit_ids/milestones are
-- JSONB for the same reason key_results is: small, always read/written
-- whole with the parent goal, no caller needs a join.
CREATE TABLE IF NOT EXISTS goals (
    id            TEXT NOT NULL,
    sid           TEXT NOT NULL REFERENCES users(sid) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    subject       TEXT DEFAULT '',
    target_score  INTEGER DEFAULT 70,
    deadline      TEXT DEFAULT '',
    created       TEXT DEFAULT '',
    progress      INTEGER DEFAULT 0,
    completed     BOOLEAN DEFAULT FALSE,
    goal_type     TEXT DEFAULT 'okr',
    key_results   JSONB DEFAULT '[]',
    due           TEXT DEFAULT '',
    mode          TEXT DEFAULT 'milestone',
    manual_pct    INTEGER DEFAULT 0,
    pct_override  INTEGER,
    milestones    JSONB DEFAULT '[]',
    habit_ids     JSONB DEFAULT '[]',
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sid, id)
);
CREATE INDEX IF NOT EXISTS idx_goals_sid_deleted ON goals(sid, deleted_at);
-- Existing production goals table predates the columns above -- CREATE
-- TABLE IF NOT EXISTS is a no-op there, so they need adding explicitly.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS due TEXT DEFAULT '';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'milestone';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS manual_pct INTEGER DEFAULT 0;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS pct_override INTEGER;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS milestones JSONB DEFAULT '[]';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS habit_ids JSONB DEFAULT '[]';

-- Personal docs (Session 16) -- same migration, user_blobs(key='docs') ->
-- a real table. Unlike tasks/goals/habits, docs has no per-entity
-- add/update/delete endpoints -- every mutation goes through
-- POST /api/docs/sync, which replaces the caller's entire doc list every
-- time (routes/docs_notes.py). replace_all_docs below is therefore this
-- table's primary write path, not a bulk-import fallback the way
-- replace_all_tasks is for tasks. id is TEXT: the sync path already sends
-- string ids, and import_notes' integer timestamp ids are coerced to str
-- at the route layer (str(d.get("id", "")), same coercion routes/search.py
-- already applies when reading doc ids for exactly this reason).
CREATE TABLE IF NOT EXISTS docs (
    id          TEXT NOT NULL,
    sid         TEXT NOT NULL REFERENCES users(sid) ON DELETE CASCADE,
    title       TEXT DEFAULT '',
    content     TEXT DEFAULT '',
    updated     TEXT DEFAULT '',
    deleted_at  TIMESTAMPTZ,
    -- Read-only public doc pages (GET /doc/{slug}), 2026-09-05. These live in
    -- the CREATE, not only in an ALTER below, because _SCHEMA is applied
    -- statement by statement in order: an ALTER placed above this table ran
    -- before it existed, failed ("relation docs does not exist"), was
    -- swallowed by init_db()'s per-statement handler, and left every fresh
    -- database with a docs table missing these columns. Production survived
    -- only because its table predated the change. CI, which provisions a
    -- clean database, failed every doc write with
    -- 'column "is_public" of relation "docs" does not exist'.
    is_public   BOOLEAN DEFAULT FALSE,
    public_slug TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sid, id)
);
CREATE INDEX IF NOT EXISTS idx_docs_sid_deleted ON docs(sid, deleted_at);
-- Kept for databases created before the columns moved into the CREATE above.
-- Harmless and idempotent now that they run AFTER the table exists.
ALTER TABLE docs ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE;
ALTER TABLE docs ADD COLUMN IF NOT EXISTS public_slug TEXT;
-- public_slug is opaque (client-generated, not title-derived) and looked up
-- across ALL users rather than scoped by sid like every other docs query,
-- hence a global unique index rather than reusing the (sid, id) PK.
CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_public_slug ON docs(public_slug) WHERE public_slug IS NOT NULL;

-- Spaced repetition (2026-09-05) — a real SM-2-lite schedule (ease/interval/
-- repetitions/due_date), shared by Study Deck AI flashcards and cards users
-- create from Notes/Journal entries (source_type/source_id just record
-- where a card came from -- nothing here reaches back into docs/journal to
-- read live content, so an edited/deleted source note doesn't need to sync
-- anything back to its cards). due_date is a plain ISO date string (not
-- TIMESTAMPTZ) -- reviews are a once-a-day granularity, same convention
-- tasks/goals already use for their own `date` field.
CREATE TABLE IF NOT EXISTS review_cards (
    id            TEXT NOT NULL,
    sid           TEXT NOT NULL REFERENCES users(sid) ON DELETE CASCADE,
    source_type   TEXT DEFAULT 'custom',
    source_id     TEXT DEFAULT '',
    front         TEXT DEFAULT '',
    back          TEXT DEFAULT '',
    ease          REAL DEFAULT 2.5,
    interval_days INTEGER DEFAULT 0,
    repetitions   INTEGER DEFAULT 0,
    due_date      TEXT DEFAULT '',
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sid, id)
);
CREATE INDEX IF NOT EXISTS idx_review_cards_sid_due ON review_cards(sid, due_date) WHERE deleted_at IS NULL;

-- In-app notification history, real per-item rows (id/title/body/read state)
-- rather than the ad-hoc push_subs JSON files send_push() previously wrote
-- to directly (DATA_DIR / f"{sid}_push_subs.json" — still used for the
-- web-push endpoint subscriptions themselves, unrelated data). A new table,
-- not a migration of anything — nothing server-side listed notification
-- history before this, the web app only ever synthesized a notification
-- list client-side from tasks/goals/habits already in the browser.
-- (init_db() splits this schema on bare semicolons, including ones inside
-- comments, so punctuation in any DDL comment must avoid them — see the
-- `tasks` table above for the same note, learned the same way twice now.)
CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT NOT NULL,
    sid         TEXT NOT NULL REFERENCES users(sid) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    body        TEXT DEFAULT '',
    url         TEXT DEFAULT '/app',
    read_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sid, id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_sid_created ON notifications(sid, created_at DESC);

-- Expo push tokens (mobile) — separate from the web-push subscription JSON
-- files since the delivery mechanism is entirely different (Expo's push
-- relay vs. raw Web Push/VAPID). send_push() dispatches to both from one
-- call site so nothing that already calls send_push() needs to change.
CREATE TABLE IF NOT EXISTS expo_push_tokens (
    sid         TEXT NOT NULL REFERENCES users(sid) ON DELETE CASCADE,
    token       TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sid, token)
);

CREATE TABLE IF NOT EXISTS community_posts (
    id          TEXT PRIMARY KEY,
    author_name TEXT NOT NULL DEFAULT 'Sivarr User',
    author_sid  TEXT,
    body        TEXT NOT NULL,
    category    TEXT DEFAULT 'general',
    tags        JSONB DEFAULT '[]',
    likes       JSONB DEFAULT '[]',
    replies     JSONB DEFAULT '[]',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comm_posts_created  ON community_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comm_posts_category ON community_posts(category);

CREATE TABLE IF NOT EXISTS opportunities (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    description  TEXT DEFAULT '',
    link         TEXT DEFAULT '',
    category     TEXT DEFAULT 'other',
    organisation TEXT DEFAULT '',
    location     TEXT DEFAULT '',
    deadline     TEXT DEFAULT '',
    submitted_by TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_opps_created  ON opportunities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opps_category ON opportunities(category);

-- Generic relational collections — replaces the global single-file JSON stores
-- (exams, classes, groups, topics, announcements, exam_results, exam_sessions).
-- One row per record => atomic per-record writes (no whole-file read-modify-write
-- races), shared across workers/instances, and covered by Supabase backups.
CREATE TABLE IF NOT EXISTS collections (
    collection TEXT   NOT NULL,
    item_id    TEXT   NOT NULL,
    owner      TEXT   NOT NULL DEFAULT '',   -- optional scope (class_id, student sid, …)
    data       JSONB  NOT NULL,
    seq        BIGSERIAL,                     -- preserves insertion order for list views
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (collection, item_id)
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(collection, owner);
CREATE INDEX IF NOT EXISTS idx_collections_seq   ON collections(collection, seq);

-- ── Full-text search: tasks + community posts (Session 5) ──────
-- Deliberately placed here, after every CREATE TABLE above, rather than
-- right after tasks/community_posts' own blocks (the usual convention for
-- a new index) or in the earlier "Migrations for existing installs"
-- section near the top of this string. Both of those run before tasks and
-- community_posts exist on a fresh install (init_db() executes every
-- statement in this string top to bottom, each idempotent) -- an
-- ALTER TABLE against a table that has not been created yet errors. Down
-- here it always runs after both tables exist, on a fresh install or an
-- existing one. GENERATED ALWAYS keeps the column in sync automatically on
-- every INSERT/UPDATE, so routes/tasks.py's write paths need no changes.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || coalesce(description, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_tasks_search ON tasks USING GIN(search_vector);

ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;
CREATE INDEX IF NOT EXISTS idx_comm_posts_search ON community_posts USING GIN(search_vector);

-- ── Full-text search: goals + docs (Session 16) ─────────────────
-- Same placement reasoning as the tasks/community_posts block above --
-- after every CREATE TABLE, so the ALTER always finds its table already
-- there on both a fresh install and an existing one.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || coalesce(subject, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_goals_search ON goals USING GIN(search_vector);

ALTER TABLE docs ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || coalesce(content, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_docs_search ON docs USING GIN(search_vector);

-- ── AI retrieval: embeddings (Session 9) ────────────────────────
-- Supabase supports the pgvector extension, but the JSON-file fallback
-- storage path (no DATABASE_URL) has no equivalent, so there is deliberately
-- no fallback here -- embeddings_available() below is how callers detect
-- that and skip retrieval entirely rather than crash. If CREATE EXTENSION
-- fails (privilege, or an unmanaged Postgres without pgvector installed),
-- the embedding column's type doesn't exist, so the CREATE TABLE right
-- after it fails too -- both are caught per-statement by init_db() and
-- logged, never fatal. One row per (sid, source_type, source_id) --
-- re-indexing an unchanged item is a no-op the caller decides on by
-- comparing chunk_text first (see get_embedding_chunk), not something
-- enforced here.
--
-- NOTE, found the hard way: init_db()'s statement splitter is a naive
-- a plain split on the semicolon character -- it has no concept of "inside a comment" or
-- "inside a string," so a literal semicolon anywhere in this comment block
-- (prose punctuation included) silently truncates a real statement and
-- turns the rest of a sentence into a bogus "statement" of its own. That
-- exact bug shipped here once already, in an earlier draft of this same
-- comment -- CREATE EXTENSION never actually ran, embeddings_available()
-- was permanently False even against a real pgvector-capable Postgres, and
-- it produced no exception anywhere, just quiet per-statement log lines
-- easy to miss. Never use a semicolon in a _SCHEMA comment, anywhere in
-- this file -- commas or double dashes only.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS embeddings (
    id          BIGSERIAL PRIMARY KEY,
    sid         TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id   TEXT NOT NULL,
    chunk_text  TEXT NOT NULL,
    embedding   VECTOR(768),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (sid, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_sid ON embeddings(sid);
-- ivfflat over cosine distance -- fine to build now even though the table
-- starts empty, pgvector accepts this, it just clusters better once there's
-- real data to reindex against later.
CREATE INDEX IF NOT EXISTS idx_embeddings_ann ON embeddings
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
"""


_schema_ready = False      # set True once init_db completes in this process
_schema_attempted = False  # set True the moment a run starts (single-flight)


def init_db() -> bool:
    """Create tables if they don't exist. Returns True on success.

    Single-flight per process: the schema run is attempted AT MOST ONCE. Hot
    paths (e.g. org_get) call this defensively, but must never block — so once a
    run has *started* (even if it is slow or stuck on a DDL lock, e.g. multiple
    workers contending on schema DDL at boot), later calls return immediately
    instead of re-running all ~69 DDL statements (which turned every org_get into
    a multi-second cross-region hang). The schema is also applied at startup.
    """
    global _schema_ready, _schema_attempted
    if _schema_ready or _schema_attempted:
        return _schema_ready
    if not is_available():
        log.info("DATABASE_URL not set — running on JSON file storage")
        return False
    _schema_attempted = True   # claim the single run BEFORE any slow DDL work
    conn = _get_conn()
    if not conn:
        return False
    # Execute each DDL statement in its own transaction. Running the whole
    # schema as one cur.execute() means a single failing statement rolls back
    # everything — so one bad ALTER could silently prevent later CREATE TABLEs
    # (e.g. google_exchange_codes) from ever being applied. Per-statement
    # isolation keeps one failure from cascading. All statements are idempotent
    # (CREATE/ALTER ... IF NOT EXISTS), so re-running is safe.
    statements = [s.strip() for s in _SCHEMA.split(";") if s.strip()]
    applied = failed = 0
    try:
        for stmt in statements:
            # Skip fragments that are only comments / whitespace.
            if all(not ln.strip() or ln.strip().startswith("--") for ln in stmt.splitlines()):
                continue
            try:
                with conn.cursor() as cur:
                    cur.execute(stmt)
                conn.commit()
                applied += 1
            except Exception as exc:
                conn.rollback()
                failed += 1
                log.warning(f"DB schema statement failed (continuing): {exc} | {stmt[:80]!r}")
    finally:
        _release(conn)
    if failed:
        log.error(f"DB schema ready with {failed} failed statement(s); {applied} applied")
    else:
        log.info(f"DB schema ready ({applied} statements)")
    # Mark ready once the full run has happened — even if some statements failed.
    # All statements are idempotent, so re-running won't fix a *persistently*
    # failing one; leaving _schema_ready False just re-ran all ~69 DDL on every
    # guarded call (org_get/org_create), turning each into 69 cross-region
    # round-trips (seconds per request → effective hang). The failed statements
    # are logged above for investigation; the per-request guard must stay cheap.
    _schema_ready = True
    return failed == 0


# ── Users ─────────────────────────────────────────────────────────

def user_exists(sid: str) -> bool:
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM users WHERE sid = %s", (sid,))
            return cur.fetchone() is not None
    return _with_conn(f"user_exists[{sid}]", _q, False)


def get_user(sid: str) -> dict | None:
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT sid, name, matric, email, phone, password_hash FROM users WHERE sid = %s",
                (sid,)
            )
            row = cur.fetchone()
        if not row:
            return None
        return {
            "sid": row[0], "name": row[1], "matric": row[2],
            "email": row[3], "phone": row[4], "password": row[5],
        }
    return _with_conn(f"get_user[{sid}]", _q, None)


def create_user(user: dict) -> None:
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO users (sid, name, matric, email, phone, password_hash)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (sid) DO NOTHING
            """, (
                user["sid"], user.get("name", ""), user.get("matric", ""),
                user.get("email", ""), user.get("phone", ""),
                user.get("password", ""),
            ))
        conn.commit()
    _with_conn(f"create_user[{user.get('sid')}]", _q, None)


# ── User Progress ──────────────────────────────────────────────────

def db_load_progress(sid: str) -> dict | None:
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT data FROM user_progress WHERE sid = %s", (sid,))
            row = cur.fetchone()
        if not row:
            return None
        return row[0] if isinstance(row[0], dict) else json.loads(row[0])
    return _with_conn(f"db_load_progress[{sid}]", _q, None)


def db_save_progress(sid: str, data: dict) -> None:
    payload = json.dumps(data)
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO user_progress (sid, data, updated_at)
                VALUES (%s, %s::jsonb, NOW())
                ON CONFLICT (sid) DO UPDATE SET
                    data       = EXCLUDED.data,
                    updated_at = NOW()
            """, (sid, payload))
        conn.commit()
    _with_conn(f"db_save_progress[{sid}]", _q, None)


# ── Sessions ──────────────────────────────────────────────────────

def create_db_session(token: str, sid: str, name: str, email: str, expires_at,
                       user_agent: str = "", ip: str = "") -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO user_sessions (token, sid, name, email, expires_at, user_agent, ip, last_seen)
                VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (token) DO UPDATE SET expires_at = EXCLUDED.expires_at
            """, (token, sid, name, email, expires_at, user_agent, ip))
        conn.commit()
    except Exception as exc:
        log.error(f"create_db_session failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def get_db_session(token: str) -> dict | None:
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("""
                SELECT sid, name, email, expires_at FROM user_sessions
                WHERE token = %s AND expires_at > NOW()
            """, (token,))
            row = cur.fetchone()
        if not row:
            return None
        return {"sid": row[0], "name": row[1], "email": row[2], "expires_at": row[3]}
    with _timed("get_db_session"):
        return _with_conn("get_db_session", _q, None)


def delete_db_session(token: str) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM user_sessions WHERE token = %s", (token,))
        conn.commit()
    finally:
        _release(conn)


def delete_sessions_for_sid(sid: str, except_token: str | None = None) -> int:
    """Revoke every session for a user (optionally keeping one current token).
    Used on password change/reset so stolen sessions stop working everywhere."""
    conn = _get_conn()
    if not conn:
        return 0
    try:
        with conn.cursor() as cur:
            if except_token:
                cur.execute("DELETE FROM user_sessions WHERE sid = %s AND token <> %s", (sid, except_token))
            else:
                cur.execute("DELETE FROM user_sessions WHERE sid = %s", (sid,))
            n = cur.rowcount
        conn.commit()
        return n
    except Exception as exc:
        log.error(f"delete_sessions_for_sid: {exc}")
        try: conn.rollback()
        except Exception: pass
        return 0
    finally:
        _release(conn)


def touch_session_last_seen(token: str) -> None:
    """Bump a session's last-active timestamp. Called at most once per
    SESSION_REVALIDATE_SECONDS per token (see core.get_session_from_token),
    not on every request -- failure here should never break the request."""
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE user_sessions SET last_seen = NOW() WHERE token = %s", (token,))
        conn.commit()
    except Exception as exc:
        log.error(f"touch_session_last_seen: {exc}")
        try: conn.rollback()
        except Exception: pass
    finally:
        _release(conn)


def list_sessions_for_sid(sid: str) -> list[dict]:
    """Self-service session list for Settings > Security > Sessions & Devices."""
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("""
                SELECT token, user_agent, ip, created_at, last_seen, expires_at
                FROM user_sessions
                WHERE sid = %s AND expires_at > NOW()
                ORDER BY COALESCE(last_seen, created_at) DESC
            """, (sid,))
            rows = cur.fetchall()
        return [
            {"token": r[0], "user_agent": r[1], "ip": r[2], "created_at": r[3],
             "last_seen": r[4], "expires_at": r[5]}
            for r in rows
        ]
    with _timed("list_sessions_for_sid"):
        return _with_conn("list_sessions_for_sid", _q, [])


def delete_session_for_sid(sid: str, token: str) -> bool:
    """Revoke one specific session, scoped to its owner so a caller can never
    revoke a session that isn't theirs even if a token were guessed."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM user_sessions WHERE sid = %s AND token = %s", (sid, token))
            n = cur.rowcount
        conn.commit()
        return n > 0
    except Exception as exc:
        log.error(f"delete_session_for_sid: {exc}")
        try: conn.rollback()
        except Exception: pass
        return False
    finally:
        _release(conn)


def cleanup_db_sessions() -> int:
    """Delete expired sessions. Returns number removed."""
    conn = _get_conn()
    if not conn:
        return 0
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM user_sessions WHERE expires_at <= NOW()")
            count = cur.rowcount
        conn.commit()
        if count:
            log.info(f"Cleaned up {count} expired sessions")
        return count
    except Exception as exc:
        log.error(f"cleanup_db_sessions failed: {exc}")
        conn.rollback()
        return 0
    finally:
        _release(conn)


def update_user(user: dict) -> None:
    """Update an existing user row (name, phone, etc.)."""
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE users SET name=%s, phone=%s
                WHERE sid=%s
            """, (user.get("name", ""), user.get("phone", ""), user["sid"]))
        conn.commit()
    except Exception as exc:
        log.error(f"update_user failed [{user.get('sid')}]: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def get_user_by_email(email: str) -> dict | None:
    addr = email.lower().strip()
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT sid, name, email, phone, password_hash FROM users WHERE email = %s",
                (addr,)
            )
            row = cur.fetchone()
        if not row:
            return None
        return {"sid": row[0], "name": row[1], "email": row[2], "phone": row[3], "password": row[4]}
    return _with_conn("get_user_by_email", _q, None)


# ── Password Reset & Email Verification Tokens ───────────────────

# In-memory fallback when DB is not available (tokens survive until server restart)
_reset_tokens_mem:  dict = {}
_verify_tokens_mem: dict = {}


def create_reset_token(sid: str, email: str) -> str:
    import secrets, datetime
    token   = secrets.token_urlsafe(32)
    expires = datetime.datetime.utcnow() + datetime.timedelta(hours=1)
    _reset_tokens_mem[token] = {"sid": sid, "email": email, "expires": expires, "used": False}
    conn = _get_conn()
    if not conn:
        return token
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO password_reset_tokens (token, sid, email, expires_at, used) "
                "VALUES (%s, %s, %s, %s, FALSE)",
                (token, sid, email, expires)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"create_reset_token failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)
    return token


def get_reset_token(token: str) -> dict | None:
    import datetime
    # In-memory first
    entry = _reset_tokens_mem.get(token)
    if entry and not entry["used"] and datetime.datetime.utcnow() < entry["expires"]:
        return entry
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT sid, email, expires_at, used FROM password_reset_tokens WHERE token = %s",
                (token,)
            )
            row = cur.fetchone()
        if not row:
            return None
        sid, email, expires_at, used = row
        if used or datetime.datetime.utcnow() > expires_at.replace(tzinfo=None):
            return None
        return {"sid": sid, "email": email, "expires": expires_at}
    return _with_conn("get_reset_token", _q, None)


def mark_reset_token_used(token: str) -> None:
    if token in _reset_tokens_mem:
        _reset_tokens_mem[token]["used"] = True
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE password_reset_tokens SET used = TRUE WHERE token = %s", (token,))
        conn.commit()
    except Exception as exc:
        log.error(f"mark_reset_token_used failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def create_email_verify_token(sid: str, email: str) -> str:
    import secrets, datetime
    token   = secrets.token_urlsafe(32)
    expires = datetime.datetime.utcnow() + datetime.timedelta(hours=24)
    _verify_tokens_mem[token] = {"sid": sid, "email": email, "expires": expires, "used": False}
    conn = _get_conn()
    if not conn:
        return token
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO email_verify_tokens (token, sid, email, expires_at, used) "
                "VALUES (%s, %s, %s, %s, FALSE)",
                (token, sid, email, expires)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"create_email_verify_token failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)
    return token


def get_email_verify_token(token: str) -> dict | None:
    import datetime
    entry = _verify_tokens_mem.get(token)
    if entry and not entry["used"] and datetime.datetime.utcnow() < entry["expires"]:
        return entry
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT sid, email, expires_at, used FROM email_verify_tokens WHERE token = %s",
                (token,)
            )
            row = cur.fetchone()
        if not row:
            return None
        sid, email, expires_at, used = row
        if used or datetime.datetime.utcnow() > expires_at.replace(tzinfo=None):
            return None
        return {"sid": sid, "email": email}
    return _with_conn("get_email_verify_token", _q, None)


def mark_email_verified(sid: str) -> None:
    # Update in-memory verify token entries
    for entry in _verify_tokens_mem.values():
        if entry.get("sid") == sid:
            entry["used"] = True
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET email_verified = TRUE WHERE sid = %s", (sid,))
            cur.execute("UPDATE email_verify_tokens SET used = TRUE WHERE sid = %s", (sid,))
        conn.commit()
    except Exception as exc:
        log.error(f"mark_email_verified failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def is_email_verified(sid: str) -> bool:
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT email_verified FROM users WHERE sid = %s", (sid,))
            row = cur.fetchone()
        return bool(row and row[0])
    return _with_conn(f"is_email_verified[{sid}]", _q, False)


# ── Global app config (durable key-value) ──────────────────────────

def get_config(key: str, default=None):
    """Read a global config value (e.g. 'naira_rate'). Returns default if unset/unavailable."""
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT value FROM app_config WHERE key = %s", (key,))
            row = cur.fetchone()
        return row[0] if row else default
    return _with_conn(f"get_config[{key}]", _q, default)


def set_config(key: str, value: str) -> bool:
    """Upsert a global config value. Returns True on success."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO app_config (key, value, updated_at) VALUES (%s, %s, NOW()) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
                (key, str(value)),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"set_config[{key}] failed: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def claim_capped_slot(key: str, cap: int) -> int | None:
    """Atomically claim one slot out of a hard cap stored under `key` in
    app_config (e.g. 'founding_100_count') -- for cohorts that must never
    exceed a fixed size (the Founding-100 plan had none of this: any caller
    could subscribe unlimited times, forever, since `hidden` was only ever
    checked in the public catalog listing, never at checkout).

    Single atomic statement, not read-then-write: the INSERT/ON CONFLICT
    happens under Postgres's own row lock, so two concurrent payments both
    landing on the last open slot can't both succeed -- one of them loses
    the race honestly instead of both incrementing past the cap. Returns the
    new count (the slot claimed) on success, or None if the cap was already
    reached and the caller must not grant the offer.

    Call this from the payment *verify* step, not subscribe/init -- a slot
    claimed at init and never paid for would strand real seats for nobody."""
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO app_config (key, value, updated_at) VALUES (%s, '1', NOW())
                   ON CONFLICT (key) DO UPDATE
                       SET value = (app_config.value::int + 1)::text, updated_at = NOW()
                       WHERE app_config.value::int < %s
                   RETURNING value::int""",
                (key, cap),
            )
            row = cur.fetchone()
        conn.commit()
        return row[0] if row else None
    except Exception as exc:
        log.error(f"claim_capped_slot[{key}] failed: {exc}")
        conn.rollback()
        return None
    finally:
        _release(conn)


def claim_scheduler_tick(job_name: str) -> bool:
    """True if this gunicorn worker should run job_name's current tick,
    False if another worker already claimed it this instant.

    gunicorn runs 4 UvicornWorker processes (Procfile: `-w 4`), each with
    its own independent APScheduler instance on an identical cron/interval
    schedule and no coordination of its own -- so every scheduled job (streak
    reminders, task-due alerts, embeddings indexing, ...) actually fires 4x
    per tick in production, confirmed from live logs. This is the fix: a
    transaction-scoped Postgres advisory lock (pg_try_advisory_xact_lock),
    released automatically on COMMIT rather than requiring an explicit
    unlock -- the first worker to reach this call for a given job_name wins
    the tick, the other 3 see the lock held and back off immediately. Using
    the transaction-scoped variant (not a session-level lock) matters
    because this connection returns to a pool afterward; a session-level
    lock would stay held on that pooled connection until something
    remembered to unlock it, eventually deadlocking every future tick.

    Fails open (returns True) when no DB is configured or the lock check
    itself errors -- an occasional duplicate run is the current status quo
    and far better than silently stopping every scheduled job from ever
    running again over a transient DB hiccup."""
    import zlib
    key = zlib.crc32(job_name.encode()) & 0x7FFFFFFF
    conn = _get_conn()
    if not conn:
        return True
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_xact_lock(%s)", (key,))
            won = cur.fetchone()[0]
        conn.commit()
        return bool(won)
    except Exception as exc:
        log.error(f"claim_scheduler_tick[{job_name}] failed: {exc}")
        conn.rollback()
        return True
    finally:
        _release(conn)


# ── Google OAuth exchange codes (multi-worker safe) ────────────────

def create_google_xcode(code: str, token: str) -> None:
    """Store a 10-minute one-time code that maps to a Sivarr session token."""
    import datetime
    conn = _get_conn()
    if not conn:
        raise RuntimeError("DB unavailable")
    expires = datetime.datetime.utcnow() + datetime.timedelta(seconds=600)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO google_exchange_codes (code, token, expires_at) VALUES (%s, %s, %s)",
                (code, token, expires)
            )
            # Also prune expired codes
            cur.execute("DELETE FROM google_exchange_codes WHERE expires_at < NOW()")
        conn.commit()
    except Exception as exc:
        conn.rollback()
        raise exc
    finally:
        _release(conn)


def pop_google_xcode(code: str) -> str | None:
    """Retrieve and delete a one-time exchange code. Returns the token or None."""
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT token FROM google_exchange_codes WHERE code = %s AND expires_at > NOW()",
                (code,)
            )
            row = cur.fetchone()
            if not row:
                return None
            cur.execute("DELETE FROM google_exchange_codes WHERE code = %s", (code,))
        conn.commit()
        return row[0]
    except Exception as exc:
        log.error(f"pop_google_xcode failed: {exc}")
        conn.rollback()
        return None
    finally:
        _release(conn)


def update_user_password(sid: str, hashed_pw: str) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET password_hash = %s WHERE sid = %s",
                (hashed_pw, sid)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"update_user_password failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


# ── 2FA (TOTP) ───────────────────────────────────────────────────

def get_user_totp(sid: str) -> dict | None:
    """Return {'secret', 'enabled', 'recovery_codes'} for sid, or None if the
    user doesn't exist. recovery_codes is a list of bcrypt hashes."""
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT totp_secret, totp_enabled, totp_recovery_codes FROM users WHERE sid = %s",
                (sid,)
            )
            row = cur.fetchone()
        if not row:
            return None
        codes = row[2] if isinstance(row[2], list) else (json.loads(row[2]) if row[2] else [])
        return {"secret": row[0] or "", "enabled": bool(row[1]), "recovery_codes": codes}
    return _with_conn(f"get_user_totp[{sid}]", _q, None)


def set_user_totp_pending(sid: str, secret: str) -> None:
    """Enrolment step 1: store an unconfirmed secret. Does not enable 2FA --
    that only happens once the user proves possession via a correct code."""
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET totp_secret = %s, totp_enabled = FALSE WHERE sid = %s",
                (secret, sid)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"set_user_totp_pending failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def enable_user_totp(sid: str, recovery_code_hashes: list) -> None:
    """Enrolment step 2 (after a correct code confirms the pending secret):
    flips totp_enabled and stores the one-time recovery code hashes."""
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET totp_enabled = TRUE, totp_recovery_codes = %s::jsonb WHERE sid = %s",
                (json.dumps(recovery_code_hashes), sid)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"enable_user_totp failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def disable_user_totp(sid: str) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET totp_enabled = FALSE, totp_secret = '', totp_recovery_codes = '[]'::jsonb WHERE sid = %s",
                (sid,)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"disable_user_totp failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def remove_user_recovery_code(sid: str, code_hash: str) -> None:
    """Burn one recovery code after use. Uses jsonb's `-` (remove matching
    array element) operator so this is a single atomic statement -- no
    read-modify-write race against a concurrent login from another device."""
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET totp_recovery_codes = totp_recovery_codes - %s WHERE sid = %s",
                (code_hash, sid)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"remove_user_recovery_code failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


# ── Spaces ────────────────────────────────────────────────────────

def get_spaces(user_sid: str) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, icon, color, space_type FROM spaces "
                "WHERE user_sid = %s ORDER BY created_at",
                (user_sid,)
            )
            return [
                {"id": r[0], "name": r[1], "icon": r[2], "color": r[3], "type": r[4]}
                for r in cur.fetchall()
            ]
    finally:
        _release(conn)


def save_space(user_sid: str, space: dict) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO spaces (id, user_sid, name, icon, color, space_type)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    name       = EXCLUDED.name,
                    icon       = EXCLUDED.icon,
                    color      = EXCLUDED.color,
                    space_type = EXCLUDED.space_type
            """, (
                space["id"], user_sid, space["name"],
                space.get("icon", "🧩"), space.get("color", "#4f6ef7"),
                space.get("type", "personal"),
            ))
        conn.commit()
    except Exception as exc:
        log.error(f"save_space failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def delete_space(user_sid: str, space_id: str) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM space_data WHERE space_id = %s AND user_sid = %s", (space_id, user_sid))
            cur.execute("DELETE FROM spaces WHERE id = %s AND user_sid = %s", (space_id, user_sid))
        conn.commit()
    finally:
        _release(conn)


# ── Space data ────────────────────────────────────────────────────

def get_all_spaces_with_data(user_sid: str) -> list:
    """Return all spaces for a user, each with its data blob."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.id, s.name, s.icon, s.color, s.space_type, sd.data
                FROM spaces s
                LEFT JOIN space_data sd
                       ON sd.space_id = s.id AND sd.user_sid = s.user_sid
                WHERE s.user_sid = %s
                ORDER BY s.created_at
            """, (user_sid,))
            return [
                {
                    "id": r[0], "name": r[1], "icon": r[2], "color": r[3],
                    "type": r[4], "data": (r[5] if isinstance(r[5], dict) else json.loads(r[5])) if r[5] else {}
                }
                for r in cur.fetchall()
            ]
    finally:
        _release(conn)


def save_space_data(user_sid: str, space_id: str, data: dict) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO space_data (space_id, user_sid, data, updated_at)
                VALUES (%s, %s, %s::jsonb, NOW())
                ON CONFLICT (space_id, user_sid) DO UPDATE SET
                    data       = EXCLUDED.data,
                    updated_at = NOW()
            """, (space_id, user_sid, json.dumps(data)))
        conn.commit()
    except Exception as exc:
        log.error(f"save_space_data failed [{space_id}]: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def get_space_data(user_sid: str, space_id: str) -> dict:
    conn = _get_conn()
    if not conn:
        return {}
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT data FROM space_data WHERE space_id = %s AND user_sid = %s",
                (space_id, user_sid)
            )
            row = cur.fetchone()
        if not row:
            return {}
        return row[0] if isinstance(row[0], dict) else json.loads(row[0])
    finally:
        _release(conn)


# ── Admin queries ─────────────────────────────────────────────────

def get_all_spaces_admin() -> list:
    """All spaces across all users — for admin dashboard only."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.id, s.name, s.icon, s.space_type, s.user_sid,
                       u.name AS owner_name, u.email AS owner_email, s.created_at
                FROM spaces s
                LEFT JOIN users u ON u.sid = s.user_sid
                ORDER BY s.created_at DESC
            """)
            rows = cur.fetchall()
        return [
            {
                "id": r[0], "name": r[1], "icon": r[2], "type": r[3],
                "user_sid": r[4], "owner": r[5] or "Unknown",
                "owner_email": r[6] or "",
                "created_at": r[7].isoformat() if r[7] else None,
            }
            for r in rows
        ]
    finally:
        _release(conn)


def get_all_sessions_admin() -> list:
    """All non-expired sessions — for admin dashboard only."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.token, s.sid, s.name, s.email, s.created_at, s.expires_at
                FROM user_sessions s
                WHERE s.expires_at > NOW()
                ORDER BY s.created_at DESC
            """)
            rows = cur.fetchall()
        return [
            {
                "token":      r[0][:12] + "…",
                "token_full": r[0],
                "sid":        r[1],
                "name":       r[2],
                "email":      r[3],
                "created_at": r[4].isoformat() if r[4] else None,
                "expires_at": r[5].isoformat() if r[5] else None,
            }
            for r in rows
        ]
    finally:
        _release(conn)


def delete_user_cascade(sid: str) -> bool:
    """Delete a user and all associated data (privacy/GDPR erasure).

    template_downloads.buyer_sid, template_reviews.reviewer_sid, and
    agent_follows.follower_sid reference users(sid) with no ON DELETE clause
    (Postgres defaults to RESTRICT), so without the explicit deletes below,
    the final DELETE FROM users raises a FK violation and this whole
    function silently returns False for anyone who ever bought/reviewed a
    template or followed a creator — i.e. GDPR deletion was broken for the
    marketplace's most active users. community_posts/feedback also have no
    FK at all and were never scrubbed.

    If the deleting user is themselves a marketplace creator (has an
    `agents` row), we anonymize that row and detach it from the user
    (user_sid = NULL) instead of letting it cascade-delete: agents.user_sid
    is ON DELETE CASCADE, and that cascade would otherwise hit the same
    RESTRICT wall on template_downloads/template_reviews/agent_follows/
    agent_payouts rows that belong to OTHER users (their purchase history,
    reviews, follows) — those are other people's data/accounting records,
    not this user's PII, and must survive this user's own deletion.
    """
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            # Creator profile: anonymize + detach rather than hard-delete, so
            # other users' purchase/review/payout history referencing this
            # creator's agent_id/templates isn't destroyed as a side effect.
            cur.execute(
                "UPDATE agents SET user_sid = NULL, display_name = %s, bio = '', "
                "profile_photo_url = NULL, stripe_account_id = NULL, status = 'deleted' "
                "WHERE user_sid = %s",
                ("[deleted user]", sid),
            )
            # This user's own actions on other people's content — their PII,
            # safe and correct to hard-delete.
            cur.execute("DELETE FROM template_downloads WHERE buyer_sid = %s", (sid,))
            cur.execute("DELETE FROM template_reviews   WHERE reviewer_sid = %s", (sid,))
            cur.execute("DELETE FROM agent_follows       WHERE follower_sid = %s", (sid,))
            cur.execute("DELETE FROM community_posts     WHERE author_sid = %s", (sid,))
            cur.execute("DELETE FROM feedback            WHERE sid = %s", (sid,))
            cur.execute("DELETE FROM space_data  WHERE user_sid = %s", (sid,))
            cur.execute("DELETE FROM spaces       WHERE user_sid = %s", (sid,))
            cur.execute("DELETE FROM user_sessions WHERE sid = %s", (sid,))
            cur.execute("DELETE FROM user_progress WHERE sid = %s", (sid,))
            # Personal data migrated into user_blobs (goals/tasks/journal/skills/
            # finance) and the user's own exam data in collections — purge both so
            # account deletion actually removes the user's PII (privacy/GDPR).
            cur.execute("DELETE FROM user_blobs    WHERE sid = %s", (sid,))
            cur.execute("DELETE FROM collections WHERE collection IN ('exam_results','exam_sessions') AND data->>'sid' = %s", (sid,))
            cur.execute("DELETE FROM users         WHERE sid = %s", (sid,))
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"delete_user_cascade failed [{sid}]: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def get_platform_stats() -> dict:
    """Aggregate platform-wide stats for the admin overview."""
    conn = _get_conn()
    if not conn:
        return {}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM users")
            total_users = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM spaces")
            total_spaces = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM user_sessions WHERE expires_at > NOW()")
            active_sessions = cur.fetchone()[0]
            cur.execute("""
                SELECT COUNT(*), space_type FROM spaces GROUP BY space_type
            """)
            spaces_by_type = {r[1]: r[0] for r in cur.fetchall()}
        return {
            "total_users":     total_users,
            "total_spaces":    total_spaces,
            "active_sessions": active_sessions,
            "spaces_by_type":  spaces_by_type,
        }
    finally:
        _release(conn)


# ── One-time migration from JSON files ────────────────────────────

def migrate_from_json(users_path: str, data_dir: str) -> tuple[int, int]:
    """
    Import existing users.json and *_progress.json files into the DB.
    Uses ON CONFLICT DO NOTHING so it's safe to call on every startup.
    Returns (users_migrated, progress_migrated).
    """
    if not is_available():
        return 0, 0

    conn = _get_conn()
    if not conn:
        return 0, 0

    users_count = 0
    progress_count = 0

    try:
        with conn.cursor() as cur:
            # ── Users ──
            up = pathlib.Path(users_path)
            if up.exists():
                try:
                    users = json.loads(up.read_text(encoding="utf-8"))
                    for sid, u in users.items():
                        cur.execute("""
                            INSERT INTO users (sid, name, matric, email, phone, password_hash)
                            VALUES (%s, %s, %s, %s, %s, %s)
                            ON CONFLICT (sid) DO NOTHING
                        """, (
                            u.get("sid", sid), u.get("name", ""), u.get("matric", ""),
                            u.get("email", ""), u.get("phone", ""), u.get("password", ""),
                        ))
                        users_count += 1
                except Exception as exc:
                    log.warning(f"User migration skipped: {exc}")

            # ── Progress ──
            for f in pathlib.Path(data_dir).glob("*_progress.json"):
                sid = f.stem.replace("_progress", "")
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                except Exception:
                    continue
                # Ensure parent user row exists (FK requirement)
                cur.execute("""
                    INSERT INTO users (sid, name, matric)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (sid) DO NOTHING
                """, (sid, data.get("name", sid), data.get("matric", "")))
                cur.execute("""
                    INSERT INTO user_progress (sid, data)
                    VALUES (%s, %s::jsonb)
                    ON CONFLICT (sid) DO NOTHING
                """, (sid, json.dumps(data)))
                progress_count += 1

        conn.commit()
        if users_count or progress_count:
            log.info(f"JSON migration: {users_count} users, {progress_count} progress records imported")
    except Exception as exc:
        log.error(f"Migration failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)

    return users_count, progress_count


# ═══════════════════════════════════════════════════════════════
#  AGENTS MARKETPLACE
# ═══════════════════════════════════════════════════════════════

def _row_to_agent(row) -> dict:
    if not row:
        return {}
    keys = ["id","user_sid","display_name","bio","speciality","profile_photo_url",
            "stripe_account_id","status","verified","follower_count","total_downloads",
            "avg_rating","pending_earnings","total_earned","created_at"]
    d = dict(zip(keys, row))
    d["speciality"] = d.get("speciality") or []
    d["avg_rating"] = float(d.get("avg_rating") or 0)
    d["pending_earnings"] = float(d.get("pending_earnings") or 0)
    d["total_earned"] = float(d.get("total_earned") or 0)
    if d.get("created_at"):
        d["created_at"] = str(d["created_at"])
    return d


def _row_to_template(row) -> dict:
    if not row:
        return {}
    keys = ["id","agent_id","name","short_description","full_description","category",
            "tags","thumbnail_color","price","price_ngn","contents","included_items","status",
            "download_count","avg_rating","review_count","created_at","updated_at"]
    d = dict(zip(keys, row))
    d["tags"] = d.get("tags") or []
    d["contents"] = d.get("contents") or {}
    d["included_items"] = d.get("included_items") or []
    d["price"] = float(d.get("price") or 0)
    d["price_ngn"] = float(d["price_ngn"]) if d.get("price_ngn") is not None else None
    d["avg_rating"] = float(d.get("avg_rating") or 0)
    for k in ("created_at","updated_at"):
        if d.get(k):
            d[k] = str(d[k])
    return d


# ── Agents ────────────────────────────────────────────────────

def get_agent_by_user(user_sid: str) -> dict:
    conn = _get_conn()
    if not conn:
        return {}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM agents WHERE user_sid = %s LIMIT 1", (user_sid,))
            return _row_to_agent(cur.fetchone())
    finally:
        _release(conn)


def get_agent_by_id(agent_id: str) -> dict:
    conn = _get_conn()
    if not conn:
        return {}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM agents WHERE id = %s LIMIT 1", (agent_id,))
            return _row_to_agent(cur.fetchone())
    finally:
        _release(conn)


def create_agent(agent: dict) -> dict:
    conn = _get_conn()
    if not conn:
        return agent
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO agents (id, user_sid, display_name, bio, speciality,
                    stripe_account_id, status)
                VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s)
                ON CONFLICT (id) DO NOTHING
            """, (
                agent["id"], agent["user_sid"], agent["display_name"],
                agent.get("bio",""), json.dumps(agent.get("speciality",[])),
                agent.get("stripe_account_id"), agent.get("status","applied"),
            ))
        conn.commit()
    except Exception as exc:
        log.error(f"create_agent: {exc}"); conn.rollback()
    finally:
        _release(conn)
    return agent


def update_agent(agent_id: str, fields: dict) -> bool:
    allowed = {"display_name","bio","speciality","profile_photo_url",
               "stripe_account_id","status","verified"}
    sets, vals = [], []
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k == "speciality":
            sets.append(f"{k} = %s::jsonb")
            vals.append(json.dumps(v))
        else:
            sets.append(f"{k} = %s")
            vals.append(v)
    if not sets:
        return False
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE agents SET {', '.join(sets)} WHERE id = %s",
                vals + [agent_id]
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_agent: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_all_agents(sort: str = "downloads") -> list:
    conn = _get_conn()
    if not conn:
        return []
    order = {
        "downloads": "total_downloads DESC",
        "rating":    "avg_rating DESC",
        "newest":    "created_at DESC",
    }.get(sort, "total_downloads DESC")
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT * FROM agents WHERE status = 'active' ORDER BY {order} LIMIT 100"
            )
            return [_row_to_agent(r) for r in cur.fetchall()]
    finally:
        _release(conn)


# ── Templates ─────────────────────────────────────────────────

def get_templates(category: str = None, sort: str = "popular",
                  free_only: bool = False, limit: int = 60) -> list:
    """Fetch published templates with agent info in a single JOIN — no N+1."""
    conn = _get_conn()
    if not conn:
        return []
    wheres = ["at.status = 'published'"]
    vals = []
    if category and category != "all":
        wheres.append("at.category = %s")
        vals.append(category)
    if free_only:
        wheres.append("at.price = 0")
    order = {
        "popular": "at.download_count DESC",
        "newest":  "at.created_at DESC",
        "rating":  "at.avg_rating DESC",
        "price":   "at.price ASC",
    }.get(sort, "at.download_count DESC")
    where_clause = " AND ".join(wheres)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                f"""SELECT at.*,
                           COALESCE(a.display_name, '') AS agent_name,
                           COALESCE(a.verified, FALSE)  AS agent_verified
                    FROM agent_templates at
                    LEFT JOIN agents a ON a.id = at.agent_id
                    WHERE {where_clause}
                    ORDER BY {order}
                    LIMIT %s""",
                vals + [limit]
            )
            rows = [dict(r) for r in cur.fetchall()]
        for r in rows:
            r.setdefault("tags", [])
            r.setdefault("contents", {})
            r.setdefault("included_items", [])
            r["price"]      = float(r.get("price") or 0)
            r["price_ngn"]  = float(r["price_ngn"]) if r.get("price_ngn") is not None else None
            r["avg_rating"] = float(r.get("avg_rating") or 0)
            for k in ("created_at", "updated_at"):
                if r.get(k):
                    r[k] = str(r[k])
        return rows
    finally:
        _release(conn)


def get_template_by_id(template_id: str) -> dict:
    conn = _get_conn()
    if not conn:
        return {}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM agent_templates WHERE id = %s LIMIT 1", (template_id,))
            return _row_to_template(cur.fetchone())
    finally:
        _release(conn)


def get_featured_template() -> dict:
    conn = _get_conn()
    if not conn:
        return {}
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT at.*, a.display_name as agent_name, a.verified as agent_verified
                FROM agent_templates at
                JOIN agents a ON a.id = at.agent_id
                WHERE at.status = 'published'
                ORDER BY at.download_count DESC LIMIT 1
            """)
            row = cur.fetchone()
            if not row:
                return {}
            cols = [desc[0] for desc in cur.description]
            return dict(zip(cols, row))
    finally:
        _release(conn)


def get_agent_templates(agent_id: str, include_drafts: bool = False) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            if include_drafts:
                cur.execute(
                    "SELECT * FROM agent_templates WHERE agent_id = %s ORDER BY created_at DESC",
                    (agent_id,)
                )
            else:
                cur.execute(
                    "SELECT * FROM agent_templates WHERE agent_id=%s AND status='published' ORDER BY created_at DESC",
                    (agent_id,)
                )
            return [_row_to_template(r) for r in cur.fetchall()]
    finally:
        _release(conn)


def create_template(tpl: dict) -> dict:
    conn = _get_conn()
    if not conn:
        return tpl
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO agent_templates
                    (id, agent_id, name, short_description, full_description, category,
                     tags, thumbnail_color, price, price_ngn, contents, included_items, status)
                VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s::jsonb,%s::jsonb,%s)
            """, (
                tpl["id"], tpl["agent_id"], tpl["name"],
                tpl.get("short_description",""), tpl.get("full_description",""),
                tpl.get("category","workspace"),
                json.dumps(tpl.get("tags",[])),
                tpl.get("thumbnail_color","#4f6ef7"),
                tpl.get("price",0),
                tpl.get("price_ngn"),  # None = auto-calculated client-side
                json.dumps(tpl.get("contents",{})),
                json.dumps(tpl.get("included_items",[])),
                tpl.get("status","draft"),
            ))
        conn.commit()
    except Exception as exc:
        log.error(f"create_template: {exc}"); conn.rollback()
    finally:
        _release(conn)
    return tpl


def update_template(template_id: str, agent_id: str, fields: dict) -> bool:
    allowed = {"name","short_description","full_description","category","tags",
               "thumbnail_color","price","price_ngn","contents","included_items","status"}
    json_cols = {"tags","contents","included_items"}
    sets, vals = [], []
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k in json_cols:
            sets.append(f"{k} = %s::jsonb")
            vals.append(json.dumps(v))
        else:
            sets.append(f"{k} = %s")
            vals.append(v)
    if not sets:
        return False
    sets.append("updated_at = NOW()")
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE agent_templates SET {', '.join(sets)} WHERE id=%s AND agent_id=%s",
                vals + [template_id, agent_id]
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_template: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def delete_template(template_id: str, agent_id: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM agent_templates WHERE id=%s AND agent_id=%s",
                (template_id, agent_id)
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"delete_template: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


# ── Downloads ─────────────────────────────────────────────────

def check_download(buyer_sid: str, template_id: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM template_downloads WHERE buyer_sid=%s AND template_id=%s LIMIT 1",
                (buyer_sid, template_id)
            )
            return cur.fetchone() is not None
    finally:
        _release(conn)


def count_downloads(buyer_sid: str) -> int:
    """Number of distinct templates a user has installed/owned (for plan caps)."""
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(DISTINCT template_id) FROM template_downloads WHERE buyer_sid=%s",
                (buyer_sid,)
            )
            row = cur.fetchone()
        return int(row[0]) if row else 0
    return _with_conn(f"count_downloads[{buyer_sid}]", _q, 0)


def record_download(dl: dict) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO template_downloads
                    (id, template_id, buyer_sid, agent_id, gross_amount, sivarr_fee,
                     agent_earnings, stripe_session_id, status)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT DO NOTHING
            """, (
                dl["id"], dl["template_id"], dl["buyer_sid"], dl["agent_id"],
                dl.get("gross_amount",0), dl.get("sivarr_fee",0), dl.get("agent_earnings",0),
                dl.get("stripe_session_id"), dl.get("status","completed"),
            ))
            # Increment download_count on the template
            cur.execute(
                "UPDATE agent_templates SET download_count = download_count + 1 WHERE id = %s",
                (dl["template_id"],)
            )
            # Increment total_downloads on the agent
            cur.execute(
                "UPDATE agents SET total_downloads = total_downloads + 1 WHERE id = %s",
                (dl["agent_id"],)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"record_download: {exc}"); conn.rollback()
    finally:
        _release(conn)


def check_payment_reference(reference: str) -> bool:
    """Return True if this payment reference was already processed."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM template_downloads WHERE stripe_session_id = %s LIMIT 1",
                (reference,)
            )
            return cur.fetchone() is not None
    finally:
        _release(conn)


def add_agent_earnings(agent_id: str, amount: float) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE agents
                SET pending_earnings = pending_earnings + %s,
                    total_earned     = total_earned + %s
                WHERE id = %s
            """, (amount, amount, agent_id))
        conn.commit()
    except Exception as exc:
        log.error(f"add_agent_earnings: {exc}"); conn.rollback()
    finally:
        _release(conn)


def get_agent_earnings(agent_id: str) -> dict:
    """Monthly earnings breakdown per template."""
    conn = _get_conn()
    if not conn:
        return {"monthly": [], "by_template": []}
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DATE_TRUNC('month', downloaded_at) as month,
                       COUNT(*) as downloads,
                       SUM(gross_amount) as gross,
                       SUM(sivarr_fee) as fee,
                       SUM(agent_earnings) as net
                FROM template_downloads
                WHERE agent_id = %s AND status = 'completed'
                GROUP BY 1 ORDER BY 1 DESC LIMIT 12
            """, (agent_id,))
            monthly = []
            for r in cur.fetchall():
                monthly.append({
                    "month": str(r[0])[:7] if r[0] else "",
                    "downloads": r[1], "gross": float(r[2] or 0),
                    "fee": float(r[3] or 0), "net": float(r[4] or 0),
                })
            cur.execute("""
                SELECT t.id, t.name, COUNT(*) as downloads,
                       SUM(d.agent_earnings) as net
                FROM template_downloads d
                JOIN agent_templates t ON t.id = d.template_id
                WHERE d.agent_id = %s AND d.status = 'completed'
                GROUP BY t.id, t.name ORDER BY net DESC
            """, (agent_id,))
            by_tpl = [{"id": r[0], "name": r[1],
                       "downloads": r[2], "net": float(r[3] or 0)}
                      for r in cur.fetchall()]
        return {"monthly": monthly, "by_template": by_tpl}
    finally:
        _release(conn)


def get_payouts(agent_id: str) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id,amount,stripe_transfer_id,status,period_month,period_year,paid_at,created_at "
                "FROM agent_payouts WHERE agent_id=%s ORDER BY created_at DESC LIMIT 24",
                (agent_id,)
            )
            cols = ["id","amount","stripe_transfer_id","status",
                    "period_month","period_year","paid_at","created_at"]
            return [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        _release(conn)


# ── Reviews ───────────────────────────────────────────────────

def add_review(review: dict) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO template_reviews (id, template_id, reviewer_sid, rating, review_text)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT (template_id, reviewer_sid) DO UPDATE
                SET rating=EXCLUDED.rating, review_text=EXCLUDED.review_text
            """, (review["id"], review["template_id"], review["reviewer_sid"],
                  review["rating"], review.get("review_text","")))
            # Recompute avg_rating + review_count on the template
            cur.execute("""
                UPDATE agent_templates SET
                    avg_rating   = (SELECT AVG(rating) FROM template_reviews WHERE template_id=%s),
                    review_count = (SELECT COUNT(*) FROM template_reviews WHERE template_id=%s)
                WHERE id = %s
            """, (review["template_id"], review["template_id"], review["template_id"]))
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"add_review: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_template_reviews(template_id: str, limit: int = 10) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT r.id, r.rating, r.review_text, r.created_at,
                       u.name as reviewer_name
                FROM template_reviews r
                JOIN users u ON u.sid = r.reviewer_sid
                WHERE r.template_id = %s
                ORDER BY r.created_at DESC LIMIT %s
            """, (template_id, limit))
            cols = ["id","rating","review_text","created_at","reviewer_name"]
            rows = []
            for row in cur.fetchall():
                d = dict(zip(cols, row))
                # Anonymise: first name + last initial
                parts = (d.get("reviewer_name") or "").split()
                if len(parts) >= 2:
                    d["reviewer_name"] = f"{parts[0]} {parts[-1][0]}."
                d["created_at"] = str(d["created_at"])
                rows.append(d)
            return rows
    finally:
        _release(conn)


def get_agent_reviews(agent_id: str) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT r.id, r.rating, r.review_text, r.created_at,
                       u.name as reviewer_name, t.name as template_name
                FROM template_reviews r
                JOIN users u ON u.sid = r.reviewer_sid
                JOIN agent_templates t ON t.id = r.template_id
                WHERE t.agent_id = %s
                ORDER BY r.created_at DESC LIMIT 50
            """, (agent_id,))
            cols = ["id","rating","review_text","created_at","reviewer_name","template_name"]
            rows = []
            for row in cur.fetchall():
                d = dict(zip(cols, row))
                parts = (d.get("reviewer_name") or "").split()
                if len(parts) >= 2:
                    d["reviewer_name"] = f"{parts[0]} {parts[-1][0]}."
                d["created_at"] = str(d["created_at"])
                rows.append(d)
            return rows
    finally:
        _release(conn)


# ── Follows ───────────────────────────────────────────────────

def follow_agent(follower_sid: str, agent_id: str) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO agent_follows (follower_sid, agent_id)
                VALUES (%s,%s) ON CONFLICT DO NOTHING
            """, (follower_sid, agent_id))
            cur.execute(
                "UPDATE agents SET follower_count = follower_count + 1 WHERE id=%s",
                (agent_id,)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"follow_agent: {exc}"); conn.rollback()
    finally:
        _release(conn)


def unfollow_agent(follower_sid: str, agent_id: str) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM agent_follows WHERE follower_sid=%s AND agent_id=%s",
                (follower_sid, agent_id)
            )
            cur.execute(
                "UPDATE agents SET follower_count = GREATEST(0, follower_count - 1) WHERE id=%s",
                (agent_id,)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"unfollow_agent: {exc}"); conn.rollback()
    finally:
        _release(conn)


def is_following(follower_sid: str, agent_id: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM agent_follows WHERE follower_sid=%s AND agent_id=%s LIMIT 1",
                (follower_sid, agent_id)
            )
            return cur.fetchone() is not None
    finally:
        _release(conn)


def get_agents_with_pending_earnings(min_amount: float = 10.0) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, stripe_account_id, pending_earnings FROM agents "
                "WHERE status='active' AND pending_earnings >= %s",
                (min_amount,)
            )
            return [{"id": r[0], "stripe_account_id": r[1], "pending_earnings": float(r[2])}
                    for r in cur.fetchall()]
    finally:
        _release(conn)


def record_payout(payout: dict) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO agent_payouts
                    (id, agent_id, amount, stripe_transfer_id, status, period_month, period_year, paid_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,NOW())
            """, (
                payout["id"], payout["agent_id"], payout["amount"],
                payout.get("stripe_transfer_id"), payout.get("status","paid"),
                payout.get("period_month"), payout.get("period_year"),
            ))
            cur.execute(
                "UPDATE agents SET pending_earnings = 0 WHERE id=%s",
                (payout["agent_id"],)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"record_payout: {exc}"); conn.rollback()
    finally:
        _release(conn)


# ── Org functions ────────────────────────────────────────────────

def create_org(owner_sid: str, name: str, org_id: str, owner_name: str = "") -> tuple[bool, str]:
    """Create org + add owner as member. Returns (ok, error_message)."""
    conn = _get_conn()
    if not conn:
        return False, "could not get DB connection"
    try:
        with conn.cursor() as cur:
            # Ensure owner row exists in users to avoid FK violation
            cur.execute(
                "INSERT INTO users (sid, name) VALUES (%s, %s) ON CONFLICT (sid) DO NOTHING",
                (owner_sid, owner_name or owner_sid)
            )
            cur.execute(
                "INSERT INTO orgs (id, name, owner_sid) VALUES (%s, %s, %s) ON CONFLICT (id) DO NOTHING",
                (org_id, name, owner_sid)
            )
            cur.execute(
                "INSERT INTO org_members (org_id, user_sid, role, invited_by) VALUES (%s, %s, 'owner', %s) ON CONFLICT (org_id, user_sid) DO NOTHING",
                (org_id, owner_sid, owner_sid)
            )
        conn.commit()
        return True, ""
    except Exception as exc:
        err = str(exc)
        log.error(f"create_org: {err}\n{traceback.format_exc()}")
        conn.rollback()
        return False, err
    finally:
        _release(conn)


# ── User blobs (generic key/value JSON store per user) ────────

def save_user_blob(sid: str, key: str, data: dict) -> None:
    import json as _json
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO user_blobs (sid, key, data, updated_at)
                   VALUES (%s, %s, %s, NOW())
                   ON CONFLICT (sid, key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()""",
                (sid, key, _json.dumps(data))
            )
        conn.commit()
    except Exception as exc:
        log.error(f"save_user_blob failed [{sid}/{key}]: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def get_user_blob(sid: str, key: str) -> dict | None:
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT data FROM user_blobs WHERE sid = %s AND key = %s", (sid, key))
            row = cur.fetchone()
        return row[0] if row else None
    finally:
        _release(conn)


def get_sids_with_blob_key(key: str) -> list[str]:
    """Every sid that has a user_blobs row under `key` — for background jobs that
    need to sweep all users' data of one kind (e.g. purging expired trash)."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT sid FROM user_blobs WHERE key = %s", (key,))
            return [r[0] for r in cur.fetchall()]
    finally:
        _release(conn)


# ── Personal tasks (real table, per-entity ops) ───────────────
# Same conventions as org_tasks (see that block above): app-generated TEXT id,
# plain _get_conn()/_release() (no _with_conn — that helper is documented as
# reads/idempotent-upserts only, and these writes aren't idempotent),
# RealDictCursor for row reads, partial updates via an explicit column
# whitelist, every write scoped by "AND sid=%s" as a defense-in-depth tenant
# check even though sid is already the primary lookup key.

_TASK_COLUMNS = {
    "title", "status", "done", "date", "time", "priority", "type",
    "goal_id", "parent_id", "recurrence", "recurrence_spawned",
    "description", "assignee", "summary", "attach_name", "notes",
    # deleted_at is writable through the generic whitelist too, not just via
    # soft_delete_task()/undelete_task() below — replace_all_tasks() (the
    # bulk /api/tasks/sync path, kept for CSV import and as a fallback) needs
    # to persist a client-set tombstone the same way it persists every other
    # field. Omitting it here would silently drop soft-deletes on every bulk
    # sync — the exact bug the soft-delete feature was built to prevent.
    "deleted_at",
}


def _row_to_task(row: dict) -> dict:
    """psycopg2 hands back TIMESTAMPTZ columns as real datetime objects, but
    every other storage path in this app (the JSON-fallback branch, the old
    user_blobs JSONB blob, the client's own localStorage) has always dealt in
    plain ISO strings — deleted_at in particular gets compared/parsed as a
    string throughout routes/tasks.py and js/features/tasks.js. Normalize
    here once so callers never have to care which backend served the row."""
    d = dict(row)
    for key in ("deleted_at", "created_at", "updated_at"):
        if d.get(key) is not None and hasattr(d[key], "isoformat"):
            d[key] = d[key].isoformat()
    return d


def get_tasks(sid: str, include_deleted: bool = False) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if include_deleted:
                cur.execute("SELECT * FROM tasks WHERE sid=%s ORDER BY created_at", (sid,))
            else:
                cur.execute("SELECT * FROM tasks WHERE sid=%s AND deleted_at IS NULL ORDER BY created_at", (sid,))
            return [_row_to_task(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_tasks: {exc}")
        return []
    finally:
        _release(conn)


def get_trashed_tasks(sid: str) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM tasks WHERE sid=%s AND deleted_at IS NOT NULL ORDER BY deleted_at DESC", (sid,))
            return [_row_to_task(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_trashed_tasks: {exc}")
        return []
    finally:
        _release(conn)


def search_tasks(sid: str, q: str, limit: int = 15) -> list:
    """Full-text search over this user's tasks, ranked by relevance via the
    tasks.search_vector generated column + its GIN index (see _SCHEMA).
    Soft-deleted tasks are excluded in the WHERE clause here rather than by
    the caller, unlike the JSON-fallback path routes/search.py falls back to
    when no DB is configured, which still filters deleted_at in Python."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, title, status, done, description,
                          ts_rank(search_vector, plainto_tsquery('english', %s)) AS rank
                   FROM tasks
                   WHERE sid=%s AND deleted_at IS NULL
                     AND search_vector @@ plainto_tsquery('english', %s)
                   ORDER BY rank DESC
                   LIMIT %s""",
                (q, sid, q, limit),
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"search_tasks: {exc}")
        return []
    finally:
        _release(conn)


def get_task(task_id: str, sid: str) -> dict | None:
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM tasks WHERE id=%s AND sid=%s", (task_id, sid))
            row = cur.fetchone()
            return _row_to_task(row) if row else None
    except Exception as exc:
        log.error(f"get_task: {exc}")
        return None
    finally:
        _release(conn)


def create_task(sid: str, task_id: str, title: str, **fields) -> bool:
    """fields may include any of _TASK_COLUMNS; unknown keys are ignored. id/
    sid/title always come from the positional args, never from **fields, even
    if a caller's dict happens to still contain them — see replace_all_tasks'
    identical guard for why this matters."""
    cols = {k: v for k, v in fields.items() if k in _TASK_COLUMNS and k not in ("id", "sid", "title")}
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            names = ["id", "sid", "title"] + list(cols.keys())
            vals  = [task_id, sid, title] + list(cols.values())
            placeholders = ", ".join(["%s"] * len(vals))
            cur.execute(
                f"INSERT INTO tasks ({', '.join(names)}) VALUES ({placeholders})",
                vals,
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"create_task: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def update_task(task_id: str, sid: str, updates: dict) -> bool:
    """Partial update — only columns in _TASK_COLUMNS are ever touched."""
    sets = {k: v for k, v in updates.items() if k in _TASK_COLUMNS}
    if not sets:
        return True
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cols = ", ".join(f"{k}=%s" for k in sets)
            cur.execute(
                f"UPDATE tasks SET {cols}, updated_at=NOW() WHERE id=%s AND sid=%s",
                (*sets.values(), task_id, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_task: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def soft_delete_task(task_id: str, sid: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE tasks SET deleted_at=NOW(), updated_at=NOW() WHERE id=%s AND sid=%s",
                (task_id, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"soft_delete_task: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def undelete_task(task_id: str, sid: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE tasks SET deleted_at=NULL, updated_at=NOW() WHERE id=%s AND sid=%s",
                (task_id, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"undelete_task: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def replace_all_tasks(sid: str, tasks: list) -> bool:
    """Bulk replace — delete every row for sid, reinsert the given list. Used
    only by /api/tasks/sync (CSV import, and any full-resync path) — the
    per-entity functions above are what live single-task edits use now. Keeps
    the exact whole-array-overwrite semantics the old user_blobs blob had, so
    existing bulk callers don't need to change shape."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM tasks WHERE sid=%s", (sid,))
            for t in tasks:
                # id/sid/title always go in the fixed prefix below — excluded
                # here too (not just by callers) so this can't silently
                # double-list "title" if a caller's dict happens to include
                # it, the way a first version of this function did.
                cols = {k: v for k, v in t.items() if k in _TASK_COLUMNS and k not in ("id", "sid", "title")}
                names = ["id", "sid", "title"] + list(cols.keys())
                vals  = [t["id"], sid, t.get("title", "")] + list(cols.values())
                placeholders = ", ".join(["%s"] * len(vals))
                cur.execute(
                    f"INSERT INTO tasks ({', '.join(names)}) VALUES ({placeholders})",
                    vals,
                )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"replace_all_tasks: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def purge_expired_tasks(cutoff_iso: str) -> int:
    """Permanently remove tasks soft-deleted before `cutoff_iso` (an ISO
    timestamp string), across every user in one query — for the scheduled
    purge job. Returns the number of rows removed."""
    conn = _get_conn()
    if not conn:
        return 0
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < %s",
                (cutoff_iso,),
            )
            count = cur.rowcount
        conn.commit()
        return count
    except Exception as exc:
        log.error(f"purge_expired_tasks: {exc}")
        conn.rollback()
        return 0
    finally:
        _release(conn)


def get_sids_with_tasks() -> list[str]:
    """Every sid with at least one row in the real `tasks` table -- tasks
    don't go through user_blobs (see this file's top-of-section note), so
    get_sids_with_blob_key() can't see them. Used by the embeddings indexing
    job to enumerate whose tasks need (re)indexing."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT sid FROM tasks")
            return [r[0] for r in cur.fetchall()]
    finally:
        _release(conn)


# ── Personal habits (real table, per-entity ops) ──────────────
# Same shape as the tasks block above — see that section's comments for the
# full rationale (blob -> table migration, id-collision fix, whitelist
# pattern). Only real difference: `completions` is JSONB, so writes need to
# go through _json.dumps() while every other column is a plain scalar.

_HABIT_COLUMNS = {
    "title", "emoji", "frequency", "streak", "best_streak", "completions",
    "deleted_at",
}


def _habit_param(key: str, value):
    """completions is the one JSONB column here — everything else is a plain
    scalar psycopg2 can bind directly."""
    if key == "completions":
        import json as _json
        return _json.dumps(value if value is not None else [])
    return value


def _row_to_habit(row: dict) -> dict:
    d = dict(row)
    for key in ("deleted_at", "created_at", "updated_at"):
        if d.get(key) is not None and hasattr(d[key], "isoformat"):
            d[key] = d[key].isoformat()
    return d


def get_habits(sid: str, include_deleted: bool = False) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if include_deleted:
                cur.execute("SELECT * FROM habits WHERE sid=%s ORDER BY created_at", (sid,))
            else:
                cur.execute("SELECT * FROM habits WHERE sid=%s AND deleted_at IS NULL ORDER BY created_at", (sid,))
            return [_row_to_habit(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_habits: {exc}")
        return []
    finally:
        _release(conn)


def get_trashed_habits(sid: str) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM habits WHERE sid=%s AND deleted_at IS NOT NULL ORDER BY deleted_at DESC", (sid,))
            return [_row_to_habit(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_trashed_habits: {exc}")
        return []
    finally:
        _release(conn)


def get_habit(habit_id: str, sid: str) -> dict | None:
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM habits WHERE id=%s AND sid=%s", (habit_id, sid))
            row = cur.fetchone()
            return _row_to_habit(row) if row else None
    except Exception as exc:
        log.error(f"get_habit: {exc}")
        return None
    finally:
        _release(conn)


def create_habit(sid: str, habit_id: str, title: str, **fields) -> bool:
    cols = {k: v for k, v in fields.items() if k in _HABIT_COLUMNS and k not in ("id", "sid", "title")}
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            names = ["id", "sid", "title"] + list(cols.keys())
            vals  = [habit_id, sid, title] + [_habit_param(k, v) for k, v in cols.items()]
            placeholders = ", ".join(["%s"] * len(vals))
            cur.execute(
                f"INSERT INTO habits ({', '.join(names)}) VALUES ({placeholders})",
                vals,
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"create_habit: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def update_habit(habit_id: str, sid: str, updates: dict) -> bool:
    """Partial update — only columns in _HABIT_COLUMNS are ever touched."""
    sets = {k: v for k, v in updates.items() if k in _HABIT_COLUMNS}
    if not sets:
        return True
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cols = ", ".join(f"{k}=%s" for k in sets)
            vals = [_habit_param(k, v) for k, v in sets.items()]
            cur.execute(
                f"UPDATE habits SET {cols}, updated_at=NOW() WHERE id=%s AND sid=%s",
                (*vals, habit_id, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_habit: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def soft_delete_habit(habit_id: str, sid: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE habits SET deleted_at=NOW(), updated_at=NOW() WHERE id=%s AND sid=%s",
                (habit_id, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"soft_delete_habit: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def undelete_habit(habit_id: str, sid: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE habits SET deleted_at=NULL, updated_at=NOW() WHERE id=%s AND sid=%s",
                (habit_id, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"undelete_habit: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def replace_all_habits(sid: str, habits: list) -> bool:
    """Bulk replace — used only by /api/habits/sync (full-resync fallback);
    per-entity functions above are what live single-habit edits use now."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM habits WHERE sid=%s", (sid,))
            for h in habits:
                cols = {k: v for k, v in h.items() if k in _HABIT_COLUMNS and k not in ("id", "sid", "title")}
                names = ["id", "sid", "title"] + list(cols.keys())
                vals  = [h["id"], sid, h.get("title", "")] + [_habit_param(k, v) for k, v in cols.items()]
                placeholders = ", ".join(["%s"] * len(vals))
                cur.execute(
                    f"INSERT INTO habits ({', '.join(names)}) VALUES ({placeholders})",
                    vals,
                )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"replace_all_habits: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def purge_expired_habits(cutoff_iso: str) -> int:
    """Permanently remove habits soft-deleted before `cutoff_iso` — for the
    scheduled purge job. Returns the number of rows removed."""
    conn = _get_conn()
    if not conn:
        return 0
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM habits WHERE deleted_at IS NOT NULL AND deleted_at < %s",
                (cutoff_iso,),
            )
            count = cur.rowcount
        conn.commit()
        return count
    except Exception as exc:
        log.error(f"purge_expired_habits: {exc}")
        conn.rollback()
        return 0
    finally:
        _release(conn)


# ── Personal goals (Session 16) ───────────────────────────────
# Unlike tasks/habits, routes/goals.py has no per-entity create_goal/
# update_goal DB calls to write — every one of its endpoints (add, update,
# delete, restore, edit, kr/add, kr/update, kr/delete) does a whole-list
# read-modify-write via load_goals()/save_goals(), exactly like the old
# user_blobs blob did. So only the whole-list functions below are needed:
# get_goals()+replace_all_goals() are what load_goals()/save_goals() call
# underneath, matching the exact overwrite-the-whole-list semantics the
# blob already had — this migration changes storage, not that contract.

_GOAL_COLUMNS = {
    "title", "subject", "target_score", "deadline", "created", "progress",
    "completed", "goal_type", "key_results", "deleted_at",
    "due", "mode", "manual_pct", "pct_override", "milestones", "habit_ids",
}
_GOAL_JSONB_COLUMNS = {"key_results", "milestones", "habit_ids"}


def _goal_param(key: str, value):
    """key_results/milestones/habit_ids are the JSONB columns here --
    everything else is a plain scalar psycopg2 can bind directly."""
    if key in _GOAL_JSONB_COLUMNS:
        import json as _json
        return _json.dumps(value if value is not None else [])
    return value


def _row_to_goal(row: dict) -> dict:
    """psycopg2 hands back TIMESTAMPTZ columns as timezone-AWARE datetimes,
    but this codebase's convention everywhere else (datetime.utcnow(),
    tests/app.py comparisons against deleted_at strings) is naive UTC --
    .replace(tzinfo=None) here rather than a bare .isoformat() so a caller
    comparing this string via datetime.fromisoformat() against a naive
    `datetime.utcnow()`-derived cutoff doesn't hit "can't compare
    offset-naive and offset-aware datetimes" (caught by a real CI run
    against real Postgres, not by reading the migration diff -- see
    tests/test_smoke.py's test_purge_deleted_goals_respects_30_day_retention).
    Postgres stores TIMESTAMPTZ in UTC regardless of session timezone, so
    dropping tzinfo here doesn't shift the value, only its representation."""
    d = dict(row)
    for key in ("deleted_at", "created_at", "updated_at"):
        if d.get(key) is not None and hasattr(d[key], "isoformat"):
            d[key] = d[key].replace(tzinfo=None).isoformat()
    return d


def get_goals(sid: str, include_deleted: bool = False) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if include_deleted:
                cur.execute("SELECT * FROM goals WHERE sid=%s ORDER BY created_at", (sid,))
            else:
                cur.execute("SELECT * FROM goals WHERE sid=%s AND deleted_at IS NULL ORDER BY created_at", (sid,))
            return [_row_to_goal(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_goals: {exc}")
        return []
    finally:
        _release(conn)


def get_trashed_goals(sid: str) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM goals WHERE sid=%s AND deleted_at IS NOT NULL ORDER BY deleted_at DESC", (sid,))
            return [_row_to_goal(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_trashed_goals: {exc}")
        return []
    finally:
        _release(conn)


def get_goal(goal_id: str, sid: str) -> dict | None:
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM goals WHERE id=%s AND sid=%s", (goal_id, sid))
            row = cur.fetchone()
            return _row_to_goal(row) if row else None
    except Exception as exc:
        log.error(f"get_goal: {exc}")
        return None
    finally:
        _release(conn)


def create_goal(sid: str, goal_id: str, title: str, **fields) -> bool:
    cols = {k: v for k, v in fields.items() if k in _GOAL_COLUMNS and k not in ("id", "sid", "title")}
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            names = ["id", "sid", "title"] + list(cols.keys())
            vals  = [goal_id, sid, title] + [_goal_param(k, v) for k, v in cols.items()]
            placeholders = ", ".join(["%s"] * len(vals))
            cur.execute(
                f"INSERT INTO goals ({', '.join(names)}) VALUES ({placeholders})",
                vals,
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"create_goal: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def update_goal(goal_id: str, sid: str, updates: dict) -> bool:
    sets = {k: v for k, v in updates.items() if k in _GOAL_COLUMNS}
    if not sets:
        return True
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cols = ", ".join(f"{k}=%s" for k in sets)
            vals = [_goal_param(k, v) for k, v in sets.items()]
            cur.execute(
                f"UPDATE goals SET {cols}, updated_at=NOW() WHERE id=%s AND sid=%s",
                (*vals, goal_id, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_goal: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def soft_delete_goal(goal_id: str, sid: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE goals SET deleted_at=NOW(), updated_at=NOW() WHERE id=%s AND sid=%s",
                (goal_id, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"soft_delete_goal: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def undelete_goal(goal_id: str, sid: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE goals SET deleted_at=NULL, updated_at=NOW() WHERE id=%s AND sid=%s",
                (goal_id, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"undelete_goal: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def has_user_migrated_goals(sid: str) -> bool:
    """Check if lazy migration has already been completed for this sid."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM user_blobs WHERE sid=%s AND key='goals_migrated'", (sid,))
            if cur.fetchone():
                return True
            cur.execute("SELECT 1 FROM goals WHERE sid=%s LIMIT 1", (sid,))
            return cur.fetchone() is not None
    except Exception as exc:
        log.error(f"has_user_migrated_goals: {exc}")
        return False
    finally:
        _release(conn)


def replace_all_goals_and_mark_migrated(sid: str, goals: list) -> bool:
    """Atomic migration transaction: inserts legacy goals into goals table
    AND records migration completion in a single transaction."""
    import json as _json
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM goals WHERE sid=%s", (sid,))
            for g in goals:
                cols = {k: v for k, v in g.items() if k in _GOAL_COLUMNS and k not in ("id", "sid", "title")}
                names = ["id", "sid", "title"] + list(cols.keys())
                vals  = [g["id"], sid, g.get("title", "")] + [_goal_param(k, v) for k, v in cols.items()]
                placeholders = ", ".join(["%s"] * len(vals))
                cur.execute(
                    f"INSERT INTO goals ({', '.join(names)}) VALUES ({placeholders})",
                    vals,
                )
            cur.execute(
                """INSERT INTO user_blobs (sid, key, data, updated_at)
                   VALUES (%s, 'goals_migrated', '{"migrated":true}', NOW())
                   ON CONFLICT (sid, key) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()""",
                (sid,),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"replace_all_goals_and_mark_migrated: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def mutate_goal_kr(goal_id: str, sid: str, kr_action: str, kr_data: dict) -> tuple[bool, dict | None]:
    """Execute a single-goal Key Result mutation (add/update/delete) inside a
    single protected transaction block."""
    import json as _json
    conn = _get_conn()
    if not conn:
        return False, None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM goals WHERE id=%s AND sid=%s FOR UPDATE", (goal_id, sid))
            row = cur.fetchone()
            if not row:
                conn.rollback()
                return False, None
            g = _row_to_goal(row)
            krs = g.get("key_results") or []
            if isinstance(krs, str):
                try:
                    krs = _json.loads(krs)
                except Exception:
                    krs = []

            if kr_action == "add":
                krs.append(kr_data)
            elif kr_action == "update":
                target_kr_id = kr_data.get("kr_id")
                curr_val = kr_data.get("current", 0.0)
                for kr in krs:
                    if kr.get("id") == target_kr_id:
                        kr["current"] = max(0.0, float(curr_val))
                        break
            elif kr_action == "delete":
                target_kr_id = kr_data.get("kr_id")
                krs = [kr for kr in krs if kr.get("id") != target_kr_id]

            # Recalculate progress & completed status
            if krs:
                pcts = [min(100.0, (float(kr.get("current", 0)) / max(0.01, float(kr.get("target", 1)))) * 100) for kr in krs]
                progress = round(sum(pcts) / len(pcts))
            else:
                progress = g.get("progress", 0)
            completed = progress >= 100 if krs else g.get("completed", False)

            cur.execute(
                "UPDATE goals SET key_results=%s, progress=%s, completed=%s, updated_at=NOW() WHERE id=%s AND sid=%s",
                (_json.dumps(krs), progress, completed, goal_id, sid),
            )
            g["key_results"] = krs
            g["progress"] = progress
            g["completed"] = completed
        conn.commit()
        return True, g
    except Exception as exc:
        log.error(f"mutate_goal_kr[{kr_action}]: {exc}")
        conn.rollback()
        return False, None
    finally:
        _release(conn)


def search_goals(sid: str, q: str, limit: int = 15) -> list:
    """Full-text search over this user's goals, ranked via goals.search_vector
    (title + subject) + its GIN index. Soft-deleted goals excluded in SQL,
    same convention as search_tasks."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, title, subject, progress, completed,
                          ts_rank(search_vector, plainto_tsquery('english', %s)) AS rank
                   FROM goals
                   WHERE sid=%s AND deleted_at IS NULL
                     AND search_vector @@ plainto_tsquery('english', %s)
                   ORDER BY rank DESC
                   LIMIT %s""",
                (q, sid, q, limit),
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"search_goals: {exc}")
        return []
    finally:
        _release(conn)


def replace_all_goals(sid: str, goals: list) -> bool:
    """Bulk replace -- delete every row for sid, reinsert the given list.
    Constrained strictly to initial lazy migration and full-resync fallbacks."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM goals WHERE sid=%s", (sid,))
            for g in goals:
                cols = {k: v for k, v in g.items() if k in _GOAL_COLUMNS and k not in ("id", "sid", "title")}
                names = ["id", "sid", "title"] + list(cols.keys())
                vals  = [g["id"], sid, g.get("title", "")] + [_goal_param(k, v) for k, v in cols.items()]
                placeholders = ", ".join(["%s"] * len(vals))
                cur.execute(
                    f"INSERT INTO goals ({', '.join(names)}) VALUES ({placeholders})",
                    vals,
                )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"replace_all_goals: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def purge_expired_goals(cutoff_iso: str) -> int:
    """Permanently remove goals soft-deleted before `cutoff_iso` -- for the
    scheduled purge job (app.py's _purge_deleted_goals). Returns the number
    of rows removed."""
    conn = _get_conn()
    if not conn:
        return 0
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM goals WHERE deleted_at IS NOT NULL AND deleted_at < %s",
                (cutoff_iso,),
            )
            count = cur.rowcount
        conn.commit()
        return count
    except Exception as exc:
        log.error(f"purge_expired_goals: {exc}")
        conn.rollback()
        return 0
    finally:
        _release(conn)


def get_sids_with_goals() -> list[str]:
    """Every sid with at least one row in the real `goals` table -- goals no
    longer go through user_blobs, so get_sids_with_blob_key("goals") can't
    see them post-migration. Used by app.py's _purge_deleted_goals and
    _index_embeddings jobs to enumerate whose goals need processing."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT sid FROM goals")
            return [r[0] for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_sids_with_goals: {exc}")
        return []
    finally:
        _release(conn)


# ── Personal docs (Session 16) ─────────────────────────────────
# Same reasoning as goals above: routes/docs_notes.py has no per-entity
# writes at all (only POST /api/docs/sync, which always replaces the
# caller's entire doc list), so replace_all_docs is the only write path
# needed, not per-entity create/update/delete functions.

_DOC_COLUMNS = {"title", "content", "updated", "deleted_at", "is_public", "public_slug"}


def _doc_param(key: str, value):
    """Every column here is TEXT (deleted_at aside, which expects an ISO
    string or None same as tasks/goals) -- but routes/docs_notes.py's
    import_notes() writes `id`/`updated` as raw ints
    (int(datetime.now().timestamp()*1000)), not the strings sync_docs()
    always sends. psycopg2 won't implicitly cast a Python int into a TEXT
    column, so without this a doc created via note-import would 500 the
    first time it went through replace_all_docs (i.e. the very next
    /api/docs/sync). Coerce defensively here rather than fix it at
    import_notes' call site, since any future write path has the same
    trap otherwise. is_public is the one real BOOLEAN column -- stringifying
    it like everything else would write the literal text "True"/"False"
    into a boolean column, which psycopg2 also won't implicitly cast."""
    if value is None:
        return None
    if key == "is_public":
        return bool(value)
    return str(value)


def _row_to_doc(row: dict) -> dict:
    """Same naive-UTC normalization as _row_to_goal above, and for the same
    reason -- kept consistent even though no current caller compares docs'
    deleted_at in Python yet, to avoid the identical latent bug surfacing
    later the same way it did for goals."""
    d = dict(row)
    for key in ("deleted_at", "created_at", "updated_at"):
        if d.get(key) is not None and hasattr(d[key], "isoformat"):
            d[key] = d[key].replace(tzinfo=None).isoformat()
    return d


def get_docs(sid: str, include_deleted: bool = False) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            if include_deleted:
                cur.execute("SELECT * FROM docs WHERE sid=%s ORDER BY created_at", (sid,))
            else:
                cur.execute("SELECT * FROM docs WHERE sid=%s AND deleted_at IS NULL ORDER BY created_at", (sid,))
            return [_row_to_doc(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_docs: {exc}")
        return []
    finally:
        _release(conn)


def get_public_doc(slug: str) -> dict | None:
    """Look up a published doc by its public_slug, across ALL users -- the
    one docs query that isn't scoped by sid, since the public /doc/{slug}
    page has no session and no idea whose doc it is. is_public=TRUE and
    deleted_at IS NULL are both re-checked here (not just trusted from the
    slug's existence) so unpublishing or trashing a doc takes the public
    page down immediately, not just hides the link in the editor."""
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT title, content, updated FROM docs "
                "WHERE public_slug=%s AND is_public=TRUE AND deleted_at IS NULL",
                (slug,),
            )
            row = cur.fetchone()
            return _row_to_doc(row) if row else None
    except Exception as exc:
        log.error(f"get_public_doc: {exc}")
        return None
    finally:
        _release(conn)


def search_docs(sid: str, q: str, limit: int = 15) -> list:
    """Full-text search over this user's docs, ranked via docs.search_vector
    (title + content) + its GIN index. Soft-deleted docs excluded in SQL,
    same convention as search_tasks/search_goals. Returns content too (not
    just a snippet) since routes/search.py builds its own excerpt around
    the match position, same as the JSON-fallback substring path already
    does."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, title, content,
                          ts_rank(search_vector, plainto_tsquery('english', %s)) AS rank
                   FROM docs
                   WHERE sid=%s AND deleted_at IS NULL
                     AND search_vector @@ plainto_tsquery('english', %s)
                   ORDER BY rank DESC
                   LIMIT %s""",
                (q, sid, q, limit),
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"search_docs: {exc}")
        return []
    finally:
        _release(conn)


def replace_all_docs(sid: str, docs: list) -> bool:
    """Bulk replace -- delete every row for sid, reinsert the given list.
    The only write path for docs -- see this section's header comment."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM docs WHERE sid=%s", (sid,))
            for d in docs:
                cols = {k: v for k, v in d.items() if k in _DOC_COLUMNS and k not in ("id", "sid", "title")}
                names = ["id", "sid", "title"] + list(cols.keys())
                vals  = [str(d.get("id", "")), sid, str(d.get("title", ""))] + [_doc_param(k, v) for k, v in cols.items()]
                placeholders = ", ".join(["%s"] * len(vals))
                cur.execute(
                    f"INSERT INTO docs ({', '.join(names)}) VALUES ({placeholders})",
                    vals,
                )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"replace_all_docs: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def get_sids_with_docs() -> list[str]:
    """Every sid with at least one row in the real `docs` table -- see
    get_sids_with_goals' identical reasoning. Used by app.py's
    _index_embeddings job."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT DISTINCT sid FROM docs")
            return [r[0] for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_sids_with_docs: {exc}")
        return []
    finally:
        _release(conn)


# ── Spaced repetition (review_cards) ───────────────────────────
# Real per-row table (not a bulk-sync blob like docs above) -- every review
# answer updates exactly one card's schedule, and scheduling math (see
# routes/review.py's _sm2_next) must be server-authoritative so a client
# can't just set its own due_date/ease. No lazy blob migration needed (unlike
# tasks/goals/habits) since this is a brand-new feature with no pre-existing
# client-side data to import. Reuses _row_to_doc below for the generic
# TIMESTAMPTZ->naive-isoformat normalization it does -- despite the name,
# nothing in it is doc-specific, it just walks deleted_at/created_at/
# updated_at, which review_cards also has.

def create_review_card(sid: str, card_id: str, front: str, back: str,
                        source_type: str = "custom", source_id: str = "",
                        due_date: str = "") -> dict | None:
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """INSERT INTO review_cards (id, sid, source_type, source_id, front, back, due_date)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   RETURNING *""",
                (card_id, sid, source_type, source_id, front, back, due_date),
            )
            row = cur.fetchone()
        conn.commit()
        return _row_to_doc(row) if row else None
    except Exception as exc:
        log.error(f"create_review_card: {exc}")
        conn.rollback()
        return None
    finally:
        _release(conn)


def get_due_review_cards(sid: str, today_iso: str, limit: int = 50) -> list:
    """Cards due today or earlier -- oldest-due first, so a long-neglected
    card surfaces before ones that only just came due."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT * FROM review_cards
                   WHERE sid=%s AND deleted_at IS NULL AND due_date <= %s
                   ORDER BY due_date ASC LIMIT %s""",
                (sid, today_iso, limit),
            )
            return [_row_to_doc(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_due_review_cards: {exc}")
        return []
    finally:
        _release(conn)


def get_review_card(sid: str, card_id: str) -> dict | None:
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM review_cards WHERE sid=%s AND id=%s AND deleted_at IS NULL",
                (sid, card_id),
            )
            row = cur.fetchone()
            return _row_to_doc(row) if row else None
    except Exception as exc:
        log.error(f"get_review_card: {exc}")
        return None
    finally:
        _release(conn)


def update_review_schedule(sid: str, card_id: str, ease: float, interval_days: int,
                            repetitions: int, due_date: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE review_cards
                   SET ease=%s, interval_days=%s, repetitions=%s, due_date=%s, updated_at=NOW()
                   WHERE sid=%s AND id=%s""",
                (ease, interval_days, repetitions, due_date, sid, card_id),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_review_schedule: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def soft_delete_review_card(sid: str, card_id: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE review_cards SET deleted_at=NOW() WHERE sid=%s AND id=%s",
                (sid, card_id),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"soft_delete_review_card: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


# ── In-app notifications + Expo push tokens ───────────────────

def create_notification(sid: str, nid: str, title: str, body: str = "", url: str = "/app") -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO notifications (id, sid, title, body, url) VALUES (%s, %s, %s, %s, %s)",
                (nid, sid, title, body, url),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"create_notification: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def get_notifications(sid: str, limit: int = 50) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM notifications WHERE sid=%s ORDER BY created_at DESC LIMIT %s",
                (sid, limit),
            )
            rows = [dict(r) for r in cur.fetchall()]
            for r in rows:
                for key in ("read_at", "created_at"):
                    if r.get(key) is not None and hasattr(r[key], "isoformat"):
                        r[key] = r[key].isoformat()
            return rows
    except Exception as exc:
        log.error(f"get_notifications: {exc}")
        return []
    finally:
        _release(conn)


def mark_notification_read(nid: str, sid: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE notifications SET read_at=NOW() WHERE id=%s AND sid=%s AND read_at IS NULL",
                (nid, sid),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"mark_notification_read: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def mark_all_notifications_read(sid: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE notifications SET read_at=NOW() WHERE sid=%s AND read_at IS NULL",
                (sid,),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"mark_all_notifications_read: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def count_unread_notifications(sid: str) -> int:
    conn = _get_conn()
    if not conn:
        return 0
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM notifications WHERE sid=%s AND read_at IS NULL", (sid,))
            return cur.fetchone()[0]
    except Exception as exc:
        log.error(f"count_unread_notifications: {exc}")
        return 0
    finally:
        _release(conn)


def save_expo_push_token(sid: str, token: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO expo_push_tokens (sid, token) VALUES (%s, %s) ON CONFLICT (sid, token) DO NOTHING",
                (sid, token),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"save_expo_push_token: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def get_expo_push_tokens(sid: str) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT token FROM expo_push_tokens WHERE sid=%s", (sid,))
            return [r[0] for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_expo_push_tokens: {exc}")
        return []
    finally:
        _release(conn)


def delete_expo_push_token(token: str) -> None:
    """Called when Expo reports a token as dead (DeviceNotRegistered) — no sid
    needed, the token itself is unique enough to target the stale row."""
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM expo_push_tokens WHERE token=%s", (token,))
        conn.commit()
    except Exception as exc:
        log.error(f"delete_expo_push_token: {exc}")
        conn.rollback()
    finally:
        _release(conn)


# ── Generic collections (relational global stores) ───────────
# Per-record CRUD so concurrent writers no longer clobber a whole-file blob.

def coll_list(collection: str, owner: str | None = None) -> list:
    """All records' data for a collection, oldest-first. Optional owner filter."""
    def _q(conn):
        with conn.cursor() as cur:
            if owner is None:
                cur.execute("SELECT data FROM collections WHERE collection=%s ORDER BY seq", (collection,))
            else:
                cur.execute("SELECT data FROM collections WHERE collection=%s AND owner=%s ORDER BY seq", (collection, owner))
            return [r[0] for r in cur.fetchall()]
    return _with_conn(f"coll_list[{collection}]", _q, [])


def coll_get(collection: str, item_id: str) -> dict | None:
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT data FROM collections WHERE collection=%s AND item_id=%s", (collection, str(item_id)))
            row = cur.fetchone()
        return row[0] if row else None
    return _with_conn(f"coll_get[{collection}]", _q, None)


def coll_put(collection: str, item_id: str, data: dict, owner: str = "") -> None:
    """Upsert one record (atomic)."""
    import json as _json
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO collections (collection, item_id, owner, data, updated_at)
                   VALUES (%s,%s,%s,%s,NOW())
                   ON CONFLICT (collection, item_id)
                   DO UPDATE SET data=EXCLUDED.data, owner=EXCLUDED.owner, updated_at=NOW()""",
                (collection, str(item_id), owner, _json.dumps(data)))
        conn.commit()
    except Exception as exc:
        log.error(f"coll_put[{collection}/{item_id}] failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def coll_delete(collection: str, item_id: str) -> None:
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM collections WHERE collection=%s AND item_id=%s", (collection, str(item_id)))
        conn.commit()
    finally:
        _release(conn)


def coll_count(collection: str, owner: str | None = None) -> int:
    def _q(conn):
        with conn.cursor() as cur:
            if owner is None:
                cur.execute("SELECT COUNT(*) FROM collections WHERE collection=%s", (collection,))
            else:
                cur.execute("SELECT COUNT(*) FROM collections WHERE collection=%s AND owner=%s", (collection, owner))
            return cur.fetchone()[0]
    return _with_conn(f"coll_count[{collection}]", _q, 0)


def coll_seed_from_list(collection: str, items: list, id_key: str = "id", owner_key: str | None = None) -> int:
    """One-time idempotent bulk import of a legacy JSON list into a collection.
    Skips rows whose item_id already exists. Returns rows inserted."""
    import json as _json
    conn = _get_conn()
    if not conn:
        return 0
    n = 0
    try:
        with conn.cursor() as cur:
            for it in items:
                if not isinstance(it, dict):
                    continue
                iid = str(it.get(id_key) or "")
                if not iid:
                    continue
                owner = str(it.get(owner_key) or "") if owner_key else ""
                cur.execute(
                    """INSERT INTO collections (collection, item_id, owner, data)
                       VALUES (%s,%s,%s,%s) ON CONFLICT (collection, item_id) DO NOTHING""",
                    (collection, iid, owner, _json.dumps(it)))
                n += cur.rowcount
        conn.commit()
    except Exception as exc:
        log.error(f"coll_seed_from_list[{collection}] failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)
    return n


def coll_load_map(collection: str) -> dict:
    """Return {item_id: data} for a collection, insertion order preserved."""
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT item_id, data FROM collections WHERE collection=%s ORDER BY seq", (collection,))
            return {r[0]: r[1] for r in cur.fetchall()}
    return _with_conn(f"coll_load_map[{collection}]", _q, {})


def coll_replace_all(collection: str, mapping: dict, owner_key: str | None = None) -> None:
    """Atomically replace an entire collection from {item_id: data} in ONE
    transaction (delete-all + insert-all). For low-write whole-collection stores
    (classes/exams/topics/groups/announcements). Insert order = mapping order, so
    seq preserves list ordering."""
    import json as _json
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM collections WHERE collection=%s", (collection,))
            for iid, data in mapping.items():
                owner = str(data.get(owner_key) or "") if (owner_key and isinstance(data, dict)) else ""
                cur.execute(
                    "INSERT INTO collections (collection, item_id, owner, data) VALUES (%s,%s,%s,%s)",
                    (collection, str(iid), owner, _json.dumps(data)))
        conn.commit()
    except Exception as exc:
        log.error(f"coll_replace_all[{collection}] failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def coll_array_append_unique(collection: str, item_id: str, field: str, value) -> None:
    """Atomically append `value` to the JSON array data->field on ONE record, only
    if not already present. Avoids the read-modify-write race when many users mutate
    the same record's array concurrently (e.g. class enrollment 'students')."""
    import json as _json
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE collections
                   SET data = jsonb_set(data, %s, COALESCE(data->%s, '[]'::jsonb) || %s::jsonb),
                       updated_at = NOW()
                   WHERE collection=%s AND item_id=%s
                     AND NOT (COALESCE(data->%s, '[]'::jsonb) @> %s::jsonb)""",
                ("{" + field + "}", field, _json.dumps([value]),
                 collection, str(item_id), field, _json.dumps(value)))
        conn.commit()
    except Exception as exc:
        log.error(f"coll_array_append_unique[{collection}/{item_id}] failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def coll_array_remove(collection: str, item_id: str, field: str, value) -> None:
    """Atomically remove all occurrences of `value` from the JSON array
    data->field on ONE record. Mirror of coll_array_append_unique — avoids the
    read-modify-write race when many users mutate the same record's array
    concurrently (e.g. class enrollment 'students' on leave)."""
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE collections
                   SET data = jsonb_set(data, %s, COALESCE(data->%s, '[]'::jsonb) - %s),
                       updated_at = NOW()
                   WHERE collection=%s AND item_id=%s""",
                ("{" + field + "}", field, str(value), collection, str(item_id)))
        conn.commit()
    except Exception as exc:
        log.error(f"coll_array_remove[{collection}/{item_id}] failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


# ── User profile ─────────────────────────────────────────────

def update_user_profile(sid: str, name: str, phone: str) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET name = %s, phone = %s WHERE sid = %s",
                (name, phone, sid)
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_user_profile failed: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


# ── Community posts ───────────────────────────────────────────

def get_community_posts(category: str = "all", limit: int = 40) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            if category == "all":
                cur.execute(
                    "SELECT id, author_name, author_sid, body, category, tags, likes, replies, created_at "
                    "FROM community_posts ORDER BY created_at DESC LIMIT %s",
                    (limit,)
                )
            else:
                cur.execute(
                    "SELECT id, author_name, author_sid, body, category, tags, likes, replies, created_at "
                    "FROM community_posts WHERE category = %s ORDER BY created_at DESC LIMIT %s",
                    (category, limit)
                )
            rows = cur.fetchall()
        return [
            {"id": r[0], "author": r[1], "sid": r[2], "body": r[3], "category": r[4],
             "tags": r[5] or [], "likes": r[6] or [], "replies": r[7] or [],
             "created": r[8].strftime("%Y-%m-%dT%H:%M:%SZ") if r[8] else ""}
            for r in rows
        ]
    finally:
        _release(conn)


def search_community_posts(q: str, limit: int = 5) -> list:
    """Full-text search over the public community feed, ranked by relevance
    via community_posts.search_vector + its GIN index (see _SCHEMA). Public
    feed, so no sid scoping -- every post is visible to every member already
    (see get_community_posts above, which has none either)."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, author_name, body,
                          ts_rank(search_vector, plainto_tsquery('english', %s)) AS rank
                   FROM community_posts
                   WHERE search_vector @@ plainto_tsquery('english', %s)
                   ORDER BY rank DESC
                   LIMIT %s""",
                (q, q, limit),
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"search_community_posts: {exc}")
        return []
    finally:
        _release(conn)


def create_community_post(post_id: str, author_name: str, author_sid: str,
                          body: str, category: str, tags: list) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        import json as _json
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO community_posts (id, author_name, author_sid, body, category, tags) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (post_id, author_name, author_sid, body, category, _json.dumps(tags))
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"create_community_post failed: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def toggle_community_like(post_id: str, user_sid: str) -> tuple[bool, int]:
    """Toggle like. Returns (liked: bool, new_count: int)."""
    conn = _get_conn()
    if not conn:
        return False, 0
    try:
        import json as _json
        with conn.cursor() as cur:
            cur.execute("SELECT likes FROM community_posts WHERE id = %s FOR UPDATE", (post_id,))
            row = cur.fetchone()
            if not row:
                return False, 0
            likes = row[0] or []
            if user_sid in likes:
                likes.remove(user_sid)
                liked = False
            else:
                likes.append(user_sid)
                liked = True
            cur.execute(
                "UPDATE community_posts SET likes = %s WHERE id = %s",
                (_json.dumps(likes), post_id)
            )
        conn.commit()
        return liked, len(likes)
    except Exception as exc:
        log.error(f"toggle_community_like failed: {exc}")
        conn.rollback()
        return False, 0
    finally:
        _release(conn)


def add_community_reply(post_id: str, reply: dict) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        import json as _json
        with conn.cursor() as cur:
            cur.execute("SELECT replies FROM community_posts WHERE id = %s FOR UPDATE", (post_id,))
            row = cur.fetchone()
            if not row:
                return False
            replies = row[0] or []
            replies.append(reply)
            cur.execute(
                "UPDATE community_posts SET replies = %s WHERE id = %s",
                (_json.dumps(replies), post_id)
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"add_community_reply failed: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def seed_community_posts(posts: list) -> None:
    """Idempotently insert seed posts (additive — extends existing data).

    `likes` in each seed dict is a count; it is expanded into a JSONB array of
    placeholder sids so the feed shows social proof while a real user's like
    still appends correctly on top. Existing rows are never overwritten
    (ON CONFLICT DO NOTHING), so this is safe to run on every startup.
    """
    conn = _get_conn()
    if not conn:
        return
    try:
        import json as _json
        with conn.cursor() as cur:
            for i, p in enumerate(posts):
                n_likes = int(p.get("likes", 0) or 0)
                likes   = [f"seed_{p['id']}_{j}" for j in range(n_likes)]
                cur.execute(
                    "INSERT INTO community_posts "
                    "(id, author_name, body, category, tags, likes, created_at) "
                    "VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, NOW() - INTERVAL '1 hour' * %s) "
                    "ON CONFLICT (id) DO NOTHING",
                    (p["id"], p.get("author","Sivarr Team"), p.get("content", p.get("body","")),
                     p.get("category","general"), _json.dumps(p.get("tags", [])),
                     _json.dumps(likes), i * 2)
                )
        conn.commit()
    except Exception as exc:
        log.error(f"seed_community_posts failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


# ── Opportunities ─────────────────────────────────────────────

def get_opportunities(category: str = "all", limit: int = 50) -> list:
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor() as cur:
            if category == "all":
                cur.execute(
                    "SELECT id, title, description, link, category, organisation, location, deadline, submitted_by, created_at "
                    "FROM opportunities ORDER BY created_at DESC LIMIT %s",
                    (limit,)
                )
            else:
                cur.execute(
                    "SELECT id, title, description, link, category, organisation, location, deadline, submitted_by, created_at "
                    "FROM opportunities WHERE category = %s ORDER BY created_at DESC LIMIT %s",
                    (category, limit)
                )
            rows = cur.fetchall()
        return [
            {"id": r[0], "title": r[1], "desc": r[2], "link": r[3], "category": r[4],
             "organisation": r[5], "location": r[6], "deadline": r[7],
             "submitted_by": r[8],
             "created": r[9].strftime("%Y-%m-%dT%H:%M:%SZ") if r[9] else ""}
            for r in rows
        ]
    finally:
        _release(conn)


def create_opportunity(opp: dict) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO opportunities (id, title, description, link, category, organisation, location, deadline, submitted_by) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (opp["id"], opp["title"], opp.get("desc",""), opp.get("link",""),
                 opp.get("category","other"), opp.get("organisation",""), opp.get("location",""),
                 opp.get("deadline",""), opp.get("submitted_by",""))
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"create_opportunity failed: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def seed_opportunities(opps: list) -> None:
    """Idempotently insert seed opportunities (additive — extends existing data).

    Per-row ON CONFLICT DO NOTHING, so new seed listings are added even when the
    table already holds earlier seeds or user submissions; existing rows are
    never touched. Safe to run on every startup.
    """
    conn = _get_conn()
    if not conn:
        return
    try:
        with conn.cursor() as cur:
            for o in opps:
                cur.execute(
                    "INSERT INTO opportunities (id, title, description, link, category, organisation, location, deadline) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (id) DO NOTHING",
                    (o["id"], o["title"], o.get("description",""), o.get("url", o.get("link","")),
                     o.get("category","other"), o.get("organisation",""), o.get("location",""),
                     o.get("deadline",""))
                )
        conn.commit()
    except Exception as exc:
        log.error(f"seed_opportunities failed: {exc}")
        conn.rollback()
    finally:
        _release(conn)


def update_org(org_id: str, owner_sid: str, updates: dict) -> bool:
    """Update allowed org fields. Only the owner can do this."""
    allowed = {"name", "description", "logo"}
    fields  = {k: v for k, v in updates.items() if k in allowed}
    if not fields:
        return False
    conn = _get_conn()
    if not conn:
        return False
    try:
        set_clause = ", ".join(f"{k} = %s" for k in fields)
        vals       = list(fields.values()) + [org_id, owner_sid]
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE orgs SET {set_clause} WHERE id = %s AND owner_sid = %s",
                vals
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_org failed: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def delete_org(org_id: str, owner_sid: str) -> bool:
    """Delete an org and every piece of its data. Every org_* child table
    (members, invites, tasks, projects, docs, messages, goals, key_results,
    founder metrics, announcements, integrations) has ON DELETE CASCADE on
    org_id in _SCHEMA, so removing the orgs row alone cascades all of them.
    collections (org_audit's log) has no FK to orgs -- it's a generic
    key-value store -- so those rows are cleared explicitly first.
    owner_sid is re-checked in the WHERE clause as defense in depth, on top
    of the route's own ownership check, the same pattern update_org uses."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM collections WHERE collection = 'org_audit' AND owner = %s", (org_id,))
            cur.execute("DELETE FROM orgs WHERE id = %s AND owner_sid = %s", (org_id, owner_sid))
            deleted = cur.rowcount > 0
        conn.commit()
        return deleted
    except Exception as exc:
        log.error(f"delete_org failed [{org_id}]: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def set_org_member_role(org_id: str, target_sid: str, role: str) -> bool:
    """Change a member's role. Never touches the owner row (owner is immutable here)."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE org_members SET role = %s WHERE org_id = %s AND user_sid = %s AND role <> 'owner'",
                (role, org_id, target_sid),
            )
            changed = cur.rowcount
        conn.commit()
        return changed > 0
    except Exception as exc:
        log.error(f"set_org_member_role failed: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def remove_org_member(org_id: str, target_sid: str) -> bool:
    """Remove a member from an org. Never removes the owner row."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM org_members WHERE org_id = %s AND user_sid = %s AND role <> 'owner'",
                (org_id, target_sid),
            )
            removed = cur.rowcount
        conn.commit()
        return removed > 0
    except Exception as exc:
        log.error(f"remove_org_member failed: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def get_all_orgs() -> list:
    """Return all orgs — used by cron jobs to iterate every org."""
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT id, name FROM orgs ORDER BY created_at ASC")
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_all_orgs: {exc}"); return []
    finally:
        _release(conn)


def get_org_by_member(user_sid: str) -> dict | None:
    conn = _get_conn()
    if not conn: return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT o.*, om.role AS member_role
                FROM orgs o
                JOIN org_members om ON om.org_id = o.id
                WHERE om.user_sid = %s
                ORDER BY o.created_at ASC
                LIMIT 1
            """, (user_sid,))
            row = cur.fetchone()
            return dict(row) if row else None
    except Exception as exc:
        log.error(f"get_org_by_member: {exc}"); return None
    finally:
        _release(conn)


def get_org_members(org_id: str) -> list:
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT om.role, om.joined_at, u.sid, u.name, u.email
                FROM org_members om
                JOIN users u ON u.sid = om.user_sid
                WHERE om.org_id = %s
                ORDER BY om.joined_at ASC
            """, (org_id,))
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_org_members: {exc}"); return []
    finally:
        _release(conn)


def get_pending_invites_for_email(email: str) -> list:
    """Unused, non-expired org invites addressed to this email (for in-app surfacing)."""
    def _q(conn):
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT i.token, i.org_id, i.role, i.expires_at, o.name AS org_name
                FROM org_invites i JOIN orgs o ON o.id = i.org_id
                WHERE lower(i.email) = lower(%s) AND i.used = FALSE AND i.expires_at > NOW()
                ORDER BY i.created_at DESC
            """, (email,))
            return [dict(r) for r in cur.fetchall()]
    return _with_conn(f"pending_invites[{email}]", _q, [])


def get_org(org_id: str) -> dict | None:
    """Fetch a full org row by id (includes settings JSONB)."""
    def _q(conn):
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM orgs WHERE id = %s", (org_id,))
            row = cur.fetchone()
        return dict(row) if row else None
    return _with_conn(f"get_org[{org_id}]", _q, None)


def count_org_members(org_id: str) -> int:
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM org_members WHERE org_id = %s", (org_id,))
            row = cur.fetchone()
        return int(row[0]) if row else 0
    return _with_conn(f"count_org_members[{org_id}]", _q, 0)


def set_org_subscription(org_id: str, sub: dict) -> bool:
    """Store the org's seat subscription in orgs.settings->'subscription' (+ plan col)."""
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE orgs SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), "
                "'{subscription}', %s::jsonb), plan = %s WHERE id = %s",
                (json.dumps(sub), sub.get("name", "Org"), org_id),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"set_org_subscription[{org_id}]: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def create_org_invite(org_id: str, email: str, role: str, invited_by: str, token: str, expires_at) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO org_invites (token, org_id, email, role, invited_by, expires_at) VALUES (%s, %s, %s, %s, %s, %s)",
                (token, org_id, email.lower(), role, invited_by, expires_at)
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"create_org_invite: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_org_invite(token: str) -> dict | None:
    conn = _get_conn()
    if not conn: return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM org_invites WHERE token = %s AND used = FALSE", (token,))
            row = cur.fetchone()
            return dict(row) if row else None
    except Exception as exc:
        log.error(f"get_org_invite: {exc}"); return None
    finally:
        _release(conn)


def use_org_invite(token: str, user_sid: str) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM org_invites WHERE token=%s AND used=FALSE", (token,))
            inv = cur.fetchone()
            if not inv: return False
            cur.execute("UPDATE org_invites SET used=TRUE WHERE token=%s", (token,))
            cur.execute(
                "INSERT INTO org_members (org_id, user_sid, role, invited_by) VALUES (%s,%s,%s,%s) ON CONFLICT (org_id, user_sid) DO NOTHING",
                (inv[1], user_sid, inv[3], inv[4])
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"use_org_invite: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_org_tasks(org_id: str, project_id: str = None,
                  limit: int = 500, offset: int = 0) -> list:
    with _timed("get_org_tasks"):
        conn = _get_conn()
        if not conn: return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                if project_id:
                    cur.execute(
                        "SELECT * FROM org_tasks WHERE org_id=%s AND project_id=%s ORDER BY created_at DESC LIMIT %s OFFSET %s",
                        (org_id, project_id, limit, offset)
                    )
                else:
                    cur.execute(
                        "SELECT * FROM org_tasks WHERE org_id=%s ORDER BY created_at DESC LIMIT %s OFFSET %s",
                        (org_id, limit, offset)
                    )
                return [dict(r) for r in cur.fetchall()]
        except Exception as exc:
            log.error(f"get_org_tasks: {exc}"); return []
        finally:
            _release(conn)


def count_org_tasks(org_id: str, exclude_status: str = None) -> int:
    """COUNT query — avoids loading all rows just to get a number."""
    conn = _get_conn()
    if not conn: return 0
    try:
        with conn.cursor() as cur:
            if exclude_status:
                cur.execute("SELECT COUNT(*) FROM org_tasks WHERE org_id=%s AND status != %s",
                            (org_id, exclude_status))
            else:
                cur.execute("SELECT COUNT(*) FROM org_tasks WHERE org_id=%s", (org_id,))
            return cur.fetchone()[0]
    except Exception as exc:
        log.error(f"count_org_tasks: {exc}"); return 0
    finally:
        _release(conn)


def create_org_task(org_id: str, task_id: str, title: str, created_by: str,
                    status: str = "todo", priority: str = "normal",
                    description: str = "", assignee_sid: str = None,
                    project_id: str = None, due_date: str = None) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO org_tasks (id, org_id, title, description, status, priority, assignee_sid, created_by, project_id, due_date)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """, (task_id, org_id, title, description, status, priority, assignee_sid or None, created_by, project_id or None, due_date or None))
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"create_org_task: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def update_org_task(task_id: str, updates: dict, org_id: str) -> bool:
    conn = _get_conn()
    if not conn: return False
    allowed = {"title", "description", "status", "priority", "assignee_sid", "project_id", "due_date"}
    sets = {k: v for k, v in updates.items() if k in allowed}
    if not sets: return True
    try:
        with conn.cursor() as cur:
            cols = ", ".join(f"{k}=%s" for k in sets)
            cur.execute(f"UPDATE org_tasks SET {cols}, updated_at=NOW() WHERE id=%s AND org_id=%s",
                        (*sets.values(), task_id, org_id))
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_org_task: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def delete_org_task(task_id: str, org_id: str) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM org_tasks WHERE id=%s AND org_id=%s", (task_id, org_id))
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"delete_org_task: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_org_projects(org_id: str, limit: int = 100) -> list:
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM org_projects WHERE org_id=%s ORDER BY created_at DESC LIMIT %s", (org_id, limit))
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_org_projects: {exc}"); return []
    finally:
        _release(conn)


def create_org_project(org_id: str, project_id: str, name: str, created_by: str,
                       description: str = "", color: str = "#41076B") -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO org_projects (id, org_id, name, description, color, created_by) VALUES (%s,%s,%s,%s,%s,%s)",
                (project_id, org_id, name, description, color, created_by)
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"create_org_project: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def update_org_project(project_id: str, updates: dict, org_id: str) -> bool:
    conn = _get_conn()
    if not conn: return False
    allowed = {"name", "description", "status", "color"}
    sets = {k: v for k, v in updates.items() if k in allowed}
    if not sets: return True
    try:
        with conn.cursor() as cur:
            cols = ", ".join(f"{k}=%s" for k in sets)
            cur.execute(f"UPDATE org_projects SET {cols}, updated_at=NOW() WHERE id=%s AND org_id=%s",
                        (*sets.values(), project_id, org_id))
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"update_org_project: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_org_docs(org_id: str, limit: int = 100) -> list:
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id, org_id, title, created_by, created_at, updated_at FROM org_docs WHERE org_id=%s ORDER BY updated_at DESC LIMIT %s",
                (org_id, limit)
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_org_docs: {exc}"); return []
    finally:
        _release(conn)


def search_org_docs(org_id: str, q: str, limit: int = 10) -> list:
    """Substring search (ILIKE, not ts_rank) over one org's docs, scoped to
    org_id -- there's no search_vector column on org_docs (that's a real
    schema migration, out of scope here, same boundary routes/search.py's
    module docstring draws for goals/skills/finance). get_org_docs()
    deliberately omits `content` for its list view's payload size; this
    fetches it since search needs to match against the body, not just the
    title."""
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, org_id, title, content, updated_at
                   FROM org_docs
                   WHERE org_id=%s AND (title ILIKE %s OR content ILIKE %s)
                   ORDER BY updated_at DESC
                   LIMIT %s""",
                (org_id, f"%{q}%", f"%{q}%", limit)
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"search_org_docs: {exc}"); return []
    finally:
        _release(conn)


def save_org_doc(org_id: str, doc_id: str, title: str, content: str, user_sid: str, yjs_state: str | None = None) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            if yjs_state is None:
                # Plain non-collab save (e.g. title-only edit) -- leave any
                # previously-persisted CRDT state untouched.
                cur.execute("""
                    INSERT INTO org_docs (id, org_id, title, content, created_by, updated_by)
                    VALUES (%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (id) DO UPDATE SET title=%s, content=%s, updated_by=%s, updated_at=NOW()
                """, (doc_id, org_id, title, content, user_sid, user_sid, title, content, user_sid))
            else:
                cur.execute("""
                    INSERT INTO org_docs (id, org_id, title, content, yjs_state, created_by, updated_by)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (id) DO UPDATE SET title=%s, content=%s, yjs_state=%s, updated_by=%s, updated_at=NOW()
                """, (doc_id, org_id, title, content, yjs_state, user_sid,
                      user_sid, title, content, yjs_state, user_sid))
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"save_org_doc: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_org_doc(doc_id: str) -> dict | None:
    conn = _get_conn()
    if not conn: return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM org_docs WHERE id=%s", (doc_id,))
            row = cur.fetchone()
            return dict(row) if row else None
    except Exception as exc:
        log.error(f"get_org_doc: {exc}"); return None
    finally:
        _release(conn)


def delete_org_doc(doc_id: str, org_id: str) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM org_docs WHERE id=%s AND org_id=%s", (doc_id, org_id))
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"delete_org_doc: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_org_messages(org_id: str, channel: str = "general", limit: int = 60) -> list:
    with _timed("get_org_messages"):
        conn = _get_conn()
        if not conn: return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT * FROM org_messages WHERE org_id=%s AND channel=%s ORDER BY created_at DESC LIMIT %s",
                    (org_id, channel, limit)
                )
                return list(reversed([dict(r) for r in cur.fetchall()]))
        except Exception as exc:
            log.error(f"get_org_messages: {exc}"); return []
        finally:
            _release(conn)


def search_org_messages(org_id: str, q: str, limit: int = 10) -> list:
    """Substring search (ILIKE) over one org's chat, scoped to org_id and
    across every channel -- unlike get_org_messages(), which is scoped to
    one channel at a time for the live chat view. No search_vector column
    here either, same reasoning as search_org_docs above."""
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """SELECT id, org_id, channel, content, author_name, created_at
                   FROM org_messages
                   WHERE org_id=%s AND content ILIKE %s
                   ORDER BY created_at DESC
                   LIMIT %s""",
                (org_id, f"%{q}%", limit)
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"search_org_messages: {exc}"); return []
    finally:
        _release(conn)


def send_org_message(org_id: str, channel: str, author_sid: str, author_name: str, content: str) -> dict | None:
    """Insert a message and return the full row (with id/created_at) or None on failure."""
    conn = _get_conn()
    if not conn: return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO org_messages (org_id, channel, content, author_sid, author_name) VALUES (%s,%s,%s,%s,%s) RETURNING *",
                (org_id, channel, content, author_sid, author_name)
            )
            row = dict(cur.fetchone())
        conn.commit()
        return row
    except Exception as exc:
        log.error(f"send_org_message: {exc}"); conn.rollback(); return None
    finally:
        _release(conn)


def get_org_messages_since(org_id: str, since_id: int, limit: int = 30) -> list:
    """Return messages with id > since_id for the org, all channels, ascending order."""
    with _timed("get_org_messages_since"):
        conn = _get_conn()
        if not conn: return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    "SELECT * FROM org_messages WHERE org_id=%s AND id > %s ORDER BY id ASC LIMIT %s",
                    (org_id, since_id, limit)
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as exc:
            log.error(f"get_org_messages_since: {exc}"); return []
        finally:
            _release(conn)


def prune_rate_limit_hits(older_than_seconds: int) -> None:
    """Delete rate_limit_hits rows older than the given age. Called by background cleanup task.

    Routed through _with_conn (unlike the rest of this file's manual
    _get_conn()/_release() functions) specifically because it's an infrequent
    scheduled job — its last-used pooled connection sits idle the longest
    between runs, making it the most likely to get culled by Supabase's
    transaction pooler and handed back out dead. The DELETE is a single
    idempotent statement, safe for _with_conn's transparent retry.
    """
    def _q(conn):
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM rate_limit_hits WHERE ts < NOW() - INTERVAL '1 second' * %s",
                (older_than_seconds,)
            )
        conn.commit()
        return None
    _with_conn("prune_rate_limit_hits", _q, None)


def db_check_rate_limit(key: str, limit: int, window_seconds: int) -> bool:
    """Sliding-window rate check backed by PostgreSQL. Returns True if allowed."""
    with _timed("db_check_rate_limit"):
        conn = _get_conn()
        if not conn: return True  # fail open when DB unavailable
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM rate_limit_hits WHERE key=%s AND ts < NOW() - INTERVAL '1 second' * %s",
                    (key, window_seconds)
                )
                cur.execute("SELECT COUNT(*) FROM rate_limit_hits WHERE key=%s", (key,))
                count = cur.fetchone()[0]
                if count >= limit:
                    conn.rollback()
                    return False
                cur.execute("INSERT INTO rate_limit_hits (key) VALUES (%s)", (key,))
            conn.commit()
            return True
        except Exception as exc:
            log.error(f"db_check_rate_limit: {exc}")
            try: conn.rollback()
            except Exception: pass
            return True  # fail open
        finally:
            _release(conn)


def upsert_presence(sid: str, org_id: str, name: str) -> None:
    conn = _get_conn()
    if not conn: return
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO user_presence (sid, org_id, name, last_seen)
                   VALUES (%s, %s, %s, NOW())
                   ON CONFLICT (sid, org_id) DO UPDATE SET name=EXCLUDED.name, last_seen=NOW()""",
                (sid, org_id, name)
            )
        conn.commit()
    except Exception as exc:
        log.error(f"upsert_presence: {exc}")
        try: conn.rollback()
        except Exception: pass
    finally:
        _release(conn)


def get_presence(org_id: str, cutoff_seconds: int = 90) -> list:
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT sid, name FROM user_presence WHERE org_id=%s AND last_seen > NOW() - INTERVAL '1 second' * %s",
                (org_id, cutoff_seconds)
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_presence: {exc}"); return []
    finally:
        _release(conn)


# ── Goals & OKRs ──────────────────────────────────────────────────────────────

def get_org_goals(org_id: str) -> list:
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM org_goals WHERE org_id=%s ORDER BY created_at ASC", (org_id,))
            goals = [dict(r) for r in cur.fetchall()]
            for g in goals:
                cur.execute("SELECT * FROM org_key_results WHERE goal_id=%s ORDER BY created_at ASC", (g['id'],))
                g['key_results'] = [dict(r) for r in cur.fetchall()]
            return goals
    except Exception as exc:
        log.error(f"get_org_goals: {exc}"); return []
    finally:
        _release(conn)


def create_org_goal(org_id: str, goal_id: str, title: str, created_by: str,
                    description: str = "", goal_type: str = "okr",
                    owner_sid: str = None, due_date: str = None) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO org_goals (id, org_id, title, description, type, owner_sid, due_date, created_by) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                (goal_id, org_id, title, description, goal_type, owner_sid, due_date or None, created_by)
            )
        conn.commit(); return True
    except Exception as exc:
        log.error(f"create_org_goal: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def update_org_goal(goal_id: str, org_id: str, title: str = None, description: str = None,
                    status: str = None, progress: int = None, due_date: str = None) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        fields, vals = [], []
        if title is not None:       fields.append("title=%s");       vals.append(title)
        if description is not None: fields.append("description=%s"); vals.append(description)
        if status is not None:      fields.append("status=%s");      vals.append(status)
        if progress is not None:    fields.append("progress=%s");    vals.append(progress)
        if due_date is not None:    fields.append("due_date=%s");    vals.append(due_date or None)
        if not fields: return True
        fields.append("updated_at=NOW()")
        vals.extend([goal_id, org_id])
        with conn.cursor() as cur:
            cur.execute(f"UPDATE org_goals SET {','.join(fields)} WHERE id=%s AND org_id=%s", vals)
        conn.commit(); return True
    except Exception as exc:
        log.error(f"update_org_goal: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def delete_org_goal(goal_id: str, org_id: str) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM org_goals WHERE id=%s AND org_id=%s", (goal_id, org_id))
        conn.commit(); return True
    except Exception as exc:
        log.error(f"delete_org_goal: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def create_org_key_result(kr_id: str, goal_id: str, org_id: str, title: str,
                          target_value: float = 100, unit: str = "%") -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO org_key_results (id, goal_id, org_id, title, target_value, unit) VALUES (%s,%s,%s,%s,%s,%s)",
                (kr_id, goal_id, org_id, title, target_value, unit)
            )
        conn.commit(); return True
    except Exception as exc:
        log.error(f"create_org_key_result: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def update_org_key_result(kr_id: str, org_id: str, current_value: float = None, status: str = None) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        fields, vals = [], []
        if current_value is not None: fields.append("current_value=%s"); vals.append(current_value)
        if status is not None:        fields.append("status=%s");        vals.append(status)
        if not fields: return True
        vals.extend([kr_id, org_id])
        with conn.cursor() as cur:
            cur.execute(f"UPDATE org_key_results SET {','.join(fields)} WHERE id=%s AND org_id=%s", vals)
        conn.commit(); return True
    except Exception as exc:
        log.error(f"update_org_key_result: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


# ── Founder Mode ──────────────────────────────────────────────────────────────

def get_org_founder(org_id: str) -> dict:
    conn = _get_conn()
    if not conn: return {}
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM org_founder WHERE org_id=%s", (org_id,))
            row = cur.fetchone()
            return dict(row) if row else {}
    except Exception as exc:
        log.error(f"get_org_founder: {exc}"); return {}
    finally:
        _release(conn)


def save_org_founder(org_id: str, burn_rate: float = 0, cash_balance: float = 0,
                     mrr: float = 0, arr: float = 0, funding_stage: str = "pre-seed",
                     total_raised: float = 0, investors: list = None,
                     milestones: list = None) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO org_founder (org_id, burn_rate, cash_balance, mrr, arr, funding_stage, total_raised, investors, milestones)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (org_id) DO UPDATE SET
                  burn_rate=%s, cash_balance=%s, mrr=%s, arr=%s,
                  funding_stage=%s, total_raised=%s, investors=%s, milestones=%s, updated_at=NOW()
            """, (
                org_id, burn_rate, cash_balance, mrr, arr, funding_stage, total_raised,
                json.dumps(investors or []), json.dumps(milestones or []),
                burn_rate, cash_balance, mrr, arr, funding_stage, total_raised,
                json.dumps(investors or []), json.dumps(milestones or [])
            ))
        conn.commit(); return True
    except Exception as exc:
        log.error(f"save_org_founder: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


# ── Announcements ────────────────────────────────────────────────────────────

def create_org_announcement(org_id: str, ann_id: str, title: str, body: str,
                             author_sid: str, author_name: str, pinned: bool = False) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO org_announcements (id, org_id, title, body, author_sid, author_name, pinned) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (ann_id, org_id, title, body, author_sid, author_name, pinned)
            )
        conn.commit(); return True
    except Exception as exc:
        log.error(f"create_org_announcement: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_org_announcements(org_id: str, limit: int = 50) -> list:
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM org_announcements WHERE org_id=%s ORDER BY pinned DESC, created_at DESC LIMIT %s",
                (org_id, limit)
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_org_announcements: {exc}"); return []
    finally:
        _release(conn)


def delete_org_announcement(ann_id: str) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM org_announcements WHERE id=%s", (ann_id,))
        conn.commit(); return True
    except Exception as exc:
        log.error(f"delete_org_announcement: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def db_now():
    """Return the database server's current timestamp (used as a real-time cursor
    baseline so all Gunicorn workers compare against the same clock)."""
    conn = _get_conn()
    if not conn: return None
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT NOW()")
            return cur.fetchone()[0]
    except Exception as exc:
        log.error(f"db_now: {exc}"); return None
    finally:
        _release(conn)


def get_org_announcements_since(org_id: str, since, limit: int = 20) -> list:
    """Announcements created strictly after `since` (a DB timestamp), oldest first.
    Used by the org SSE stream to push new announcements to everyone live."""
    if since is None:
        return []
    conn = _get_conn()
    if not conn: return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM org_announcements WHERE org_id=%s AND created_at > %s ORDER BY created_at ASC LIMIT %s",
                (org_id, since, limit)
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"get_org_announcements_since: {exc}"); return []
    finally:
        _release(conn)


# ── Analytics ────────────────────────────────────────────────────────────────

def get_org_analytics(org_id: str) -> dict:
    conn = _get_conn()
    if not conn: return {}
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT COUNT(*) AS cnt FROM org_members WHERE org_id=%s", (org_id,))
            members = cur.fetchone()['cnt']

            cur.execute("SELECT COUNT(*) AS cnt FROM org_tasks WHERE org_id=%s", (org_id,))
            tasks_total = cur.fetchone()['cnt']

            cur.execute("SELECT COUNT(*) AS cnt FROM org_tasks WHERE org_id=%s AND status='done'", (org_id,))
            tasks_done = cur.fetchone()['cnt']

            cur.execute("SELECT COUNT(*) AS cnt FROM org_messages WHERE org_id=%s", (org_id,))
            messages = cur.fetchone()['cnt']

            cur.execute("SELECT COUNT(*) AS cnt FROM org_docs WHERE org_id=%s", (org_id,))
            docs = cur.fetchone()['cnt']

            cur.execute(
                "SELECT status, COUNT(*) AS cnt FROM org_tasks WHERE org_id=%s GROUP BY status",
                (org_id,)
            )
            status_breakdown = {r['status']: r['cnt'] for r in cur.fetchall()}

            cur.execute(
                "SELECT DATE(created_at) AS day, COUNT(*) AS cnt FROM org_messages WHERE org_id=%s AND created_at > NOW() - INTERVAL '7 days' GROUP BY day ORDER BY day",
                (org_id,)
            )
            msg_trend = [dict(r) for r in cur.fetchall()]

        completion_rate = round((tasks_done / tasks_total * 100) if tasks_total else 0, 1)
        return {
            "members": members,
            "tasks_total": tasks_total,
            "tasks_done": tasks_done,
            "completion_rate": completion_rate,
            "messages": messages,
            "docs": docs,
            "status_breakdown": status_breakdown,
            "msg_trend": msg_trend,
        }
    except Exception as exc:
        log.error(f"get_org_analytics: {exc}"); return {}
    finally:
        _release(conn)


# ── Org Integrations (Paystack, Mono, etc.) ──────────────────────────────────

def save_org_integration(org_id: str, provider: str, secret_key: str,
                          public_key: str = "", meta: dict | None = None) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO org_integrations (org_id, provider, secret_key, public_key, meta, updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (org_id, provider) DO UPDATE
                SET secret_key = EXCLUDED.secret_key,
                    public_key = EXCLUDED.public_key,
                    meta = EXCLUDED.meta,
                    updated_at = NOW()
            """, (org_id, provider, _enc_secret(secret_key), public_key, json.dumps(meta or {})))
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"save_org_integration: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def get_org_integration(org_id: str, provider: str) -> dict | None:
    conn = _get_conn()
    if not conn: return None
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM org_integrations WHERE org_id=%s AND provider=%s",
                (org_id, provider)
            )
            row = cur.fetchone()
            if not row:
                return None
            d = dict(row)
            d["secret_key"] = _dec_secret(d.get("secret_key", ""))
            return d
    except Exception as exc:
        log.error(f"get_org_integration: {exc}"); return None
    finally:
        _release(conn)


def delete_org_integration(org_id: str, provider: str) -> bool:
    conn = _get_conn()
    if not conn: return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM org_integrations WHERE org_id=%s AND provider=%s",
                (org_id, provider)
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"delete_org_integration: {exc}"); conn.rollback(); return False
    finally:
        _release(conn)


def save_feedback(sid: str, rating: int, text: str, page: str = "") -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO feedback (sid, rating, text, page) VALUES (%s, %s, %s, %s)",
                (sid, rating, text, page)
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"save_feedback: {exc}"); conn.rollback()
        return False
    finally:
        _release(conn)


# ── MP3: Marketplace seed data ────────────────────────────────────────────────

_SEED_AGENT_ID = "sivarr_seed_agent"

_SEED_TEMPLATES = [
    {
        "id": "seed_copy_assistant",
        "name": "Copy Assistant",
        "short_description": "Writes social captions, emails, product descriptions, and ad copy from a brief.",
        "category": "ai_prompts",
        "price": 0.0,
        "price_ngn": 0.0,
        "thumbnail_color": "#4f6ef7",
        "tags": ["copywriting", "social media", "email"],
    },
    {
        "id": "seed_startup_analyst",
        "name": "Startup Analyst",
        "short_description": "Analyses your metrics and writes weekly founder briefings from your data.",
        "category": "workspace",
        "price": 0.0,
        "price_ngn": 500.0,
        "thumbnail_color": "#22c55e",
        "tags": ["founders", "metrics", "briefing"],
    },
    {
        "id": "seed_study_coach",
        "name": "Study Coach",
        "short_description": "Creates personalised study plans, flashcards, and quizzes you on weak areas.",
        "category": "academic",
        "price": 0.0,
        "price_ngn": 0.0,
        "thumbnail_color": "#f59e0b",
        "tags": ["study", "flashcards", "quiz"],
    },
    {
        "id": "seed_outreach_pro",
        "name": "Outreach Pro",
        "short_description": "Writes cold emails, follow-ups, and investor updates from bullet-point notes.",
        "category": "ai_prompts",
        "price": 0.0,
        "price_ngn": 1200.0,
        "thumbnail_color": "#7c3aed",
        "tags": ["outreach", "email", "investors"],
    },
    {
        "id": "seed_daily_planner",
        "name": "Daily Planner",
        "short_description": "Builds a prioritised daily schedule from your tasks and calendar each morning.",
        "category": "workspace",
        "price": 0.0,
        "price_ngn": 0.0,
        "thumbnail_color": "#41076B",
        "tags": ["planning", "productivity", "schedule"],
    },
    {
        "id": "seed_research_digest",
        "name": "Research Digest",
        "short_description": "Summarises articles, PDFs, and web pages into key points and action items.",
        "category": "academic",
        "price": 0.0,
        "price_ngn": 800.0,
        "thumbnail_color": "#ef4444",
        "tags": ["research", "summary", "reading"],
    },
    # ── Sprint C: Nigerian-context marketplace templates ──
    # category must be one of the frontend's tabs: workspace/academic/ai_prompts/
    # goals/journal/study_decks. download_count + avg_rating drive popularity sort
    # and the rating badge. price (USD) is kept at 0 so "Get" installs free — these
    # are demo templates with no real deliverable; a non-zero price_ngn only shows a
    # price tag in NGN view (matching the existing seed templates' pattern).
    {
        "id": "seed_nysc_planner",
        "name": "Daily NYSC Task Planner",
        "short_description": "Generates a daily task list for corps members from PPA duties, CDS schedule, and personal goals.",
        "category": "workspace",
        "price": 0.0, "price_ngn": 0.0,
        "thumbnail_color": "#41076B",
        "tags": ["nysc", "tasks", "daily-planning"],
        "download_count": 234, "avg_rating": 4.7,
    },
    {
        "id": "seed_jamb_waec_planner",
        "name": "JAMB/WAEC Study Planner",
        "short_description": "Breaks any subject into a 60-day study schedule with daily targets and past-question recommendations.",
        "category": "academic",
        "price": 0.0, "price_ngn": 0.0,
        "thumbnail_color": "#d97706",
        "tags": ["jamb", "waec", "study", "education"],
        "download_count": 891, "avg_rating": 4.9,
    },
    {
        "id": "seed_freelance_pipeline",
        "name": "Freelance Invoice & Pipeline Manager",
        "short_description": "Track client proposals, invoices, and payments in one view, with AI reminders for follow-ups and overdue invoices.",
        "category": "workspace",
        "price": 0.0, "price_ngn": 1500.0,
        "thumbnail_color": "#4f6ef7",
        "tags": ["freelance", "invoice", "crm"],
        "download_count": 127, "avg_rating": 4.5,
    },
    {
        "id": "seed_lagos_commute",
        "name": "Lagos Traffic & Commute Optimizer",
        "short_description": "Plan your week around Lagos traffic — set your locations and get the best departure windows and remote-work days.",
        "category": "workspace",
        "price": 0.0, "price_ngn": 0.0,
        "thumbnail_color": "#7c3aed",
        "tags": ["lagos", "traffic", "commute"],
        "download_count": 456, "avg_rating": 4.3,
    },
    {
        "id": "seed_startup_okr",
        "name": "Startup OKR Builder",
        "short_description": "Generate quarterly OKRs for early-stage startups from your company description and growth goals. Syncs to your Org Space.",
        "category": "goals",
        "price": 0.0, "price_ngn": 2000.0,
        "thumbnail_color": "#22c55e",
        "tags": ["okr", "startup", "goals"],
        "download_count": 89, "avg_rating": 4.6,
    },
    {
        "id": "seed_naija_meal_planner",
        "name": "Naija Meal Planner + Budget Tracker",
        "short_description": "Plan weekly Nigerian meals with market prices from Lagos, Abuja, and Port Harcourt, and track food spend against your budget.",
        "category": "workspace",
        "price": 0.0, "price_ngn": 0.0,
        "thumbnail_color": "#d85a30",
        "tags": ["food", "budget", "nigeria"],
        "download_count": 1203, "avg_rating": 4.8,
    },
    {
        "id": "seed_interview_coach",
        "name": "Tech Interview Prep Coach",
        "short_description": "Daily DSA problems, system-design prompts, and behavioral drills. Tracks your prep streak and weak areas over time.",
        "category": "academic",
        "price": 0.0, "price_ngn": 1000.0,
        "thumbnail_color": "#185FA5",
        "tags": ["interview", "dsa", "tech-jobs"],
        "download_count": 318, "avg_rating": 4.7,
    },
    {
        "id": "seed_finance_tracker_ngn",
        "name": "Personal Finance Tracker (₦)",
        "short_description": "Log income and expenses in Naira and get AI savings recommendations, spending breakdowns, and monthly summaries.",
        "category": "goals",
        "price": 0.0, "price_ngn": 0.0,
        "thumbnail_color": "#1D9E75",
        "tags": ["finance", "savings", "naira"],
        "download_count": 2147, "avg_rating": 4.9,
    },
]


def seed_marketplace_templates() -> None:
    """Idempotently insert the seed agent + its templates (additive). Existing
    rows are never overwritten (ON CONFLICT DO NOTHING). Safe on every startup."""
    conn = _get_conn()
    if not conn:
        return
    try:
        total_dl   = sum(int(t.get("download_count", 0) or 0) for t in _SEED_TEMPLATES)
        rated      = [float(t["avg_rating"]) for t in _SEED_TEMPLATES if t.get("avg_rating")]
        agent_rate = round(sum(rated) / len(rated), 2) if rated else 0.0
        with conn.cursor() as cur:
            # The seed agent's user_sid FKs to users(sid); without a matching
            # users row the agent INSERT raises an IntegrityError and the whole
            # seed rolls back (this is why the marketplace was coming up empty).
            # Create the backing user first, idempotently.
            cur.execute("""
                INSERT INTO users (sid, name)
                VALUES (%s, %s)
                ON CONFLICT (sid) DO NOTHING
            """, (_SEED_AGENT_ID, "Sivarr Team"))

            # Seed agent row (templates FK to agents).
            cur.execute("""
                INSERT INTO agents (id, user_sid, display_name, bio, status, verified,
                                    total_downloads, avg_rating)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
            """, (_SEED_AGENT_ID, _SEED_AGENT_ID, "Sivarr Team",
                  "Official Sivarr workspace templates.", "active", True,
                  total_dl, agent_rate))

            # Insert each template idempotently — additive, so new seed templates
            # land even when the table already holds earlier seeds.
            for t in _SEED_TEMPLATES:
                cur.execute("""
                    INSERT INTO agent_templates
                        (id, agent_id, name, short_description, category, price, price_ngn,
                         thumbnail_color, tags, contents, included_items, status, download_count, avg_rating)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,'{}','[]','published',%s,%s)
                    ON CONFLICT (id) DO NOTHING
                """, (
                    t["id"], _SEED_AGENT_ID, t["name"], t["short_description"],
                    t["category"], t["price"], t["price_ngn"], t["thumbnail_color"],
                    json.dumps(t["tags"]), int(t.get("download_count", 0) or 0),
                    float(t.get("avg_rating", 0.0) or 0.0),
                ))

            # Correct legacy seed-template categories that predate the valid
            # marketplace tab set (writing/finance match no tab, so those
            # templates only appeared under "All"). Idempotent: the AND guard
            # makes it a no-op once corrected.
            cur.execute("UPDATE agent_templates SET category = 'ai_prompts' "
                        "WHERE id IN ('seed_copy_assistant','seed_outreach_pro') "
                        "AND category = 'writing'")
            cur.execute("UPDATE agent_templates SET category = 'workspace' "
                        "WHERE id = 'seed_startup_analyst' AND category = 'finance'")
        conn.commit()
        log.info(f"Seeded {len(_SEED_TEMPLATES)} marketplace templates")
    except Exception as exc:
        log.error(f"seed_marketplace_templates: {exc}")
        conn.rollback()


# ── AI retrieval: embeddings (Session 9) ────────────────────────────────
# See the schema comment above the `embeddings` table for why there is no
# JSON-file fallback for any of this -- every function here is a plain no-op
# (empty list / False / None) when the table isn't there, exactly like every
# `is_available()`-gated table elsewhere in this file. Callers (the indexing
# job, and Session 10's retrieval) are expected to check
# embeddings_available() once up front rather than let every call fail
# individually, but nothing below actually requires that -- an unavailable
# table just makes each function return its empty default via the except
# clause.

_embeddings_available: bool | None = None  # cached; None = not yet checked


def embeddings_available() -> bool:
    """Whether the embeddings table (and the pgvector extension it needs)
    actually exist and are queryable -- not just whether DATABASE_URL is
    set. Checked once per process and cached, same reasoning as
    init_db()'s _schema_ready: this gets called on every retrieval attempt
    and every indexing pass, so it must be cheap after the first call."""
    global _embeddings_available
    if _embeddings_available is not None:
        return _embeddings_available
    if not is_available():
        _embeddings_available = False
        return False
    conn = _get_conn()
    if not conn:
        return False  # transient -- don't cache a connection failure as "unavailable forever"
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.embeddings')")
            _embeddings_available = cur.fetchone()[0] is not None
        # Teach psycopg2 how to (de)serialize the `vector` column -- without
        # this every embeddings query would round-trip floats as opaque
        # strings. Registered globally (once) rather than per-connection:
        # this process only ever talks to one Postgres, so the type OID is
        # the same on every pooled connection.
        if _embeddings_available and PGVECTOR_PY_AVAILABLE:
            try:
                register_vector(conn, globally=True)
            except Exception as exc:
                log.warning(f"pgvector type registration failed: {exc}")
                _embeddings_available = False
    except Exception as exc:
        log.warning(f"embeddings_available check failed: {exc}")
        _embeddings_available = False
    finally:
        _release(conn)
    return _embeddings_available


def get_embedding_chunk(sid: str, source_type: str, source_id: str) -> str | None:
    """The chunk_text currently stored for this item, or None if it isn't
    indexed yet. The indexing job compares its freshly-built chunk_text
    against this before calling the embedding API -- an unchanged item is
    skipped, which is what makes indexing incremental rather than a full
    re-embed on every run."""
    conn = _get_conn()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT chunk_text FROM embeddings WHERE sid=%s AND source_type=%s AND source_id=%s",
                (sid, source_type, source_id),
            )
            row = cur.fetchone()
            return row[0] if row else None
    except Exception as exc:
        log.error(f"get_embedding_chunk: {exc}")
        return None
    finally:
        _release(conn)


def upsert_embedding(sid: str, source_type: str, source_id: str, chunk_text: str, vector: list[float]) -> bool:
    conn = _get_conn()
    if not conn:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO embeddings (sid, source_type, source_id, chunk_text, embedding, updated_at)
                   VALUES (%s,%s,%s,%s,%s,NOW())
                   ON CONFLICT (sid, source_type, source_id)
                   DO UPDATE SET chunk_text=EXCLUDED.chunk_text, embedding=EXCLUDED.embedding, updated_at=NOW()""",
                (sid, source_type, source_id, chunk_text, vector),
            )
        conn.commit()
        return True
    except Exception as exc:
        log.error(f"upsert_embedding: {exc}")
        conn.rollback()
        return False
    finally:
        _release(conn)


def prune_embeddings(sid: str, source_type: str, keep_ids: list[str]) -> int:
    """Delete indexed rows for (sid, source_type) whose source_id is no
    longer among the caller's current live items -- covers both a real
    delete and a soft-delete (the indexing job excludes deleted_at items
    from keep_ids), so retrieval never surfaces something the user removed.
    An empty keep_ids is a legitimate "user has none of this type left",
    not "caller forgot to pass anything" -- it still deletes everything
    under that (sid, source_type)."""
    conn = _get_conn()
    if not conn:
        return 0
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM embeddings WHERE sid=%s AND source_type=%s AND NOT (source_id = ANY(%s))",
                (sid, source_type, keep_ids),
            )
            count = cur.rowcount
        conn.commit()
        return count
    except Exception as exc:
        log.error(f"prune_embeddings: {exc}")
        conn.rollback()
        return 0
    finally:
        _release(conn)


def search_embeddings(sid: str, query_vector: list[float], limit: int = 5, source_types: list[str] | None = None) -> list[dict]:
    """Top-`limit` chunks for one user by cosine distance (`<=>`), nearest
    first -- for Session 10's retrieval. Always scoped by sid; there is no
    variant of this function that isn't, on purpose (cross-user retrieval
    must be structurally impossible, not just usually-correct)."""
    conn = _get_conn()
    if not conn:
        return []
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # register_vector(..., globally=True) (see embeddings_available())
            # only teaches psycopg2 how to READ a vector column back as a
            # Python list -- it does not make a bare list parameter adapt AS
            # a vector on the way in. Without an explicit ::vector cast here,
            # psycopg2's default list adapter sends query_vector as a plain
            # Postgres array, and `embedding <=> numeric[]` has no such
            # operator -- this raised on every call until caught by a live
            # pgvector integration test, not by the schema/import checks
            # (those can't see a parameter-typing issue at all). An INSERT
            # into an `embedding VECTOR(768)` column doesn't need this
            # because Postgres infers the parameter's type from the target
            # column; a bare `<=>` expression has no such target to infer
            # from, so the cast has to be explicit.
            if source_types:
                cur.execute(
                    """SELECT source_type, source_id, chunk_text, 1 - (embedding <=> %s::vector) AS similarity
                       FROM embeddings
                       WHERE sid=%s AND source_type = ANY(%s)
                       ORDER BY embedding <=> %s::vector
                       LIMIT %s""",
                    (query_vector, sid, source_types, query_vector, limit),
                )
            else:
                cur.execute(
                    """SELECT source_type, source_id, chunk_text, 1 - (embedding <=> %s::vector) AS similarity
                       FROM embeddings
                       WHERE sid=%s
                       ORDER BY embedding <=> %s::vector
                       LIMIT %s""",
                    (query_vector, sid, query_vector, limit),
                )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        log.error(f"search_embeddings: {exc}")
        return []
    finally:
        _release(conn)
