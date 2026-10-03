"""Privacy scrub applied to everything AgentGlow ingests (live spans, OTLP spans, Claude Code hook payloads).

Called at the Hub ingestion boundary (and by the Claude Code hooks adapter before it builds spans), so no path can
put identity data, raw user prompts or secrets into world events. See docs/SPEC.md "Privacy".

- Identity keys are dropped: `user.email`, `user.id`, `user.account_id`, `user.account_uuid`, `organization.id`,
  `enduser.*`, and any key containing "email".
- Raw user prompt keys are dropped: `user_prompt*`, `gen_ai.prompt*`, hook `prompt`/`user_message`, and
  `llm_request.context` unless it is a short label (Claude Code sends "interaction"/"tool").
  Opt-in exception: `scrub_hook(p, keep_prompt=True)` (server env AGENTGLOW_CAPTURE_PROMPTS=1, honoured only on a
  loopback bind, see cli.py) keeps the Claude Code hook prompt as `agentglow_prompt` (`prompt_text`: secrets
  redacted, max PROMPT_MAX chars). OTel prompt keys stay dropped either way.
- A skill name (`agentglow.skill`) is reduced to `[A-Za-z0-9:_.-]`, max 64 chars (`skill_name`); nothing else
  about a skill use (args, prompt text) is ever carried in the skill event.
- Decision labels (`agentglow.decision.*`, see docs/SPEC.md "Decisions"): `decision_text`: secrets redacted, control
  chars and whitespace runs collapsed, the question max 80 chars, result / provider / purpose / target / option names
  max 40.
- A Claude Code session title (`session_title`: the user's /rename name, else Claude Code's auto title) is a run
  label: secrets redacted, control chars and whitespace runs collapsed, max 60 chars.
- Secret-looking substrings are replaced with `[redacted]` in every remaining string value (API keys, tokens,
  `Bearer ...`), including the agent-level text the product shows (input.value, output.value, final text).
"""
from __future__ import annotations

import json
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
HOOK_PROMPT_KEYS = {"prompt", "user_message", "agentglow_prompt"}  # agentglow_prompt: only ever set by scrub_hook
SKILL_KEY = "agentglow.skill"
SKILL_BAD_RE = re.compile(r"[^A-Za-z0-9:_.-]+")
TITLE_MAX = 60
PROMPT_MAX = 2000
STEP_MAX = 40
TITLE_WS_RE = re.compile(r"[\s\x00-\x1f\x7f]+")


def skill_name(v: object) -> str:
    """Skill name → safe label: disallowed runs become `-`, max 64 chars, leading `/` dropped. Empty if nothing left."""
    if v is None or isinstance(v, bool) or not isinstance(v, (str, int, float)):
        return ""
    s = SKILL_BAD_RE.sub("-", redact(str(v).strip().lstrip("/"))).strip("-")
    return s[:64]


def step_name(v: object) -> str:
    """Workflow step name (any identifier the workflow defines) → safe label: disallowed runs become `-`, max STEP_MAX chars."""
    if v is None or isinstance(v, bool) or not isinstance(v, (str, int, float)):
        return ""
    return SKILL_BAD_RE.sub("-", redact(str(v).strip())).strip("-")[:STEP_MAX]


def session_title(v: object) -> str:
    """Session title → safe run label: secrets redacted, whitespace/control runs → one space, max TITLE_MAX chars."""
    if not isinstance(v, str):
        return ""
    s = TITLE_WS_RE.sub(" ", redact(v)).strip()
    return s if len(s) <= TITLE_MAX else s[: TITLE_MAX - 1].rstrip() + "…"


def decision_text(v: object, n: int = 80) -> str:
    """Decision question / label → secrets redacted, whitespace/control runs → one space, max `n` chars."""
    if isinstance(v, bool):
        return "yes" if v else "no"
    if v is None or not isinstance(v, (str, int, float)):
        return ""
    s = TITLE_WS_RE.sub(" ", redact(str(v))).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def prompt_text(v: object) -> str:
    """User prompt (opt-in capture only) → secrets redacted, trimmed, max PROMPT_MAX chars."""
    if not isinstance(v, str):
        return ""
    s = redact(v).strip()
    return s if len(s) <= PROMPT_MAX else s[: PROMPT_MAX - 1].rstrip() + "…"


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
    """Normalized span → copy with scrubbed attributes and a redacted name (plus the backend backstop below)."""
    span = backstop_span(span)
    return {**span, "name": redact(span.get("name") or "span"), "attributes": scrub_attrs(span.get("attributes"))}


