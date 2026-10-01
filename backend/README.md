# CB6 Ask — backend

```
cd backend && uv run uvicorn app.main:app --port 8000 --reload
```
Reads `../.env` (GEMINI_API_KEY), data from `../blockparty`, `../cb6`, `../corpus/store.json` (loaded into memory at startup).
OpenUI system prompt: `$OPENUI_PROMPT_PATH` (default `../frontend/src/generated/system-prompt.txt`). Model: `MODEL` in `app/search.py`.

## Endpoints
- `GET /api/health` → `{ok, store, counts}`
- `POST /api/search {"q": "..."}` → SSE `data: {json}\n\n` events: `sources` (once, after research), `text` (`delta` = OpenUI Lang chunk), `error`, `done` (always last).
  Step 1: Gemini + File Search research notes + local tool rows. Step 2: streamed OpenUI Lang page.
- `POST /api/tools/{name}` (JSON args → JSON), unknown name → 404:
  - `search_resolutions {q?, from?, to?, limit?=20}` → `{rows:[{id,title,summary_title,action,passed,date,url}], total}`
  - `search_events {q?, from?, to?, limit?=20}` → `{rows:[{id,title,date,end_date,location,location_link,url,description}], total}`
  - `search_meetings {q?, committee?, from?, to?, limit?=10}` → `{rows:[{id,title,committee,date,summary,topics,video_id,video_url,url}], total}`
  - `topic_trends {topics:[str], by?:"year"}` → `{labels, series:[{name, values}]}`
  - `home_stats {}` → `{upcoming_hearings, meetings_this_month, resolutions_this_year, top_topic, top_topic_trend}`

`from`/`to` are ints `YYYYMMDD`. `q`: case-insensitive, every word must match as a word prefix; addresses normalized (avenue→ave, street→st, east→e, second→2nd, …); trailing plural `s` dropped. Results newest first.

```
curl -s localhost:8000/api/tools/search_resolutions -H 'content-type: application/json' -d '{"q":"Posto"}'
curl -sN localhost:8000/api/search -H 'content-type: application/json' -d '{"q":"Station Cafe"}'
```
