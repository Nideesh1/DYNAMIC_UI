/**
 * `agentglow/pulse`: send flat events to an AgentGlow server from any JS/TS backend (Node >= 18, Deno, Bun, edge,
 * browsers), no OpenTelemetry needed. POST /v1/events (docs/SPEC.md "Backend services" > "Flat events").
 *
 *   import { pulse } from "agentglow/pulse";
 *   await pulse("http://localhost:8100", { service: "checkout", event: "request", name: "POST /pay", status: 200, duration_ms: 42 });
 *
 * Never throws: resolves false when the server is down or rejects the event (tracing must never break the app).
 * No React / three.js: this entry is dependency-free.
 */
export type PulseEvent = {
  /** the service (or long-lived agent) the event belongs to; `agent` is an alias */
  service?: string;
  agent?: string;
  /** request (default) | message | call | error | llm | tool; anything else counts as a request named after it */
  event?: "request" | "message" | "call" | "error" | "llm" | "tool" | (string & {});
  name?: string;
  /** HTTP status (>= 500 = error) or "error" */
  status?: number | string;
  duration_ms?: number;
  /** message: the consuming service; call: the external system (redis, postgres, payments-api) */
  to?: string;
  topic?: string;
  /** call: db | warehouse | spark | api | storage | queue */
  kind?: string;
  tokens_in?: number;
  tokens_out?: number;
  /** scope (tenant / user) the event belongs to; the `?scope=` of the URL works too */
  scope?: string;
};

export type PulseOptions = { apiKey?: string; timeoutMs?: number; fetch?: typeof fetch };

/** POST one event or a batch to `<url>/v1/events`; `apiKey` is sent as `x-api-key` (server `--ingest-key`). */
export async function pulse(url: string, event: PulseEvent | PulseEvent[], opts: PulseOptions = {}): Promise<boolean> {
  const f = opts.fetch ?? globalThis.fetch;
  if (!f) return false;
  const ctl = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs ?? 2000) : undefined;
  try {
    const r = await f(url.replace(/\/+$/, "") + "/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}) },
      body: JSON.stringify(event),
      signal: ctl?.signal,
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