def scrub_hook(p: dict, keep_prompt: bool = False) -> dict:
    """Claude Code hook payload → copy without identity keys or the user's prompt (secrets redacted). A
    `<task-notification>` prompt (a background subagent reporting back, written by Claude Code, not the user) is
    reduced to `agentglow_notification` + its `<summary>` so the adapter can still resume that run. `keep_prompt`
    (opt-in, local servers only): any other prompt is kept as `agentglow_prompt` (`prompt_text`)."""
    if not isinstance(p, dict):
        return {}
    out = {k: _value(v) for k, v in p.items() if not drop_key(str(k)) and k not in HOOK_PROMPT_KEYS}
    prompt = str(p.get("user_message") or p.get("prompt") or "")
    if re.match(r"^\s*<task-notification>", prompt, re.I):
        m = re.search(r"<summary>(.*?)</summary>", prompt, re.S)
        out["agentglow_notification"] = redact(m[1].strip()) if m else ""
    elif keep_prompt and prompt_text(prompt):
        out["agentglow_prompt"] = prompt_text(prompt)
    return out


# ---------------------------------------------------------------------- backend privacy (docs/SPEC.md "Privacy")
# Two layers. `strict_attrs` / `strict_name`: the in-process allow-list `agentglow.watch(app=/broker=/mcp=)` applies
# before a span leaves the process (privacy="strict", the backend-mode default). `backstop_span`: what the server
# applies to EVERY ingested span (any source, any SDK): transport-level data that is never needed (HTTP headers and
# bodies, full URLs and paths, DB statements, message payloads, stack traces, URL credentials) is dropped or reduced.
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?<![\w+])\+[1-9]\d{7,14}\b")  # E.164
LONG_ID_RE = re.compile(r"(?<![\w.])\d{9,}(?![\w.])")  # account / card / phone-ish digit runs
PII_PATTERNS: list[tuple[re.Pattern, str]] = [(EMAIL_RE, "[email]"), (PHONE_RE, "[phone]"), (LONG_ID_RE, "{id}")]
USERINFO_RE = re.compile(r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/@\s:]*(?::[^/@\s]*)?@")
UUID_RE = re.compile(r"^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$", re.I)
HEXID_RE = re.compile(r"^(?=[0-9a-f]*\d)[0-9a-f]{8,}$", re.I)
TOKENISH_RE = re.compile(r"^(?=.*\d)[A-Za-z0-9_\-=.~]{16,}$")
ERROR_MAX = 120

# keys never needed to draw a backend: dropped from every span at ingestion (sizes like `*.body.size` are kept)
BACKSTOP_DROP = {"url.full", "http.url", "url.path", "url.query", "url.fragment", "url.original", "http.target",
                 "db.statement", "db.query.text", "exception.stacktrace", "http.user_agent", "user_agent.original",
                 "client.address", "client.port", "net.peer.ip", "net.sock.peer.addr", "http.client_ip",
                 "network.peer.address", "http.request.body", "http.response.body", "messaging.message.body",
                 "messaging.message.payload", "messaging.payload", "messaging.kafka.message.key", "db.user", "enduser.id"}
BACKSTOP_DROP_PREFIX = ("http.request.header.", "http.response.header.", "rpc.request.metadata.", "rpc.response.metadata.",
                        "db.query.parameter.", "websocket.", "ws.", "messaging.message.header.", "messaging.header.")
BACKSTOP_DROP_SUFFIX = (".payload", ".body", ".message.content", ".frame", ".data")
BACKEND_PREFIX = ("http.", "url.", "db.", "messaging.", "rpc.", "server.", "net.", "network.")

