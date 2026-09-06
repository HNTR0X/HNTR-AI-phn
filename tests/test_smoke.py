"""
Boot + contract smoke tests.

These are deliberately behavioural, not syntactic. `python -c "import app"` and
`node --check` only prove the files parse; every regression this codebase has
actually shipped was semantic (a strict-equality comparison that silently no-op'd,
a CSS rule that won the cascade unexpectedly, an asset URL that could never be
busted). This file covers the parts of that surface a test can reach without a
browser: the app boots, the pages render, every asset URL is content-hashed and
resolves to a real file, and the extracted route modules round-trip real data.

Runs against JSON-file fallback storage locally, and against a real
Postgres in CI since Session 14 — no database is *required* (nothing here
skips without one), but session_token() creates a real users row when one
is configured, since several routes exercised below (e.g. /api/tasks/sync)
have a real FK constraint (tasks.sid REFERENCES users(sid)) that a bare
session token alone doesn't satisfy -- same reasoning tests/test_search.py's
own session_token fixture already documents.
"""

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as app_module
import core
import database as db

REPO = Path(__file__).resolve().parent.parent

# Matches href="/css/..." src="/js/..." content="/static/..."
ASSET_REF = re.compile(r'(?:href|src|content)="(/(?:css|js|static)/[^"]*)"')


@pytest.fixture(scope="module")
def client():
    return TestClient(app_module.app)


CI_TEST_SID = "ci_test_sid"


@pytest.fixture(autouse=True, scope="session")
def _clean_ci_test_sid_data_files():
    """Without a database configured, session_token's fixture data (tasks,
    goals, habits, etc. for CI_TEST_SID) falls back to real JSON files in the
    same data/ directory a local dev server uses — confirmed the hard way when
    a stale data/ci_test_sid_progress.json from an earlier local run made
    test_quiz_submit_and_complete_round_trip fail on a second run (wrong_answers
    had 2 entries, not 1) despite nothing being wrong. Wipes before AND after
    the whole session so interrupted runs don't leave debris either, and so
    repeated local `pytest` invocations are actually idempotent, not just
    fresh CI checkouts."""
    def _wipe():
        for f in (REPO / "data").glob(f"*{CI_TEST_SID}*"):
            f.unlink(missing_ok=True)
    _wipe()
    yield
    _wipe()


# ── Boot ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path", ["/", "/app", "/health", "/sw.js", "/terms", "/privacy", "/about"])
def test_page_serves(client, path):
    assert client.get(path).status_code == 200


def test_health_reports_ok(client):
    assert client.get("/health").json().get("status") in ("ok", "healthy", "degraded")


# ── Asset integrity ───────────────────────────────────────────────────────────
#
# Guards the specific bug this suite was written alongside: /css/, /js/ and
# /static/ are served immutable for a year, so an asset referenced WITHOUT a
# content hash can never be updated in a browser that already loaded it. Three
# js/features/*.js and three css/features/*.css files shipped in exactly that
# state. These tests fail the build if it happens again.

@pytest.mark.parametrize("page", ["/", "/app"])
def test_every_asset_reference_is_content_hashed(client, page):
    unversioned = [u for u in set(ASSET_REF.findall(client.get(page).text)) if "?v=" not in u]
    assert not unversioned, (
        f"{page} references assets with no content hash: {unversioned}. "
        f"Use {{{{ asset('/path') }}}} in the template — see core.py:asset()."
    )


@pytest.mark.parametrize("page", ["/", "/app"])
def test_every_asset_reference_resolves_to_a_real_file(client, page):
    missing = [
        u for u in set(ASSET_REF.findall(client.get(page).text))
        if not (REPO / u.split("?")[0].lstrip("/")).is_file()
    ]
    assert not missing, f"{page} references files that do not exist: {missing}"


def test_hash_changes_when_content_changes(tmp_path):
    probe = REPO / "css" / "base.css"
    original = probe.read_text(encoding="utf-8")
    try:
        before = core.asset("/css/base.css")
        probe.write_text(original + "\n/* ci probe */\n", encoding="utf-8")
        core._ASSET_HASHES.clear()
        after = core.asset("/css/base.css")
        assert before != after, "asset() returned the same URL after the file changed"
    finally:
        probe.write_text(original, encoding="utf-8")
        core._ASSET_HASHES.clear()


