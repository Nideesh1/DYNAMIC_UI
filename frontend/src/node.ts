/**
 * `agentglow/node`: one call to put a Node.js service (Next.js backend-for-frontend, Express, Fastify, plain `http`)
 * into an AgentGlow scene, like Python's `agentglow.watch(app=...)` (docs/SPEC.md "Backend services" > "Node.js").
 *
 *   npm i agentglow @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/resources \
 *     @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation \
 *     @opentelemetry/instrumentation-http @opentelemetry/instrumentation-undici
 *
 *   import { watch } from "agentglow/node";
 *   watch({ service: "web-bff", url: "http://localhost:8100" });
 *
 * Incoming HTTP requests become SERVER spans (the service's request halo), outgoing `http` / `fetch` calls become
 * CLIENT spans (resources) and carry a W3C `traceparent`, so a Python API watched with `agentglow.watch(app=...)`
 * continues the same trace. Spans go to `<url>/v1/traces` as OTLP/HTTP JSON.
 *
 * Privacy "strict" (default): only an allowlist of attributes leaves the process (method, route, status, peer host,
 * messaging / db / rpc system names, `agentglow.*`); no bodies, no headers, no query strings, no userinfo, no client
 * IPs, no span events or status messages. Paths without a route template are id-normalized (`/orders/:id`). A regex
 * backstop replaces emails, phone numbers, long ids and secrets in every remaining string. `scrub(attrs, span)` runs
 * after the built-in rules (and before the backstop).
 *
 * Server-only (Node >= 18): no React / three.js. The OpenTelemetry packages are optional peer dependencies.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import type { ReadableSpan, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

export type Attrs = Record<string, unknown>;
/** what `scrub` sees about the span besides its attributes */
export type SpanInfo = { name: string; kind: "internal" | "server" | "client" | "producer" | "consumer" };

export type WatchOptions = {
  /** service name (the agent in the scene); default env OTEL_SERVICE_NAME, else "node-app" */
  service?: string;
  /** AgentGlow server; default env AGENTGLOW_URL, else http://localhost:8100 */
  url?: string;
  /** sent as `x-api-key` (server `--ingest-key`); default env AGENTGLOW_API_KEY */
  ingestKey?: string;
  /** "strict" (default): attribute allowlist. "standard": keep other attributes, still drop headers / bodies / query
   * strings / userinfo / identity keys and run the regex backstop on every string */
  privacy?: "strict" | "standard";
  /** extra scrub after the built-in rules: return new attributes (or mutate `attrs` and return nothing) */
  scrub?: (attrs: Attrs, span: SpanInfo) => Attrs | void;
  /** trace incoming HTTP requests (default true, except under Next.js, which makes its own request spans) */
  incoming?: boolean;
  /** incoming paths not traced (health checks): exact strings or regexes */
  ignorePaths?: (string | RegExp)[];
};

export type Watch = {
  /** export everything finished so far (call before a short script exits) */
  flush(): Promise<void>;
  /** flush, stop exporting and disable the instrumentations */
  shutdown(): Promise<void>;
};