# strict allow-list: everything else is dropped in-process
STRICT_KEEP = {
    "http.request.method", "http.method", "http.route", "http.response.status_code", "http.status_code", "http.scheme",
    "http.flavor", "url.scheme", "network.protocol.name", "network.protocol.version", "network.transport", "network.type",
    "server.address", "server.port", "net.peer.name", "net.peer.port", "net.host.name", "net.host.port",
    "http.request.body.size", "http.response.body.size", "http.request_content_length", "http.response_content_length",
    "error.type", "exception.type", "exception.escaped", "rpc.system", "rpc.service", "rpc.method", "rpc.grpc.status_code",
    "db.system", "db.system.name", "db.name", "db.namespace", "db.operation", "db.operation.name", "db.collection.name",
    "db.sql.table", "db.mongodb.collection", "db.redis.database_index", "db.response.status_code", "db.connection_string",
    "db.operation.batch.size",
    "messaging.system", "messaging.operation", "messaging.operation.type", "messaging.operation.name",
    "messaging.destination.name", "messaging.destination.template", "messaging.destination.kind",
    "messaging.destination.temporary", "messaging.destination.anonymous", "messaging.destination.partition.id",
    "messaging.destination_publish.name", "messaging.destination.subscription.name", "messaging.consumer.group.name",
    "messaging.message.id", "messaging.message.conversation_id", "messaging.message.body.size",
    "messaging.message.payload_size_bytes", "messaging.message.envelope.size", "messaging.batch.message_count",
    "messaging.client.id", "messaging.client_id", "messaging.kafka.destination.partition", "messaging.kafka.message.offset",
    "messaging.kafka.consumer.group",
    "gen_ai.system", "gen_ai.provider.name", "gen_ai.operation.name", "gen_ai.request.model", "gen_ai.response.model",
    "gen_ai.response.id", "gen_ai.response.finish_reasons", "gen_ai.request.max_tokens", "gen_ai.request.temperature",
    "gen_ai.request.top_p", "gen_ai.tool.name", "gen_ai.tool.type", "gen_ai.tool.call.id", "gen_ai.agent.name",
    "gen_ai.agent.id", "llm.model_name", "llm.provider", "llm.system", "openinference.span.kind", "tool.name",
    "mcp.method.name", "mcp.tool.name", "mcp.server.name", "code.function", "code.function.name", "code.namespace",
    "thread.id", "thread.name", "metadata",
}
STRICT_KEEP_PREFIX = ("gen_ai.usage.", "llm.token_count.", "hatchet.", "agentglow.", "service.", "deployment.")
STRICT_DROP = {"agentglow.output_text", "agentglow.final", "agentglow_prompt"}
STRICT_DROP_WORDS = ("payload", "input", "output", "additional_metadata", "error", "message", "body", "prompt", "content")
META_KEEP = {"langgraph_node", "lc_agent_name", "langgraph_step", "langgraph_triggers", "langgraph_path", "checkpoint_ns",
             "thread_id", "ls_provider", "ls_model_name", "ls_model_type"}
ID_KEY_SUFFIX = (".id", "_id", ".offset", ".partition", ".port", ".pid", ".index")


def pii(s: str, patterns: list | None = None, ids: bool = True) -> str:
    """Emails, E.164 phone numbers and long digit runs replaced (`[email]`, `[phone]`, `{id}`); secrets redacted."""
    if not isinstance(s, str):
        return s
    s = redact(s)
    for rx, rep in PII_PATTERNS if patterns is None else patterns:
        if ids or rep != "{id}":
            s = rx.sub(rep, s)
    return s


def strip_userinfo(s: str) -> str:
    """`redis://user:pass@host:6379/0` -> `redis://host:6379/0` (any scheme)."""
    return USERINFO_RE.sub(r"\1", s) if isinstance(s, str) and "@" in s else s


def _id_segment(seg: str) -> bool:
    return bool(seg) and (seg.isdigit() or bool(UUID_RE.match(seg)) or bool(HEXID_RE.match(seg)) or "@" in seg
                          or bool(TOKENISH_RE.match(seg)) or bool(PHONE_RE.fullmatch(seg)))