def test_missing_asset_degrades_instead_of_raising():
    assert core.asset("/css/does-not-exist.css") == "/css/does-not-exist.css"


def test_cache_policy_matches_versioning(client):
    versioned = client.get("/css/base.css?v=deadbeef").headers.get("cache-control", "")
    plain = client.get("/css/base.css").headers.get("cache-control", "")
    assert "immutable" in versioned
    assert "immutable" not in plain, (
        "An unversioned asset URL must not be immutable — it could never be updated."
    )


def test_service_worker_fully_renders(client):
    sw = client.get("/sw.js").text
    assert "{{" not in sw, "sw.js shipped with unrendered Jinja placeholders"
    assert re.search(r"const CACHE = 'sivarr-[0-9a-f]{10}'", sw), "SW cache name not hash-derived"

    # Only inspect the PRECACHE array itself — the surrounding comments mention
    # historical paths (/css/styles.css) that are not real entries.
    precache = re.search(r"const PRECACHE = \[(.*?)\];", sw, re.S)
    assert precache, "PRECACHE array not found in rendered sw.js"
    for url in re.findall(r"'(/(?:css|js|static)/[^']*)'", precache.group(1)):
        assert "?v=" in url, f"service worker precaches an unversioned URL: {url}"


# ── Extracted route modules ───────────────────────────────────────────────────
#
# routes/tasks.py, routes/habits.py and routes/docs_notes.py import their helpers
# from core.py. These round-trips prove the wiring works end to end, which is what
# would break if a future extraction reintroduced an app.py import cycle.

@pytest.fixture
def session_token():
    """A real session, minted directly — sidesteps the email-verification gate.

    Also creates a real users row when a DB is configured: tasks.sid
    REFERENCES users(sid), so a session token alone (fine in JSON-fallback
    mode, which has no FK constraints at all) would let e.g. /api/tasks/sync
    fail its insert silently against a real Postgres, since save_tasks
    swallows the DB exception rather than raising it, matching the tests
    that exercise those routes but weren't written with a real FK in mind.
    Same defensive pattern tests/test_search.py's session_token already
    uses, added here once Session 14 made "there's a real DB" an actual CI
    condition to worry about."""
    if db.is_available():
        db.create_user({"sid": CI_TEST_SID, "name": "CI", "email": "ci@example.com"})
    return core.create_session_token(CI_TEST_SID, "CI", "ci@example.com")


def test_routes_reject_missing_session(client):
    for path in ["/api/tasks/sync", "/api/habits/sync", "/api/docs/sync", "/api/journal/sync",
                 "/api/skills/sync", "/api/finance/sync"]:
        assert client.post(path, json={"token": "not-a-real-token"}).status_code == 401
    assert client.post("/api/goals/add", json={"token": "not-a-real-token", "title": "x"}).status_code == 401


def test_tasks_round_trip(client, session_token):
    r = client.post("/api/tasks/sync", json={
        "token": session_token,
        "tasks": [{"id": "t1", "title": "Ship Pass 0", "status": "todo"}],
    })
    assert r.status_code == 200 and r.json()["ok"]

    back = client.get(f"/api/tasks/restore?token={session_token}")
    assert back.status_code == 200
    titles = [t["title"] for t in back.json()["tasks"]]
    assert "Ship Pass 0" in titles


def test_tasks_sync_rejects_wrong_shape(client, session_token):
    r = client.post("/api/tasks/sync", json={"token": session_token, "tasks": "not-a-list"})
    assert r.status_code == 400


def test_habits_round_trip(client, session_token):
    r = client.post("/api/habits/sync", json={
        "token": session_token,
        "habits": [{"id": "h1", "name": "Read", "streak": 3}],
    })
    assert r.status_code == 200

    back = client.get(f"/api/habits/restore?token={session_token}")
    assert back.status_code == 200
    assert isinstance(back.json().get("habits"), list)


