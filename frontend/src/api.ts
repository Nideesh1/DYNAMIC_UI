import { TOOL_NAMES, type ToolName } from "./tools";

export interface Source {
  title: string;
  url: string;
  video_url?: string | null;
  source?: string | null;
  date?: string | null;
}

export type SearchEvent =
  | { type: "text"; delta: string }
  | { type: "sources"; sources: Source[] }
  | { type: "error"; message: string }
  | { type: "done" };

async function callTool(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) throw new Error(`${name} failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

/** Function-map tool provider for <Renderer toolProvider>. */
export const toolProvider: Record<string, (args: Record<string, unknown>) => Promise<unknown>> =
  Object.fromEntries(TOOL_NAMES.map((n) => [n, (args: Record<string, unknown>) => callTool(n, args)]));

/** POST /api/search and yield parsed SSE events (`data: {json}\n\n`). */
export async function* streamSearch(q: string, signal: AbortSignal): AsyncGenerator<SearchEvent> {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ q }),
    signal,
  });
  if (!res.ok || !res.body) {
    yield { type: "error", message: `Search failed (${res.status})` };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as SearchEvent;
      } catch {
        console.warn("[cb6] bad SSE frame", data);
      }
    }
  }
}