// ------------------------------------------------------------------------------------------- privacy scrubbing
const KINDS: SpanInfo["kind"][] = ["internal", "server", "client", "producer", "consumer"];
const STRICT_KEYS = new Set([
  "http.request.method", "http.method", "http.route", "http.response.status_code", "http.status_code",
  "server.address", "server.port", "net.peer.name", "net.peer.port", "url.scheme", "http.scheme",
  "network.protocol.name", "network.protocol.version", "http.flavor", "error.type",
  "rpc.system", "rpc.service", "rpc.method", "rpc.grpc.status_code",
  "messaging.system", "messaging.destination.name", "messaging.destination_publish.name",
  "messaging.operation", "messaging.operation.type", "messaging.operation.name",
  "db.system", "db.system.name", "db.name", "db.namespace", "db.operation", "db.operation.name",
  "next.route", "next.span_type", "gen_ai.system", "gen_ai.operation.name", "gen_ai.request.model",
  "gen_ai.response.model", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.tool.name",
]);
/** never kept, in either mode: headers, bodies, raw URLs / queries, identity, client addresses, statements */
const DENY_RE = /header|body|cookie|authorization|query|user|email|password|token(?!s$)|secret|session|^url\.full$|^http\.url$|^http\.target$|^url\.path$|^url\.original$|^client\.|^net\.sock|^network\.peer|^net\.peer\.ip|^http\.client_ip|^db\.statement$|^db\.query\.text$|^exception\./i;
const URL_KEYS = ["url.full", "http.url"];
const PATH_KEYS = ["http.target", "url.path", "url.full", "http.url"];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+\d{8,15}\b/g;
const LONG_ID_RE = /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b|\b[0-9a-f]{16,}\b|\b\d{6,}\b/gi;
const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Regex backstop for any string: secrets, emails, phone numbers, long ids, query strings, URL userinfo. */
export function scrubText(s: string): string {
  return s
    .replace(SECRET_RE, "[redacted]")
    .replace(/(\/\/)[^/@\s]+@/g, "$1") // userinfo
    .replace(/\?[^\s#]*/g, "") // query strings
    .replace(EMAIL_RE, "[email]")
    .replace(UUID_RE, ":id")
    .replace(PHONE_RE, "[phone]")
    .replace(LONG_ID_RE, ":id");
}

/** `/orders/123?x=1` -> `/orders/:id`: no query / fragment, id-looking segments (numbers, uuids, hex, long or
 * digit-heavy tokens, emails) replaced with `:id`. Route templates (`/orders/:id`, `/orders/[id]`) pass unchanged. */
export function normalizePath(p: string): string {
  let path = String(p ?? "");
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(path); // full URL -> its path
  if (m) path = m[1] || "/";
  path = path.split(/[?#]/)[0] || "/";
  const segs = path.split("/").map((seg) => {
    if (!seg || /^[:[{*]/.test(seg)) return seg; // template parameter
    let s = seg;
    try { s = decodeURIComponent(seg); } catch { /* keep */ }
    const id = /^\d+$/.test(s) || /\d{4,}/.test(s) || s.includes("@") || s.length >= 20 ||
      /^[0-9a-f-]{8,}$/i.test(s) && /\d/.test(s) || /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{12,}$/.test(s);
    return id ? ":id" : s;
  });
  return segs.join("/").slice(0, 120) || "/";
}

function hostPort(u: string): { host?: string; port?: number } {
  try {
    const x = new URL(u);
    return { host: x.hostname, port: x.port ? Number(x.port) : undefined };
  } catch {
    return {};
  }
}

function backstop(v: unknown): unknown {
  if (typeof v === "string") return scrubText(v).slice(0, 200);
  if (Array.isArray(v)) return v.map(backstop);
  return v;
}

/** The privacy rules of `watch()` for one span: returns the name and attributes that may leave the process. */
export function scrubSpan(name: string, kind: SpanInfo["kind"], attrs: Attrs, privacy: "strict" | "standard" = "strict",
  hook?: WatchOptions["scrub"]): { name: string; attributes: Attrs } {
  const a = attrs || {};
  const method = String(a["http.request.method"] ?? a["http.method"] ?? "");
  const rawPath = PATH_KEYS.map((k) => a[k]).find((v) => typeof v === "string") as string | undefined;
  const out: Attrs = {};
  for (const [k, v] of Object.entries(a)) {
    if (k.startsWith("agentglow.")) out[k] = v;
    else if (DENY_RE.test(k)) continue;
    else if (privacy === "standard" || STRICT_KEYS.has(k)) out[k] = v;
  }
  if (method && kind === "client" && !out["server.address"] && !out["net.peer.name"]) {
    const url = URL_KEYS.map((k) => a[k]).find((v) => typeof v === "string") as string | undefined;
    const { host, port } = url ? hostPort(url) : {};
    if (host) out["server.address"] = host;
    if (port) out["server.port"] = port;
  }
  let outName = name;
  if (method && (kind === "server" || out["http.route"])) {
    let route = normalizePath(String(out["http.route"] ?? out["next.route"] ?? rawPath ?? "/"));
    if (out["next.route"] && route.endsWith("/route")) route = route.slice(0, -6) || "/"; // Next.js app route handler
    out["http.route"] = route;
    outName = `${method} ${route}`;
  } else {
    // URLs / paths inside names (Next.js "fetch GET http://host:8191/orders/42"): origin kept, path id-normalized
    outName = name.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/?#]+)?(\/[^\s]*)/gi, (_m, origin: string | undefined, path: string) =>
      (origin ? origin.replace(/\/\/[^/@]*@/, "//") : "") + normalizePath(path));
  }
  if (out["next.route"]) out["next.route"] = normalizePath(String(out["next.route"]));
  let final: Attrs = out;
  if (hook) {
    try {
      final = hook(out, { name: outName, kind }) ?? out;
    } catch {
      final = out; // a broken hook never breaks tracing
    }
  }
  for (const k of Object.keys(final)) final[k] = backstop(final[k]);
  return { name: scrubText(outName).slice(0, 120), attributes: final };
}

/** Wraps an exporter: every span is scrubbed (name, attributes; events, status message and resource extras dropped). */
class ScrubbingExporter implements SpanExporter {
  inner: SpanExporter;
  privacy: "strict" | "standard";
  hook?: WatchOptions["scrub"];
  constructor(inner: SpanExporter, privacy: "strict" | "standard", hook?: WatchOptions["scrub"]) {
    this.inner = inner;
    this.privacy = privacy;
    this.hook = hook;
  }
  export(spans: ReadableSpan[], done: Parameters<SpanExporter["export"]>[1]): void {
    const clean = spans.map((s) => {
      const { name, attributes } = scrubSpan(s.name, KINDS[s.kind] ?? "internal", s.attributes as Attrs, this.privacy, this.hook);
      const events = this.privacy === "strict" ? [] : s.events.map((e) => ({ ...e, attributes: Object.fromEntries(
        Object.entries(e.attributes ?? {}).filter(([k]) => !DENY_RE.test(k)).map(([k, v]) => [k, backstop(v)])) }));
      // own fields shadow the original span's; methods (spanContext) and the rest come through the prototype
      return Object.create(s, {
        name: { value: name }, attributes: { value: attributes }, events: { value: events },
        status: { value: { code: s.status.code } },
      }) as ReadableSpan;
    });
    this.inner.export(clean, done);
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

// ------------------------------------------------------------------------------------------- watch()
const env = (k: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[k] || undefined;
const watches = new Map<string, Watch>();

/** The span processor `watch()` uses (scrubbing + OTLP/HTTP JSON to `<url>/v1/traces`), for apps that already set up
 * OpenTelemetry themselves (NodeSDK, @vercel/otel): add it to their `spanProcessors`. */
export function spanProcessor(opts: Pick<WatchOptions, "url" | "ingestKey" | "privacy" | "scrub"> = {}): SpanProcessor {
  const base = (opts.url ?? env("AGENTGLOW_URL") ?? "http://localhost:8100").replace(/\/+$/, "");
  const key = opts.ingestKey ?? env("AGENTGLOW_API_KEY");
  const exporter = new OTLPTraceExporter({ url: `${base}/v1/traces`, headers: key ? { "x-api-key": key } : {} });
  return new BatchSpanProcessor(new ScrubbingExporter(exporter, opts.privacy ?? "strict", opts.scrub),
    { scheduledDelayMillis: 250, maxExportBatchSize: 512 });
}

/** Trace this Node.js process into AgentGlow. Idempotent per url; never throws because the server is down. */
export function watch(opts: WatchOptions = {}): Watch {
  const base = (opts.url ?? env("AGENTGLOW_URL") ?? "http://localhost:8100").replace(/\/+$/, "");
  const existing = watches.get(base);
  if (existing) return existing;
  const service = opts.service ?? env("OTEL_SERVICE_NAME") ?? "node-app";
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": service, "service.instance.id": randomUUID() }),
    spanProcessors: [spanProcessor({ ...opts, url: base })],
  });
  provider.register(); // global provider + W3C traceparent / baggage propagator + AsyncLocalStorage context
  const proxy = trace.getTracerProvider() as unknown as { getDelegate?: () => unknown };
  if ((proxy.getDelegate ? proxy.getDelegate() : proxy) !== provider) {
    console.warn("agentglow: another OpenTelemetry tracer provider is already registered; add " +
      "spanProcessor() from agentglow/node to its spanProcessors instead of calling watch()");
  }
  const ignore = opts.ignorePaths ?? [];
  const incoming = opts.incoming ?? !env("NEXT_RUNTIME");
  const ignored = (path: string) => ignore.some((p) => (typeof p === "string" ? p === path : p.test(path)));
  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        disableIncomingRequestInstrumentation: !incoming, // (ignoring them instead would suppress their fetch spans)
        ignoreIncomingRequestHook: (req) => ignored((req.url ?? "/").split("?")[0]),
      }),
      new UndiciInstrumentation(), // global fetch (Node >= 18)
    ],
  });
  // ESM apps import `node:http` before watch() runs: requiring it once more lets the instrumentation patch the
  // shared module object (Server.prototype.emit, request, get), which ESM imports see too.
  try {
    const req = createRequire(import.meta.url);
    req("node:http");
    req("node:https");
  } catch { /* not Node */ }
  const w: Watch = {
    flush: () => provider.forceFlush().catch(() => undefined),
    shutdown: async () => {
      watches.delete(base);
      unregister();
      await provider.shutdown().catch(() => undefined);
    },
  };
  watches.set(base, w);
  return w;
}
