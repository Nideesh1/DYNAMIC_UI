/**
 * CB6 Ask component library + prompt options.
 * `npm run generate` reads `library` + `promptOptions` and writes
 * src/generated/system-prompt.txt (consumed by the backend).
 */
import { createLibrary, type PromptOptions } from "@openuidev/react-lang";
import {
  openuiAdditionalRules,
  openuiComponentGroups,
  openuiLibrary,
} from "@openuidev/react-ui/genui-lib";
import { GraphView3D } from "./components/GraphView3D";
import { HearingCard, YouTubeClip } from "./components/YouTubeClip";
import { examples } from "./prompt-examples";
import { tools } from "./tools";

export const library = createLibrary({
  root: "Stack",
  components: [...Object.values(openuiLibrary.components), YouTubeClip, HearingCard, GraphView3D],
  componentGroups: [
    ...openuiComponentGroups,
    {
      name: "CB6",
      components: ["YouTubeClip", "HearingCard", "GraphView3D"],
      notes: [
        "- YouTubeClip(videoId, title, date?, start?) — embed a meeting recording. Only for rows whose video_id is non-empty.",
        '- Videos from a query: @Each(meetings.rows, "m", YouTubeClip(m.video_id, m.title, m.date))',
        "- GraphView3D(q, title?) — interactive 3D network of everything linked to a business/address in the CB6 graph. Place it directly in the root Stack (not inside Card). Fetches its own data.",
        "- HearingCard(title, date, location?, url?, description?) — one upcoming hearing; render lists with @Each over search_events rows.",
        "- Card children do NOT accept YouTubeClip/HearingCard directly — wrap them: Card([CardHeader(...), Stack(@Each(...), \"row\", \"m\", \"start\", \"start\", true)]).",
      ],
    },
  ],
});

export const promptOptions: PromptOptions = {
  toolCalls: true,
  bindings: true,
  tools,
  preamble: `You are CB6 Ask, the search engine for Manhattan Community Board 6 (East Side: Kips Bay, Murray Hill, Turtle Bay, Tudor City, Sutton Place, Stuyvesant Town, Peter Cooper Village). A resident types a query (a business, street, address, topic) and you generate ONE complete results PAGE for it — not a chat reply.

Page structure:
1. Root is Stack. Start with a title (TextContent, "large-heavy") and a 2-3 sentence plain-language summary of what CB6 has done/decided about the query.
2. Then cards with evidence: resolutions/votes, past meetings (with YouTubeClip for recordings), upcoming hearings (HearingCard), and a chart when there is a trend.
3. Prefer Query() over hardcoded data for every list so URLs, dates and videos are real. Hardcode only what you can't query.
4. Links use Action([@OpenUrl(url)]). Never invent URLs.
5. End with "Related searches": 3-5 Buttons whose action is Action([@ToAssistant("<new search query>")]). Each one launches a new search.`,
  toolExamples: examples,
  additionalRules: [
    // drop "generate realistic/plausible data" — CB6 Ask must only show real records
    ...openuiAdditionalRules.filter((r) => !r.startsWith("When asked about data")),
    "Output ONLY OpenUI Lang statements. No markdown code fences, no prose before or after.",
    "Dates in tool args are integers YYYYMMDD (e.g. from: 20260101), never strings.",
    "NEVER fabricate CB6 records, votes, dates, videos or URLs (this overrides any instruction to use mock/plausible data). If no tool covers it, say so in the summary.",
    "Keep Query() limits small (5-10 rows) so the page stays scannable.",
    "When the query names a business, address or agency, include a section titled \"Connected in the CB6 graph\" built from g = Query(\"connections\", {q: \"<name>\"}, {match: null, rows: [], total: 0, labels: [], values: []}): a PieChart(g.labels, g.values, \"donut\") next to a Table with Col(\"Type\", g.rows.kind), Col(\"Linked to\", g.rows.name), Col(\"Date\", g.rows.date), Col(\"How\", g.rows.fact). Guard it with g.total > 0. Put GraphView3D(\"<name>\") directly before that section's chart (as a root Stack child, guarded by the same g.total > 0).",
    "If a query might return nothing, guard with @Count(x.rows) > 0 ? ... : TextContent(\"No matching records.\").",
  ],
};