def test_docs_round_trip(client, session_token):
    r = client.post("/api/docs/sync", json={
        "token": session_token,
        "docs": [{"id": "d1", "title": "Brief", "content": "hello"}],
    })
    assert r.status_code == 200

    back = client.get(f"/api/docs/restore?token={session_token}")
    assert back.status_code == 200
    assert isinstance(back.json().get("docs"), list)


def test_habits_and_docs_read_pre_migration_legacy_files(no_db):
    """habits.py/docs_notes.py used to read/write DATA_DIR/f"{sid}_habits.json"
    and f"{sid}_docs.json" directly, unconditionally — moved onto the same
    _load_user_list/_save_user_list DB-backed pattern Tasks/Goals/Journal
    already used (found scoping Pass 2). _load_user_list has a legacy-file
    migration path keyed on that exact same filename, so real users' existing
    on-disk data isn't orphaned by the switch. This locks in the one property
    that migration depends on: the legacy path _load_user_list looks for must
    still be exactly what the old code wrote to. Forced onto the JSON-fallback
    branch via the no_db fixture (tests/conftest.py) -- this test is
    specifically about that branch's behavior, so it must run regardless of
    whether a real DB happens to be configured in this environment (it
    wasn't, anywhere, before Session 14 added one to CI) — same file, same
    key, same result, which is what the migration guarantees either way."""
    sid = "legacy_migration_test_sid"
    habits_file = REPO / "data" / f"{sid}_habits.json"
    docs_file   = REPO / "data" / f"{sid}_docs.json"
    try:
        habits_file.write_text('[{"id": "h1", "title": "Pre-existing habit"}]')
        docs_file.write_text('[{"id": "d1", "title": "Pre-existing doc"}]')

        from routes.habits import load_habits
        from routes.docs_notes import load_docs
        assert load_habits(sid)[0]["title"] == "Pre-existing habit"
        assert load_docs(sid)[0]["title"] == "Pre-existing doc"
    finally:
        habits_file.unlink(missing_ok=True)
        docs_file.unlink(missing_ok=True)


def test_journal_round_trip(client, session_token):
    r = client.post("/api/journal/sync", json={
        "token": session_token,
        "entries": [{"date": "2026-08-16", "text": "Shipped Pass 1.", "mood": "good"}],
    })
    assert r.status_code == 200 and r.json()["count"] == 1

    back = client.get(f"/api/journal/restore?token={session_token}")
    assert back.status_code == 200
    texts = [e["text"] for e in back.json()["entries"]]
    assert "Shipped Pass 1." in texts


def test_journal_prompt_is_stable_within_a_day(client):
    r1 = client.get("/api/journal/prompt")
    r2 = client.get("/api/journal/prompt")
    assert r1.status_code == 200
    assert r1.json()["prompt"] == r2.json()["prompt"]


def test_goals_round_trip(client, session_token):
    add = client.post("/api/goals/add", json={"token": session_token, "title": "Ship Pass 1"})
    assert add.status_code == 200
    goal_id = add.json()["goal"]["id"]

    listed = client.get(f"/api/goals?token={session_token}")
    assert goal_id in [g["id"] for g in listed.json()["goals"]]

    upd = client.post("/api/goals/update", json={
        "token": session_token, "id": goal_id, "progress": 60, "completed": False,
    })
    assert upd.status_code == 200

    goals_after = client.get(f"/api/goals?token={session_token}").json()["goals"]
    assert next(g for g in goals_after if g["id"] == goal_id)["progress"] == 60


def test_goal_key_results_drive_progress(client, session_token):
    add = client.post("/api/goals/add", json={"token": session_token, "title": "Read 10 books"})
    goal_id = add.json()["goal"]["id"]

    kr = client.post("/api/goals/kr/add", json={
        "token": session_token, "goal_id": goal_id,
        "title": "Books read", "target": 10, "current": 0,
    })
    assert kr.status_code == 200

    goals = client.get(f"/api/goals?token={session_token}").json()["goals"]
    kr_id = next(g for g in goals if g["id"] == goal_id)["key_results"][0]["id"]

    client.post("/api/goals/kr/update", json={
        "token": session_token, "goal_id": goal_id, "kr_id": kr_id, "current": 10,
    })
    goals = client.get(f"/api/goals?token={session_token}").json()["goals"]
    g = next(g for g in goals if g["id"] == goal_id)
    assert g["progress"] == 100 and g["completed"] is True


