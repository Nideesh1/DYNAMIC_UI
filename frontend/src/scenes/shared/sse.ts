/**
 * Incremental SSE parser (no DOM, no deps: unit-tested from cli/test). Feed it text chunks; it calls `onData` with each
 * default ("message") event's data and tracks the stream's `retry:` and last event `id:` (sent back as Last-Event-ID on
 * reconnect, so the server resumes after it instead of replaying events the world already applied).
 */
export type SseParser = { feed: (chunk: string) => void; lastId: string; retry: number };

export function createSseParser(onData: (data: string) => void, lastId = "", retry = 2000): SseParser {
  let buf = "";
  let data: string[] = [];
  let type = "";
  let id = lastId;
  const p: SseParser = {
    lastId,
    retry,
    feed(chunk: string) {
      buf += chunk;
      const lines = buf.split(/\r\n|\r|\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          p.lastId = id; // per spec the id is committed when the event is dispatched
          if (data.length && (type === "" || type === "message")) onData(data.join("\n"));
          data = [];
          type = "";
          continue;
        }
        if (line.startsWith(":")) continue;
        const i = line.indexOf(":");
        const field = i < 0 ? line : line.slice(0, i);
        let val = i < 0 ? "" : line.slice(i + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "data") data.push(val);
        else if (field === "event") type = val;
        else if (field === "id" && !val.includes("\0")) id = val;
        else if (field === "retry" && /^\d+$/.test(val)) p.retry = Number(val);
      }
    },
  };
  return p;
}
