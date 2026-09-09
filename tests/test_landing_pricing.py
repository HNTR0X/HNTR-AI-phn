"""Landing-page pricing must follow the live FX rate.

get_naira_rate() is DB-backed with an admin override specifically so the team
can change the USD->NGN rate without a redeploy. A naira figure written into
templates/landing.html therefore becomes a lie the moment anyone uses that
override: the page advertises one price while checkout charges another.

This is the same class of problem as the earlier landing-vs-config pricing
contradiction, just slower to appear.
"""

import re
import time

import pytest
from fastapi.testclient import TestClient

import app as app_module


@pytest.fixture(scope="module")
def client():
    return TestClient(app_module.app)


def _prices(client):
    return re.findall(r"≈ ₦([\d,]+) / month", client.get("/").text)


def test_prices_render_from_the_live_rate(client):
    rate = app_module.get_naira_rate()
    expected = [
        f"{int(round(app_module.SIVARR_PLANS[p]['amount_usd'] * rate)):,}"
        for p in ("pro_monthly", "creator_monthly")
    ]
    assert _prices(client) == expected


def test_prices_follow_a_rate_change(client):
    """The regression that matters: change the rate, the page must change."""
    original = app_module.get_naira_rate()
    try:
        app_module._naira_rate_cache.update({"val": 2000, "ts": time.time()})
        assert _prices(client) == ["24,000", "44,000"], (
            "landing prices did not follow the rate change -- they are hardcoded again"
        )
    finally:
        app_module._naira_rate_cache.update({"val": original, "ts": time.time()})


def test_no_naira_figures_are_hardcoded_in_the_template():
    from pathlib import Path
    src = Path("templates/landing.html").read_text()
    # ₦0 for the free tier is legitimately fixed; any other literal is drift.
    literals = [m for m in re.findall(r"₦([\d,]+)", src) if m not in ("0",)]
    assert not literals, f"hardcoded naira figures in landing.html: {literals}"