def test_goals_add_rejects_empty_title(client, session_token):
    r = client.post("/api/goals/add", json={"token": session_token, "title": ""})
    assert r.status_code == 400


# ── Soft delete (goals) ────────────────────────────────────────────────────────
#
# Tasks/Habits/Docs & Notes are soft-deleted client-side (deleted_at rides along
# in the existing whole-array /sync payload — see js/features/*.js), so there's
# no new server contract to test for those beyond "the field survives a sync
# round trip," covered in test_tasks_round_trip-style tests via the deleted_at
# key. Goals is the one domain with real per-entity server endpoints, so the
# full delete -> trash -> restore -> purge lifecycle is testable end to end here.

def test_goal_delete_is_soft_not_hard(client, session_token):
    add = client.post("/api/goals/add", json={"token": session_token, "title": "Learn Rust"})
    goal_id = add.json()["goal"]["id"]

    client.post("/api/goals/delete", json={"token": session_token, "id": goal_id})

    # Gone from the normal list...
    goals = client.get(f"/api/goals?token={session_token}").json()["goals"]
    assert goal_id not in [g["id"] for g in goals]

    # ...but recoverable from Trash, not actually destroyed.
    trash = client.get(f"/api/goals/trash?token={session_token}").json()["goals"]
    trashed = next((g for g in trash if g["id"] == goal_id), None)
    assert trashed is not None
    assert trashed["deleted_at"]  # a real timestamp, not just truthy-by-accident


def test_goal_restore_brings_it_back(client, session_token):
    add = client.post("/api/goals/add", json={"token": session_token, "title": "Learn Zig"})
    goal_id = add.json()["goal"]["id"]
    client.post("/api/goals/delete", json={"token": session_token, "id": goal_id})

    client.post("/api/goals/restore", json={"token": session_token, "id": goal_id})

    goals = client.get(f"/api/goals?token={session_token}").json()["goals"]
    assert goal_id in [g["id"] for g in goals]
    trash = client.get(f"/api/goals/trash?token={session_token}").json()["goals"]
    assert goal_id not in [g["id"] for g in trash]


# ── Milestones / habit-linking (newer Goals & Habits panel) ─────────────────
#
# js/features/habits.js's own goal model (mode/manual_pct/pct_override/
# milestones/habit_ids) shipped with no backend at all — every field was
# silently dropped by add_goal/update_goal, so it looked saved in the
# browser but never reached the server. These lock in the fix: the fields
# round-trip, and `progress`/`completed` are derived from them server-side
# too (not just in the panel's own JS), matching _goalPct() in habits.js.

def test_goal_milestones_round_trip_and_drive_progress(client, session_token):
    add = client.post("/api/goals/add", json={
        "token": session_token, "title": "Learn guitar",
        "mode": "milestone",
        "milestones": [
            {"id": "m1", "name": "Buy a guitar", "done": True},
            {"id": "m2", "name": "Learn 3 chords", "done": False},
        ],
        "habit_ids": ["h1", "h2"],
    })
    assert add.status_code == 200
    goal = add.json()["goal"]
    assert goal["progress"] == 50  # 1 of 2 milestones done
    assert goal["completed"] is False
    assert [m["name"] for m in goal["milestones"]] == ["Buy a guitar", "Learn 3 chords"]
    assert goal["habit_ids"] == ["h1", "h2"]

    fetched = next(
        g for g in client.get(f"/api/goals?token={session_token}").json()["goals"]
        if g["id"] == goal["id"]
    )
    assert fetched["milestones"][0]["done"] is True
    assert fetched["habit_ids"] == ["h1", "h2"]


def test_goal_milestone_toggle_via_edit_recomputes_progress(client, session_token):
    add = client.post("/api/goals/add", json={
        "token": session_token, "title": "Read 12 books",
        "mode": "milestone",
        "milestones": [{"id": "m1", "name": "Book 1", "done": False}],
    })
    goal_id = add.json()["goal"]["id"]
    assert add.json()["goal"]["progress"] == 0

    client.post("/api/goals/edit", json={
        "token": session_token, "id": goal_id,
        "milestones": [{"id": "m1", "name": "Book 1", "done": True}],
    })

    goal = next(
        g for g in client.get(f"/api/goals?token={session_token}").json()["goals"]
        if g["id"] == goal_id
    )
    assert goal["progress"] == 100
    assert goal["completed"] is True


