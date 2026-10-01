/** Today's date as a YYYYMMDD integer (local time). */
export function todayInt(d = new Date()): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** Static OpenUI Lang for the home dashboard (no LLM involved). */
export function homeDashboard(today: number = todayInt()): string {
  return `root = Stack([statsHeader, statTiles, mainRow], "column", "l")
stats = Query("home_stats", {}, {upcoming_hearings: 0, meetings_this_month: 0, resolutions_this_year: 0, top_topic: "", top_topic_trend: ""})
events = Query("search_events", {from: ${today}, limit: 6}, {rows: [], total: 0})
trends = Query("topic_trends", {topics: ["Housing", "Budget", "Parks", "Transportation"]}, {labels: [], series: []})
statsHeader = InlineHeader("Community Board 6 at a glance", "Kips Bay · Murray Hill · Turtle Bay · Tudor City · Sutton Place · Stuy Town / PCV")
statTiles = OverviewCardBlock([tileHearings, tileMeetings, tileResolutions, tileTopic], "grid", true)
tileHearings = OverviewCardItem("upcoming-hearings", IconText(Icon("calendar-clock", "time"), "info", "m", "Upcoming hearings"), MetricIndicatorInline("" + stats.upcoming_hearings, "scheduled"))
tileMeetings = OverviewCardItem("meetings-month", IconText(Icon("users", "people"), "neutral", "m", "Meetings this month"), MetricIndicatorInline("" + stats.meetings_this_month, "board + committees"))
tileResolutions = OverviewCardItem("resolutions-year", IconText(Icon("gavel", "legal"), "success", "m", "Resolutions this year"), MetricIndicatorInline("" + stats.resolutions_this_year, "votes recorded"))
tileTopic = OverviewCardItem("top-topic", IconText(Icon("trending-up", "chart"), "warning", "m", "Top topic"), MetricIndicatorInline(stats.top_topic == "" ? "—" : stats.top_topic, "" + stats.top_topic_trend))
mainRow = Stack([hearingsCard, trendsCard], "row", "l", "stretch", "start", true)
hearingsCard = Card([CardHeader("Upcoming hearings", "Public meetings you can attend or testify at"), hearingsList])
upcoming = @Sort(events.rows, "date", "asc")
hearingsList = @Count(upcoming) > 0 ? Stack(@Each(upcoming, "e", HearingCard(e.title, e.date, e.location, e.url)), "column", "s") : TextContent("No upcoming hearings found.", "small")
trendsCard = Card([CardHeader("What the board is talking about", "Mentions per year across meetings and resolutions"), trendChart])
trendChart = LineChart(trends.labels, @Each(trends.series, "s", Series(s.name, s.values)), "natural")`;
}
