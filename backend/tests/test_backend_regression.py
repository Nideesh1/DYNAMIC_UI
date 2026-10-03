"""Backend services must not change agent-only traces: every span fixture maps to exactly the world events recorded
from v0.3.0 (tests/fixtures/golden, written by tests/golden.py before backend services existed), also when the spans
carry the new transport fields (kind, service, links) that watch() / OTLP decoding now add."""
import json
import time

import pytest

from golden import GOLDEN, all_events


@pytest.fixture(autouse=True)
def _recorded_timezone(monkeypatch):
    """The goldens were recorded in America/New_York (Claude Code run topics carry a local `HH:MM`): pin it so the
    comparison does not depend on the machine's timezone (CI runs in UTC)."""
    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


def _kinded(span: dict) -> dict:
    a = span.get("attributes") or {}
    kind = "client" if a.get("gen_ai.operation.name") in ("chat", "text_completion") or a.get("db.system") else "internal"
    if a.get("agentglow.mcp.server"):
        kind = "server"
    return {**span, "kind": kind, "service": "agent-app"}


def _kinded_otlp(req: dict) -> dict:
    req = json.loads(json.dumps(req))
    for rs in req.get("resourceSpans", []):
        rs.setdefault("resource", {}).setdefault("attributes", []).append({"key": "service.name", "value": {"stringValue": "claude-code"}})
        for ss in rs.get("scopeSpans", []):
            for sp in ss.get("spans", []):
                sp["kind"] = 1
    return req


def _norm(evs: list[dict]) -> list[dict]:
    """Agent ids by first appearance (the Claude Code adapter makes random span ids)."""
    ids: dict = {}
    out = []
    for e in json.loads(json.dumps(evs)):
        for k in ("id", "parent_id", "from_id", "to_id"):
            if isinstance(e.get(k), str):
                e[k] = ids.setdefault(e[k], f"a{len(ids)}")
        out.append(e)
    return out


EXPECTED = {p.stem: json.loads(p.read_text()) for p in sorted(GOLDEN.glob("*.json"))}


@pytest.mark.parametrize("tweak", [None, "kinded"])
def test_fixtures_map_to_identical_events(tweak):
    got = all_events(_kinded, _kinded_otlp) if tweak else all_events()
    assert set(got) == set(EXPECTED)
    for k, evs in got.items():
        assert _norm(evs) == _norm(EXPECTED[k]), k
