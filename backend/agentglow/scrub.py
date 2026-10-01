"""Privacy scrub applied to everything AgentGlow ingests (live spans, OTLP spans, Claude Code hook payloads).

Called at the Hub ingestion boundary (and by the Claude Code hooks adapter before it builds spans), so no path can
put identity data, raw user prompts or secrets into world events. See docs/SPEC.md "Privacy".

- Identity keys are dropped: `user.email`, `user.id`, `user.account_id`, `user.account_uuid`, `organization.id`,
  `enduser.*`, and any key containing "email".
- Raw user prompt keys are dropped: `user_prompt*`, `gen_ai.prompt*`, hook `prompt`/`user_message`, and
  `llm_request.context` unless it is a short label (Claude Code sends "interaction"/"tool").
- A skill name (`agentglow.skill`) is reduced to `[A-Za-z0-9:_.-]`, max 64 chars (`skill_name`); nothing else
  about a skill use (args, prompt text) is ever carried in the skill event.
- Secret-looking substrings are replaced with `[redacted]` in every remaining string value (API keys, tokens,
  `Bearer ...`), including the agent-level text the product shows (input.value, output.value, final text).
"""
from __future__ import annotations

import re
from typing import Any

REDACTED = "[redacted]"
IDENTITY_KEYS = {"user.email", "user.id", "user.account_id", "user.account_uuid", "organization.id"}
PROMPT_PREFIXES = ("user_prompt", "gen_ai.prompt")
LABEL_RE = re.compile(r"^[\w.:-]{1,32}$")
SECRET_RE = re.compile(
    r"sk-ant-[A-Za-z0-9_\-]{8,}"  # Anthropic
    r"|sk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{16,}"  # OpenAI style
    r"|npm_[A-Za-z0-9]{20,}"
    r"|AIza[0-9A-Za-z_\-]{20,}"  # Google
    r"|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|xox[abposr]-[A-Za-z0-9\-]{10,}"  # Slack
    r"|AKIA[0-9A-Z]{16}"  # AWS access key id
    r"|\bBearer\s+[A-Za-z0-9._~+/=\-]{8,}",
    re.I,
)
HOOK_PROMPT_KEYS = {"prompt", "user_message"}
SKILL_KEY = "agentglow.skill"
SKILL_BAD_RE = re.compile(r"[^A-Za-z0-9:_.-]+")


def skill_name(v: object) -> str:
    """Skill name → safe label: disallowed runs become `-`, max 64 chars, leading `/` dropped. Empty if nothing left."""
    if v is None or isinstance(v, bool) or not isinstance(v, (str, int, float)):
        return ""
    s = SKILL_BAD_RE.sub("-", redact(str(v).strip().lstrip("/"))).strip("-")
    return s[:64]


def redact(s: str) -> str:
    return SECRET_RE.sub(REDACTED, s) if isinstance(s, str) else s


def drop_key(key: str) -> bool:
    k = key.lower()
    return (k in IDENTITY_KEYS or k.startswith("enduser.") or "email" in k or k.startswith(PROMPT_PREFIXES))


def _value(v: Any) -> Any:
    if isinstance(v, str):
        return redact(v)
    if isinstance(v, list):
        return [_value(x) for x in v]
    if isinstance(v, dict):
        return {k: _value(x) for k, x in v.items() if not drop_key(str(k))}
    return v


def scrub_attrs(attrs: dict | None) -> dict:
    out = {}
    for k, v in (attrs or {}).items():
        if drop_key(str(k)):
            continue
        if k == "llm_request.context" and not (isinstance(v, str) and LABEL_RE.match(v)):
            continue
        out[k] = skill_name(v) if k == SKILL_KEY else _value(v)
    return out


def scrub_span(span: dict) -> dict:
    """Normalized span → copy with scrubbed attributes and a redacted name."""
    return {**span, "name": redact(span.get("name") or "span"), "attributes": scrub_attrs(span.get("attributes"))}


def scrub_hook(p: dict) -> dict:
    """Claude Code hook payload → copy without identity keys or the user's prompt (secrets redacted). A
    `<task-notification>` prompt (a background subagent reporting back, written by Claude Code, not the user) is
    reduced to `agentglow_notification` + its `<summary>` so the adapter can still resume that run."""
    if not isinstance(p, dict):
        return {}
    out = {k: _value(v) for k, v in p.items() if not drop_key(str(k)) and k not in HOOK_PROMPT_KEYS}
    prompt = str(p.get("user_message") or p.get("prompt") or "")
    if re.match(r"^\s*<task-notification>", prompt, re.I):
        m = re.search(r"<summary>(.*?)</summary>", prompt, re.S)
        out["agentglow_notification"] = redact(m[1].strip()) if m else ""
    return out