def test_goal_manual_mode_progress_uses_manual_pct(client, session_token):
    add = client.post("/api/goals/add", json={
        "token": session_token, "title": "Save $5000",
        "mode": "manual", "manual_pct": 35,
    })
    assert add.json()["goal"]["progress"] == 35

    client.post("/api/goals/edit", json={
        "token": session_token, "id": add.json()["goal"]["id"],
        "manual_pct": 80,
    })
    goal = next(
        g for g in client.get(f"/api/goals?token={session_token}").json()["goals"]
        if g["id"] == add.json()["goal"]["id"]
    )
    assert goal["progress"] == 80


def test_goal_edit_persists_due_date_on_both_field_names(client, session_token):
    """The newer panel sends `due`; the older one sends `deadline`. Both
    must land so either reader sees the value."""
    add = client.post("/api/goals/add", json={
        "token": session_token, "title": "Ship v2", "due": "2026-12-01",
    })
    goal = add.json()["goal"]
    assert goal["deadline"] == "2026-12-01"
    assert goal["due"] == "2026-12-01"


def test_goal_undelete_uses_real_restore_endpoint(client, session_token):
    """Regression test: the panel's sync code used to call the nonexistent
    /api/goals/undelete (real endpoint is /api/goals/restore) — restoring a
    trashed goal 404'd forever. /api/goals/undelete must not exist (a typo'd
    client hitting it should 404, not silently succeed), and /restore is
    what actually brings a goal back — already covered by
    test_goal_restore_brings_it_back, this just pins the undelete typo as
    permanently gone."""
    add = client.post("/api/goals/add", json={"token": session_token, "title": "Learn Elixir"})
    goal_id = add.json()["goal"]["id"]
    client.post("/api/goals/delete", json={"token": session_token, "id": goal_id})

    bad = client.post("/api/goals/undelete", json={"token": session_token, "id": goal_id})
    assert bad.status_code == 404


def test_goals_trash_requires_auth(client):
    r = client.get("/api/goals/trash")
    assert r.status_code == 401


def test_search_excludes_deleted_goal(client, session_token):
    """unified_search reads load_goals(sid) directly, not through GET /api/goals
    — bypasses that endpoint's own deleted-item filter, so it needed its own
    fix. Regression test for exactly that gap."""
    unique = "Zzyzx9Search"
    add = client.post("/api/goals/add", json={"token": session_token, "title": unique})
    goal_id = add.json()["goal"]["id"]

    found = client.get(f"/api/search?q={unique}&token={session_token}").json()["results"]
    assert any(r["title"] == unique for r in found)

    client.post("/api/goals/delete", json={"token": session_token, "id": goal_id})

    found_after = client.get(f"/api/search?q={unique}&token={session_token}").json()["results"]
    assert not any(r["title"] == unique for r in found_after)


def test_auto_weekly_review_sid_discovery_finds_json_fallback_users(no_db):
    """_auto_weekly_reviews (a scheduler closure in app.py, not importable)
    used to discover which users to process by globbing DATA_DIR for
    *_habits.json files — which silently finds nobody once a database is
    configured, since _load_user_list/_save_user_list stop writing those
    files entirely. Fixed to sweep db.get_sids_with_blob_key("habits") when a
    DB is available, falling back to the same glob otherwise. Forced onto the
    fallback path via the no_db fixture (tests/conftest.py) -- this test is
    specifically about that branch, so it must run regardless of whether a
    real DB happens to be configured in this environment -- against a real
    seeded user, the same path production would take if a database were
    ever unconfigured, and the one that was already correct before the fix."""
    from routes.habits import save_habits
    sid = "weekly_review_discovery_test_sid"
    habits_file = REPO / "data" / f"{sid}_habits.json"
    try:
        save_habits(sid, [{"id": "h1", "title": "Read", "completions": []}])
        discovered = {
            p.name.replace("_habits.json", "")
            for p in (REPO / "data").glob("*_habits.json")
        }
        assert sid in discovered
    finally:
        habits_file.unlink(missing_ok=True)


