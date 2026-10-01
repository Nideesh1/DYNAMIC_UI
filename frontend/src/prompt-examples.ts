// Full-page examples injected into the system prompt (toolExamples).
export const examples: string[] = [
  `Example 1 — topic query "rats":

root = Stack([title, summary, votesCard, meetingsCard, hearingsCard, related], "column", "l")
votes = Query("search_resolutions", {q: "rats rodent sanitation", limit: 6}, {rows: [], total: 0})
meetings = Query("search_meetings", {q: "rats rodent", limit: 4}, {rows: [], total: 0})
hearings = Query("search_events", {q: "sanitation", from: 20260101, limit: 3}, {rows: [], total: 0})
title = TextContent("Rats & sanitation in CB6", "large-heavy")
summary = TextContent("CB6 has repeatedly pushed the city for rat mitigation — containerized trash, more frequent pickups and enforcement near restaurants. Below are the board's recent votes, the meetings where it was discussed, and upcoming hearings where you can weigh in.")
votesCard = Card([CardHeader("Board votes", "" + votes.total + " related resolutions"), votesTable])
votesTable = @Count(votes.rows) > 0 ? Table([Col("Date", votes.rows.date), Col("Resolution", votes.rows.summary_title), Col("Outcome", @Each(votes.rows, "r", Tag(r.action, null, "sm", r.passed ? "success" : "danger"))), Col("Source", @Each(votes.rows, "r", Button("Open", Action([@OpenUrl(r.url)]), "tertiary", "normal", "small")), "action")]) : TextContent("No matching resolutions.")
meetingsCard = Card([CardHeader("Where it was discussed", "Recorded committee meetings"), meetingClips])
meetingClips = Stack(@Each(meetings.rows, "m", YouTubeClip(m.video_id, m.title, m.date)), "row", "m", "start", "start", true)
hearingsCard = Card([CardHeader("Upcoming hearings"), hearingList])
hearingList = @Count(hearings.rows) > 0 ? Stack(@Each(hearings.rows, "h", HearingCard(h.title, h.date, h.location, h.url, h.description)), "column", "s") : TextContent("Nothing scheduled yet.", "small")
related = Card([CardHeader("Related searches"), relatedBtns])
relatedBtns = Buttons([Button("Trash containerization", Action([@ToAssistant("Trash containerization")]), "secondary"), Button("Restaurant sanitation violations", Action([@ToAssistant("Restaurant sanitation violations")]), "secondary"), Button("Sanitation Committee", Action([@ToAssistant("Sanitation Committee")]), "secondary")])`,

  `Example 2 — business/street query "outdoor dining on 2nd Ave":

root = Stack([title, summary, stats, votesCard, trendCard, meetingsCard, related], "column", "l")
votes = Query("search_resolutions", {q: "sidewalk cafe 2nd Avenue", from: 20230101, limit: 8}, {rows: [], total: 0})
meetings = Query("search_meetings", {q: "outdoor dining", committee: "Business Affairs", limit: 3}, {rows: [], total: 0})
trend = Query("topic_trends", {topics: ["Outdoor dining", "Liquor licenses"]}, {labels: [], series: []})
title = TextContent("Outdoor dining on Second Avenue", "large-heavy")
summary = TextContent("Sidewalk and roadway cafes on 2nd Ave come before CB6's Business Affairs & Licensing committee. Most applications are approved, often with stipulations on hours and noise.")
stats = OverviewCardBlock([s1, s2], "grid", true)
s1 = OverviewCardItem("approved", IconText(Icon("circle-check", "status"), "success", "m", "Approved"), MetricIndicatorInline("" + @Count(@Filter(votes.rows, "passed", "==", true)), "since 2023"))
s2 = OverviewCardItem("denied", IconText(Icon("circle-x", "status"), "danger", "m", "Denied"), MetricIndicatorInline("" + @Count(@Filter(votes.rows, "passed", "==", false)), "since 2023"))
votesCard = Card([CardHeader("Recent applications"), votesTable])
votesTable = Table([Col("Date", votes.rows.date), Col("Application", votes.rows.title), Col("Outcome", @Each(votes.rows, "r", Tag(r.action, null, "sm", r.passed ? "success" : "danger"))), Col("Source", @Each(votes.rows, "r", Button("Open", Action([@OpenUrl(r.url)]), "tertiary", "normal", "small")), "action")])
trendCard = Card([CardHeader("Mentions per year"), LineChart(trend.labels, @Each(trend.series, "s", Series(s.name, s.values)), "natural")])
meetingsCard = Card([CardHeader("Committee discussion"), Stack(@Each(meetings.rows, "m", YouTubeClip(m.video_id, m.title, m.date)), "row", "m", "start", "start", true)])
related = Card([CardHeader("Related searches"), Buttons([Button("Liquor licenses on 2nd Ave", Action([@ToAssistant("Liquor licenses on 2nd Ave")]), "secondary"), Button("Open Restaurants program", Action([@ToAssistant("Open Restaurants program")]), "secondary"), Button("Noise complaints", Action([@ToAssistant("Noise complaints")]), "secondary")])])`,
];
