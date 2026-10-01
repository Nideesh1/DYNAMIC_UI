import type { ToolSpec } from "@openuidev/react-lang";

const dateInt = { type: "integer", description: "Date as YYYYMMDD integer, e.g. 20260101" };
const limit = { type: "integer", description: "Max rows (default 20)" };
const q = { type: "string", description: "Free-text search (business, street, topic…)" };

const rowsOf = (props: Record<string, unknown>) => ({
  type: "object",
  properties: {
    rows: { type: "array", items: { type: "object", properties: props } },
    total: { type: "integer" },
  },
});

export const TOOL_NAMES = [
  "search_resolutions",
  "search_events",
  "search_meetings",
  "topic_trends",
  "home_stats",
  "connections",
  "graph_subgraph", // used directly by GraphView3D, not advertised to the LLM
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const tools: ToolSpec[] = [
  {
    name: "search_resolutions",
    description:
      "Search CB6 resolutions/votes (liquor licenses, sidewalk cafes, zoning, street co-namings…). Each row has a source url.",
    inputSchema: { type: "object", properties: { q, from: dateInt, to: dateInt, limit } },
    outputSchema: rowsOf({
      id: { type: "string" },
      title: { type: "string" },
      summary_title: { type: "string" },
      action: { type: "string", description: "e.g. Approved, Denied, Approved with stipulations" },
      passed: { type: "boolean" },
      date: { type: "string", description: "YYYY-MM-DD" },
      url: { type: "string" },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_events",
    description: "Search CB6 calendar events/hearings. Use from=<today> for upcoming.",
    inputSchema: { type: "object", properties: { q, from: dateInt, to: dateInt, limit } },
    outputSchema: rowsOf({
      id: { type: "string" },
      title: { type: "string" },
      date: { type: "string", description: "ISO datetime" },
      end_date: { type: "string" },
      location: { type: "string" },
      location_link: { type: "string" },
      url: { type: "string" },
      description: { type: "string" },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_meetings",
    description: "Search past CB6 board/committee meetings with summaries, topics and YouTube recordings.",
    inputSchema: {
      type: "object",
      properties: {
        q,
        committee: { type: "string", description: "Committee name filter, e.g. 'Transportation'" },
        from: dateInt,
        to: dateInt,
        limit,
      },
    },
    outputSchema: rowsOf({
      id: { type: "string" },
      title: { type: "string" },
      committee: { type: "string" },
      date: { type: "string", description: "YYYY-MM-DD" },
      summary: { type: "string" },
      topics: { type: "array", items: { type: "string" } },
      video_id: { type: "string", description: "YouTube id, may be empty" },
      video_url: { type: "string" },
      url: { type: "string" },
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "topic_trends",
    description: "Count of meetings/resolutions mentioning each topic over time. Feed straight into LineChart/BarChart.",
    inputSchema: {
      type: "object",
      properties: {
        topics: { type: "array", items: { type: "string" } },
        by: { type: "string", enum: ["year"] },
      },
      required: ["topics"],
    },
    outputSchema: {
      type: "object",
      properties: {
        labels: { type: "array", items: { type: "string" } },
        series: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } },
          },
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "home_stats",
    description: "Headline numbers for the board.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        upcoming_hearings: { type: "integer" },
        meetings_this_month: { type: "integer" },
        resolutions_this_year: { type: "integer" },
        top_topic: { type: "string" },
        top_topic_trend: { type: "string", description: "Human-readable change, e.g. \"-31% vs prior 90 days\"" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "connections",
    description:
      "Knowledge-graph links (FalkorDB) for a business, address, agency or committee: its address, every CB6 vote about it, meetings where it was discussed, city hearings. Use for any named business/address. labels/values = count per kind (for a PieChart).",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "Business name or street address, e.g. \"Tara Rose\" or \"384 3rd Avenue\"" }, limit } },
    outputSchema: {
      type: "object",
      properties: {
        match: { type: "string", description: "Canonical name of the matched entity, or null" },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", description: "Address | Resolution | Meeting | Hearing | Business | Agency | Topic" },
              name: { type: "string" },
              rel: { type: "string", description: "LOCATED_AT | ABOUT | DISCUSSED | RUN_BY | ..." },
              fact: { type: "string", description: "Readable sentence describing the link" },
              date: { type: "string", description: "YYYY-MM-DD or null" },
            },
          },
        },
        total: { type: "integer" },
        labels: { type: "array", items: { type: "string" } },
        values: { type: "array", items: { type: "integer" } },
      },
    },
    annotations: { readOnlyHint: true },
  },
];