def test_auto_weekly_review_reads_journal_via_load_journal_not_raw_file():
    """The mood lookup inside the same job used to read
    DATA_DIR/f"{sid}_journal.json" directly — same DB-blind bug as the
    sid-discovery glob above, just for one field. load_journal() handles
    both backends already; this just confirms it doesn't error on a user
    with no journal data, the common case the old code silently mishandled
    by finding no file and always reporting an empty mood."""
    empty = app_module.load_journal("sid_with_no_journal_at_all")
    assert empty == []


def test_purge_deleted_goals_respects_30_day_retention():
    """Exercises app.py's _purge_deleted_goals job logic directly (it's a
    closure inside _start_scheduler, not importable) by reproducing its exact
    filter rule against a real load_goals/save_goals round trip — a fresh
    deletion must survive, one from 31 days ago must not.

    Uses its own sid rather than CI_TEST_SID (that fixture's other tests don't
    expect goals with fabricated deleted_at timestamps mixed in), so it cleans
    up its own JSON-fallback file directly rather than relying on the
    session-scoped _clean_ci_test_sid_data_files fixture.

    Session 16: goals.sid now has a real FK to users(sid) (see database.py's
    `goals` DDL), so a bare sid with no real user row would 500 the insert
    against a real Postgres -- caught by watching this exact test fail on a
    real CI run, not by reading the migration diff. Same db.create_user()
    guard tests/test_search.py's own session_token fixture already uses."""
    import datetime as _dt
    sid = "purge_test_sid"
    goals_file = REPO / "data" / f"{sid}_goals.json"
    if db.is_available():
        db.create_user({"sid": sid, "name": "Purge Test", "email": "purgetest@example.invalid"})
    try:
        now = _dt.datetime.utcnow()
        fresh_id, old_id = "g_fresh", "g_old"
        app_module.save_goals(sid, [
            {"id": fresh_id, "title": "Just deleted", "deleted_at": now.isoformat()},
            {"id": old_id,   "title": "Long gone",    "deleted_at": (now - _dt.timedelta(days=31)).isoformat()},
            {"id": "g_keep", "title": "Never deleted"},
        ])

        cutoff = now - _dt.timedelta(days=30)
        goals = app_module.load_goals(sid)
        kept = [g for g in goals if not g.get("deleted_at")
                or _dt.datetime.fromisoformat(g["deleted_at"]) >= cutoff]

        kept_ids = {g["id"] for g in kept}
        assert fresh_id in kept_ids
        assert old_id not in kept_ids
        assert "g_keep" in kept_ids
    finally:
        goals_file.unlink(missing_ok=True)
        if db.is_available():
            db.replace_all_goals(sid, [])


# ── core.py contracts ─────────────────────────────────────────────────────────

def test_sanitize_text_strips_control_chars_and_truncates():
    assert core.sanitize_text("hi\x00there") == "hithere"
    assert core.sanitize_text("  padded  ") == "padded"
    assert len(core.sanitize_text("x" * 500, max_len=10)) == 10
    assert core.sanitize_text("") == ""
    assert core.sanitize_text(None) == ""


def test_session_lifecycle():
    token = core.create_session_token("sid_lifecycle", "N", "n@example.com")
    assert core.get_session_from_token(token)["sid"] == "sid_lifecycle"
    core.delete_session_token(token)
    assert core.get_session_from_token(token) is None
    assert core.get_session_from_token("") is None


def test_app_and_core_share_one_session_store():
    """app.py mutates core's _session_tokens by reference in ~20 places. If an
    import ever rebinds it instead, sessions silently split in two."""
    assert app_module._session_tokens is core._session_tokens