def normalize_path(path: str) -> str:
    """Un-templated URL path -> generic template: query dropped, id-like segments (numbers, UUIDs, hex / token ids,
    emails, phones) become `{id}`. `/users/42/orders/9f1c2e3d4b5a` -> `/users/{id}/orders/{id}`."""
    p = str(path or "").split("?", 1)[0].split("#", 1)[0]
    if not p.startswith("/"):
        p = "/" + p
    return "/".join("{id}" if _id_segment(seg) else seg for seg in p.split("/"))[:120] or "/"


PATHISH_RE = re.compile(r"(?<![\w}])/[^\s?#]*(?:\?\S*)?")


def strict_name(name: str, patterns: list | None = None) -> str:
    """Span name with any path normalized (`GET /users/42?x=1` -> `GET /users/{id}`), PII / secrets replaced."""
    s = PATHISH_RE.sub(lambda m: normalize_path(m.group(0)), str(name or "span"))
    return pii(s, patterns)[:120]


def _origin(url: str) -> tuple[str | None, int | None]:
    from urllib.parse import urlparse

    try:
        u = urlparse(strip_userinfo(str(url)))
        return u.hostname, u.port
    except ValueError:
        return None, None


def _reduce_url(v: object) -> object:
    """Connection string / broker URL -> scheme://host:port/db (userinfo, query and fragment dropped)."""
    if not isinstance(v, str) or "://" not in v:
        return strip_userinfo(v) if isinstance(v, str) else v
    return strip_userinfo(v).split("?", 1)[0].split("#", 1)[0]


def _derive(a: dict, kind: str | None) -> dict:
    """Before dropping raw URL / statement keys keep what the view needs: server.address / port from a full URL,
    an `http.route` for an un-templated server request, the DB operation (and read / write) from a statement."""
    out = dict(a)
    url = out.get("url.full") or out.get("http.url")
    if url and not (out.get("server.address") or out.get("net.peer.name")):
        host, port = _origin(url)
        if host:
            out["server.address"] = host
            if port:
                out.setdefault("server.port", port)
    path = out.get("url.path") or out.get("http.target")
    if path and kind == "server" and not out.get("http.route") and (out.get("http.request.method") or out.get("http.method")):
        out["http.route"] = normalize_path(str(path))
    q = out.get("db.query.text") or out.get("db.statement")
    if isinstance(q, str) and q.strip():
        word = re.match(r"\s*([A-Za-z_]+)\b", q)
        if word and not (out.get("db.operation.name") or out.get("db.operation")):
            out["db.operation.name"] = word[1][:32].upper()
        if "agentglow.db.op" not in out:
            out["agentglow.db.op"] = "write" if re.search(r"\b(CREATE|MERGE|SET|DELETE|INSERT|UPDATE|REMOVE|DROP)\b", q, re.I) else "read"
    return out


def _backstop_drop(k: str) -> bool:
    kl = k.lower()
    if kl in BACKSTOP_DROP or kl.startswith(BACKSTOP_DROP_PREFIX):
        return True
    if kl.endswith(BACKSTOP_DROP_SUFFIX) and kl.startswith(BACKEND_PREFIX + ("websocket", "ws.")):
        return True
    return ("signature" in kl or "authorization" in kl or "cookie" in kl or "api_key" in kl or "api-key" in kl) \
        and kl.startswith(BACKEND_PREFIX)


AGENT_PREFIX = ("gen_ai.", "llm.", "openinference.", "agentglow.agent", "input.value", "output.value")


def is_backend(span: dict) -> bool:
    """A transport span (HTTP / DB / messaging / RPC attributes) that is not an LLM / agent span (those keep their text
    under the agent rules above, e.g. an OpenAI client span also has `server.address`)."""
    a = span.get("attributes") or {}
    keys = [str(k) for k in a]
    return any(k.startswith(BACKEND_PREFIX) for k in keys) and not any(k.startswith(AGENT_PREFIX) for k in keys)


