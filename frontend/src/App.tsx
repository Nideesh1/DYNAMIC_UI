import { BuiltinActionType, Renderer, type ActionEvent, type OpenUIError } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/react-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { streamSearch, toolProvider, type Source } from "./api";
import { homeDashboard } from "./home";
import { library } from "./library";

const SUGGESTIONS = ["Rats", "Outdoor dining", "2nd Ave", "Liquor licenses"];

function readQuery(): string {
  return new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
}

function writeQuery(q: string, replace = false) {
  const url = new URL(window.location.href);
  if (q) url.searchParams.set("q", q);
  else url.searchParams.delete("q");
  if (url.href === window.location.href) return;
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

export default function App() {
  const [query, setQuery] = useState(readQuery);
  const [input, setInput] = useState(query);
  const [response, setResponse] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const home = useMemo(() => homeDashboard(), []);

  // Run the search whenever the active query changes.
  useEffect(() => {
    abortRef.current?.abort();
    setResponse("");
    setSources([]);
    setError(null);
    document.title = query ? `${query} · CB6 Ask` : "CB6 Ask";
    if (!query) {
      setStreaming(false);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming(true);
    (async () => {
      try {
        for await (const ev of streamSearch(query, ctrl.signal)) {
          if (ctrl.signal.aborted) return;
          if (ev.type === "text") setResponse((r) => r + ev.delta);
          else if (ev.type === "sources") setSources(ev.sources ?? []);
          else if (ev.type === "error") setError(ev.message);
          else if (ev.type === "done") break;
        }
      } catch (e) {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!ctrl.signal.aborted) setStreaming(false);
      }
    })();
    return () => ctrl.abort();
  }, [query]);

  // Back/forward navigation.
  useEffect(() => {
    const onPop = () => {
      const q = readQuery();
      setQuery(q);
      setInput(q);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const search = useCallback((raw: string) => {
    const q = raw.trim();
    setInput(q);
    writeQuery(q);
    setQuery(q);
    window.scrollTo({ top: 0 });
  }, []);

  const onAction = useCallback(
    (ev: ActionEvent) => {
      if (ev.type === BuiltinActionType.OpenUrl) {
        const url = ev.params?.url;
        if (typeof url === "string" && url) window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
      if (ev.type === BuiltinActionType.ContinueConversation) {
        const text = ev.humanFriendlyMessage || (typeof ev.params?.context === "string" ? ev.params.context : "");
        if (text) search(text);
      }
    },
    [search],
  );

  const onError = useCallback((errors: OpenUIError[]) => {
    if (errors.length) console.warn("[cb6] OpenUI errors", errors);
  }, []);

  return (
    <ThemeProvider mode="dark">
      <div className="app">
        <header className="topbar">
          <div className="topbar__inner">
            <a
              className="brand"
              href="/"
              onClick={(e) => {
                e.preventDefault();
                search("");
              }}
            >
              <span className="brand__mark" aria-hidden>
                6
              </span>
              <span className="brand__name">CB6 Ask</span>
            </a>
            <form
              className="searchbox"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                search(input);
              }}
            >
              <svg className="searchbox__icon" viewBox="0 0 24 24" aria-hidden>
                <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about a business, street, or issue…"
                aria-label="Search Community Board 6"
                autoFocus={!query}
              />
              {streaming ? (
                <button type="button" className="searchbox__btn searchbox__btn--stop" onClick={() => { abortRef.current?.abort(); setStreaming(false); }}>
                  Stop
                </button>
              ) : (
                <button type="submit" className="searchbox__btn" disabled={!input.trim()}>
                  Search ⏎
                </button>
              )}
            </form>
          </div>
        </header>

        <main className="page">
          {!query ? (
            <>
              <section className="hero">
                <h1>What is Community Board 6 doing about…</h1>
                <p>Search votes, meetings, hearings and recordings from Manhattan CB6.</p>
                <div className="chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" className="chip" onClick={() => search(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </section>
              <Renderer
                key="home"
                response={home}
                library={library}
                isStreaming={false}
                toolProvider={toolProvider}
                onAction={onAction}
                onError={onError}
              />
            </>
          ) : (
            <>
              {error && (
                <div className="banner banner--error" role="alert">
                  {error}
                </div>
              )}
              {response && (
                <Renderer
                  key={query}
                  response={response}
                  library={library}
                  isStreaming={streaming}
                  toolProvider={toolProvider}
                  onAction={onAction}
                  onError={onError}
                />
              )}
              {streaming && response && <div className="streaming-dot">Building page…</div>}
              {streaming && <PageSkeleton query={query} />}
              {sources.length > 0 && <SourcesList sources={sources} />}
            </>
          )}
        </main>
        <footer className="footer">
          Unofficial tool built on public Manhattan Community Board 6 records. Verify with{" "}
          <a href="https://cbsix.org" target="_blank" rel="noreferrer">
            cbsix.org
          </a>
          .
        </footer>
      </div>
    </ThemeProvider>
  );
}

function PageSkeleton({ query }: { query: string }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label={`Searching for ${query}`}>
      <div className="skeleton__line skeleton__line--title" />
      <div className="skeleton__line" />
      <div className="skeleton__line skeleton__line--short" />
      <div className="skeleton__card" />
      <div className="skeleton__card" />
    </div>
  );
}

function SourcesList({ sources }: { sources: Source[] }) {
  return (
    <section className="sources">
      <h2>Sources</h2>
      <ol>
        {sources.map((s, i) => (
          <li key={`${s.url}-${i}`}>
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.title || s.url}
            </a>
            <span className="sources__meta">
              {[s.source, s.date].filter(Boolean).join(" · ")}
              {s.video_url && (
                <>
                  {" · "}
                  <a href={s.video_url} target="_blank" rel="noreferrer">
                    ▶ video
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