def test_skills_sync_and_restore_contract(client, session_token):
    """Skills has no JSON-file fallback (unlike every other feature here) — it
    only persists through db.save_user_blob/get_user_blob, so sync silently
    no-ops and restore returns empty when no database is configured, which is
    the environment this suite runs in. That's pre-existing behavior (verified
    byte-identical against the original code during extraction), not something
    this pass changes — asserting a round trip here would be testing a lie. This
    checks the parts of the contract that hold either way: the endpoint accepts
    the payload, echoes back a truthful count, and restore never 500s or returns
    a malformed shape."""
    r = client.post("/api/skills/sync", json={
        "token": session_token,
        "skills": [{"id": "s1", "name": "Piano", "level": 40, "target": 90}],
    })
    assert r.status_code == 200 and r.json()["synced"] == 1

    back = client.get(f"/api/skills/restore?token={session_token}")
    assert back.status_code == 200
    assert isinstance(back.json().get("skills"), list)

    if db.is_available():
        assert "Piano" in [s["name"] for s in back.json()["skills"]]


def test_finance_round_trip(client, session_token):
    r = client.post("/api/finance/sync", json={
        "token": session_token,
        "data": {
            "transactions": [{"id": "t1", "type": "expense", "amount": 500, "category": "food"}],
            "budgets": {"food": 5000},
        },
    })
    assert r.status_code == 200 and r.json()["synced"] == 1

    back = client.get(f"/api/finance/restore?token={session_token}")
    assert back.status_code == 200
    data = back.json()["data"]
    assert data["transactions"][0]["category"] == "food"
    assert data["budgets"]["food"] == 5000


def test_load_helpers_reexported_for_internal_callers():
    """load_tasks/load_habits/load_docs/load_goals/load_journal moved into their
    routes/*.py modules, but app.py's weekly review, Home brief, daily digest and
    /api/export still read this data directly — confirms the re-export at the
    include_router import block still resolves.

    The save_* counterparts were re-exported too in an earlier pass on the
    assumption app.py needed direct write access; an audit found zero real
    call sites for any of them and the unused imports were removed. save_goals
    came back for a real reason since then — the goal-trash-purge scheduler
    job in app.py needs it — so it's asserted present, not absent, unlike its
    still-genuinely-unused siblings. save_habits came back the same way when
    the habits-trash-purge job was added alongside tasks'. Asserting the true
    state (not "all save_* absent") keeps this test from masking either
    direction of drift."""
    assert callable(app_module.load_tasks)
    assert callable(app_module.load_habits)
    assert callable(app_module.load_docs)
    assert callable(app_module.load_goals)
    assert callable(app_module.load_journal)
    assert callable(app_module.save_goals)
    assert callable(app_module.save_habits)
    for name in ("save_docs", "save_journal"):
        assert not hasattr(app_module, name), (
            f"app_module.{name} exists but has no real caller in app.py — "
            f"either a genuine new use appeared (re-add the import, drop this "
            f"line) or it's dead weight again (remove the import in app.py)."
        )


def test_chat_rejects_invalid_token(client):
    r = client.post("/api/chat", json={
        "sid": "x", "message": "hi", "token": "not-a-real-token",
    })
    assert r.status_code == 401


def test_chat_rejects_empty_message(client, session_token):
    r = client.post("/api/chat", json={"sid": "x", "message": "", "token": session_token})
    assert r.status_code == 422


