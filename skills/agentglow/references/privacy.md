# Privacy: what leaves the process

## Every path (server side, always on)

One scrub runs at the server's ingestion boundary for every source (`/v1/live`, `/v1/traces`, `/v1/events`,
`/v1/claude-code`) before anything reaches the stream:
- dropped identity keys: `user.email`, `user.id`, `user.account_id`, `user.account_uuid`, `organization.id`,
  `enduser.*`, any key containing `email`;
- dropped raw prompts: `gen_ai.prompt*`, Claude Code `user_prompt*`, hook `prompt` / `user_message`;
- redacted to `[redacted]` in every remaining string: `sk-ant-...`, `sk-...`, `npm_...`, `AIza...`, `ghp_...` /
  `github_pat_...`, `xox?-...`, `AKIA...`, `Bearer ...`;
- a transport backstop on every span: URLs, paths, query strings, SQL / statements, headers, bodies, payloads, user
  agents and client addresses are dropped; route templates, server address and DB operation are derived first; URL
  credentials stripped; exception messages capped at 120 chars.

Agent-level text (delegation text, tool args and results, final answers) is kept with only secrets redacted. So keep
personal data (names, phone numbers, emails, patient / customer ids) out of agent names, tool args, labels and `final`.

## Backend mode: strict by default (`watch(app=` / `broker=` / `mcp=)`, `agentglow/node`)

An allow-list runs in your process before a span leaves it:

| Kept | Dropped |
|---|---|
| route templates, methods, status codes, scheme, peer host:port | request / response bodies and headers (cookies, authorization, api keys) |
| DB system / name / operation / collection, Redis db index | SQL / Mongo statements, connection-string credentials |
| messaging system, destination, operation, message id, size | message payloads |
| model names, provider, token counts, tool / agent names | prompts, completions, messages, tool args and results |
| `agentglow.*` labels (not `agentglow.final` / output text) | URLs and paths with ids, query strings, client IPs, user agents |
| `error.type`, `exception.type` | exception messages and stack traces |
| `service.*`, `deployment.*`, `hatchet.*` ids, `code.function*`, `thread.*` | any other custom attribute |

Server request without a route template: `http.route` = the path with id-like segments replaced (`/users/42?x=1` ->
`/users/{id}`). A regex backstop then replaces emails (`[email]`), E.164 phone numbers (`[phone]`), digit runs of 9+
(`{id}`) and secrets in every kept value and span name.

Strict mode also drops the agent text of agents running inside a service (final answers, tool args). Tune per process:
```python
import re
from agentglow.scrub import PII_PATTERNS                    # [(compiled regex, replacement), ...]

agentglow.watch(app=app, broker=broker,
                privacy="standard",                         # export spans unchanged (server backstop still runs)
                allow=["tenant.tier", "app.*"],             # or: keep extra attribute keys in strict mode (fnmatch)
                allow_message_keys=["attempt"],             # message fields (messaging.message.<key>, scalars only)
                error_messages=True,                        # exception messages, scrubbed, max 120 chars
                ignore=["GET /v1/models", "/internal/*"],   # never exported, with their children
                scrub=lambda attrs: {k: v for k, v in attrs.items() if k != "app.secret"},  # your last pass
                pii_patterns=PII_PATTERNS + [(re.compile(r"ACME-\d+"), "[account]")])  # replaces the PII list
```
Node: `watch({ privacy: "standard", scrub: (attrs, span) => attrs })` (node.md).

## Prompt capture (Claude Code, opt-in)

`npx agentglow setup --capture-prompts` (or `AGENTGLOW_CAPTURE_PROMPTS=1 agentglow serve --host 127.0.0.1`) keeps the
user's own Claude Code prompts (secrets redacted, max 2000 chars) and shows `you: ... / claude: ...` in the agent
panel. Only honoured when the server listens on loopback (`127.0.0.1`, `localhost`, `::1`); on any other host it is
ignored with a startup warning. `npx agentglow status` shows `prompts: captured (local only)`; `/live/health` reports
`"prompts": true`.

## For Claude, when instrumenting someone's code

- Prefer `watch(app=/broker=/mcp=)` defaults; reach for `privacy="standard"` or `allow=` only when the user needs a
  specific field, and say what it exposes.
- Use route templates, ids and enums as labels, never request content.
- `traced_tool(capture_args=True)` records arguments: only with the user's OK.
- A shared server (anything not on localhost) needs `--secret` and `--ingest-key` (events-http.md "Auth").