def backstop_span(span: dict) -> dict:
    """Server-side backend privacy backstop (any source): see the module comment above. Agent-only spans carry none of
    these keys and pass through unchanged."""
    a = span.get("attributes") or {}
    backend = is_backend(span)
    if not backend and not any(_backstop_drop(str(k)) or k == "exception.message" for k in a):
        return span
    a = _derive(a, span.get("kind"))
    out: dict = {}
    for k, v in a.items():
        k = str(k)
        if _backstop_drop(k):
            continue
        if k == "exception.message":
            v = pii(decision_text(v, ERROR_MAX))
        elif isinstance(v, str) and "://" in v:
            v = _reduce_url(v)
        if backend and isinstance(v, str):
            v = pii(v, ids=not k.endswith(ID_KEY_SUFFIX))
        out[k] = v
    transport = backend or any(str(k).startswith(BACKEND_PREFIX) for k in a)  # names: paths normalized, PII replaced
    return {**span, "name": strict_name(span.get("name") or "span") if transport else span.get("name"), "attributes": out}


def _keep_strict(k: str, allow: tuple, msg_keys: tuple) -> bool:
    if k in STRICT_DROP:
        return False
    if k in STRICT_KEEP:
        return True
    if k.startswith(STRICT_KEEP_PREFIX):
        if k.startswith("hatchet.") and any(w in k for w in STRICT_DROP_WORDS):
            return False
        return True
    if msg_keys and k.startswith("messaging.") and k.rsplit(".", 1)[-1] in msg_keys and not _backstop_drop(k):
        return True
    if allow:
        from fnmatch import fnmatchcase

        return any(fnmatchcase(k, p) for p in allow)
    return False


def _scalar(v: object, patterns: list | None, key: str = "") -> object:
    if isinstance(v, bool) or isinstance(v, (int, float)) or v is None:
        return v
    if isinstance(v, (list, tuple)):
        return [_scalar(x, patterns, key) for x in v][:20]
    return pii(_reduce_url(str(v))[:256], patterns, ids=not key.endswith(ID_KEY_SUFFIX))


def strict_attrs(attrs: dict | None, kind: str | None = None, *, allow: tuple | list = (), allow_message_keys: tuple | list = (),
                 error_messages: bool = False, patterns: list | None = None) -> dict:
    """Strict privacy (in-process, allow-list first): keep only structural keys (methods, route templates, status codes,
    hosts, DB system / operation / collection, messaging destination / id / size, model names, token counts, agentglow.*
    labels); everything else (headers, bodies, URLs, statements, payloads, prompts, completions, tool args / results,
    exception messages, stack traces, custom attributes) is dropped. `allow`: extra key patterns (fnmatch) to keep;
    `allow_message_keys`: message fields to keep (`messaging.*.<key>` attributes and top-level keys of a JSON message
    body, as `messaging.message.<key>`); `error_messages`: keep `exception.message` scrubbed, max 120 chars."""
    a = _derive(attrs or {}, kind)
    msg_keys = tuple(str(k) for k in allow_message_keys or ())
    out: dict = {}
    for k, v in a.items():
        k = str(k)
        if k == "exception.message" and error_messages:
            out[k] = pii(decision_text(v, ERROR_MAX), patterns)
            continue
        if not _keep_strict(k, tuple(allow or ()), msg_keys):
            if msg_keys and k in ("messaging.message.body", "messaging.message.payload", "messaging.payload"):
                body = _json_dict(v)
                for mk in msg_keys:
                    if mk in body and not isinstance(body[mk], (dict, list)):
                        out[f"messaging.message.{mk}"] = _scalar(body[mk], patterns)
            continue
        if k == "metadata":
            meta = _json_dict(v)
            v = json.dumps({m: meta[m] for m in META_KEEP if m in meta}, default=str) if meta else None
            if v is None:
                continue
            out[k] = v
            continue
        out[k] = _scalar(v, patterns, k)
    return out


def _json_dict(v: object) -> dict:
    if isinstance(v, dict):
        return v
    if isinstance(v, str) and v[:1] == "{":
        try:
            d = json.loads(v)
            return d if isinstance(d, dict) else {}
        except ValueError:
            return {}
    return {}
