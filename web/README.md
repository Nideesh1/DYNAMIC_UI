# CB6 Ask — frontend

Vite + React 19 + OpenUI (`@openuidev/react-lang` Renderer). Search page that streams an
OpenUI Lang page from the backend and renders it progressively.

```bash
npm install
npm run generate   # writes src/generated/system-prompt.txt (read by the backend)
npm run dev        # http://localhost:5173, proxies /api -> http://localhost:8000
npm run build      # tsc --noEmit + vite build
npm run validate   # parses the home dashboard + prompt examples against the library
```

- `src/library.ts` — `library` (openuiLibrary + YouTubeClip + HearingCard) and `promptOptions`
- `src/tools.ts` — the 5 tool specs (input/output JSON schema) used in the prompt
- `src/home.ts` — hardcoded home dashboard (OpenUI Lang)
- `src/prompt-examples.ts` — full-page examples injected into the prompt
- `src/api.ts` — SSE client for `POST /api/search`, toolProvider for `POST /api/tools/{name}`

Re-run `npm run generate` after changing the library, tools, examples or preamble.