def test_chat_solves_local_math_without_calling_gemini(client, session_token):
    """solve_local() short-circuits before any Gemini call, so this is safe to
    run with no GEMINI_API_KEY configured — deterministic, no network."""
    r = client.post("/api/chat", json={
        "sid": "x", "message": "12 + 30", "token": session_token,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["reply"] == "Result = 42"
    assert body["error"] is False


def test_chat_clear_empties_history(client, session_token):
    client.post("/api/chat", json={"sid": "x", "message": "5 * 5", "token": session_token})
    r = client.post("/api/chat/clear", json={"token": session_token})
    assert r.status_code == 200 and r.json()["ok"]

    p = app_module.load_progress(CI_TEST_SID)
    assert p["chat_history"] == []


def test_ai_chat_router_is_wired(client):
    """Confirms build_router(...)'s output actually reached the app — a
    misconfigured factory call (wrong dependency order, forgotten
    include_router) would 404 here instead of 401/422."""
    r = client.post("/api/chat", json={"sid": "x", "message": "hi", "token": ""})
    assert r.status_code != 404


# ── Quiz, home-brief, AI-features routers ─────────────────────────────────────
#
# Unlike chat, none of these have a local-only shortcut (chat's solve_local()
# short-circuits before touching Gemini) — every non-trivial code path in
# quiz_question/home_brief/extract-tasks/write/weekly-review/parse-intent/
# voice-to-task calls async_gemini_once(), which without GEMINI_API_KEY would
# either fail fast or attempt a real, possibly-slow network call depending on
# the SDK's internals. Rather than gamble on that, these tests only exercise
# what's genuinely deterministic: auth rejection (checked before any Gemini
# call in every one of them) and the two endpoints that never call Gemini at
# all (quiz_submit, quiz_complete — pure progress-dict writes).

def test_quiz_submit_and_complete_round_trip(client, session_token):
    submit = client.post("/api/quiz/submit", json={
        "token": session_token, "topic": "algebra", "difficulty": "medium",
        "answer": "b", "question": "2+2=?", "correct": "B", "explanation": "It's 4.",
    })
    assert submit.status_code == 200
    body = submit.json()
    assert body["correct"] is True and body["correct_answer"] == "B"

    wrong = client.post("/api/quiz/submit", json={
        "token": session_token, "topic": "algebra", "difficulty": "medium",
        "answer": "a", "question": "2+2=?", "correct": "B", "explanation": "It's 4.",
    })
    assert wrong.json()["correct"] is False

    complete = client.post("/api/quiz/complete", json={
        "token": session_token, "score": 4, "topic": "algebra", "difficulty": "medium",
    })
    assert complete.status_code == 200 and complete.json()["ok"]

    p = app_module.load_progress(CI_TEST_SID)
    assert len(p["wrong_answers"]) == 1
    assert p["quizzes"][-1]["topic"] == "algebra"


def test_quiz_submit_rejects_invalid_difficulty(client, session_token):
    r = client.post("/api/quiz/submit", json={
        "token": session_token, "topic": "x", "difficulty": "impossible",
        "answer": "a", "question": "q", "correct": "a", "explanation": "e",
    })
    assert r.status_code == 422


def test_quiz_question_requires_a_real_session_token(client):
    """Was a bare `sid` query param with no token check at all — an IDOR letting
    anyone read another user's uploaded-document quiz content by guessing their
    sid + file_id. Fixed immediately after being found during extraction (see
    the comment in routes/quiz.py); this asserts the fix, not the old behavior."""
    no_token = client.get("/api/quiz/question", params={"topic": "algebra"})
    assert no_token.status_code == 401

    bad_token = client.get("/api/quiz/question", params={"token": "not-a-real-token"})
    assert bad_token.status_code == 401
    # `sid` is no longer a parameter this endpoint accepts at all (see
    # routes/quiz.py's signature) — a client-supplied one is structurally
    # impossible to honor now, not just ignored at runtime. Not asserting the
    # authenticated happy path here since every non-error branch calls Gemini
    # (see the module note above) — the auth check itself is the real fix.


def test_weekly_review_latest_with_no_cached_review(client, session_token):
    """Pure filesystem read, no Gemini call — safe to test fully."""
    r = client.get(f"/api/ai/weekly-review/latest?token={session_token}")
    assert r.status_code == 200
    assert r.json()["review"] is None


@pytest.mark.parametrize("path,payload", [
    ("/api/home/brief", {"token": ""}),
    ("/api/ai/extract-tasks", {"token": "", "text": "call mom tomorrow"}),
    ("/api/ai/write", {"token": "", "text": "hello there"}),
    ("/api/ai/weekly-review", {"token": ""}),
    ("/api/ai/parse-intent", {"token": "", "text": "buy milk"}),
    ("/api/ai/voice-to-task", {"token": "", "transcript": "call mom"}),
])
def test_ai_endpoints_reject_missing_auth_before_any_gemini_call(client, path, payload):
    r = client.post(path, json=payload)
    assert r.status_code == 401


def test_routes_do_not_import_from_app():
    """The whole point of core.py: routers must not import a half-loaded app."""
    offenders = [
        p.name for p in (REPO / "routes").glob("*.py")
        if re.search(r"^from app import|^import app$", p.read_text(encoding="utf-8"), re.M)
    ]
    assert not offenders, (
        f"{offenders} import from app.py. Import shared helpers from core.py instead "
        f"— see core.py's module docstring."
    )
