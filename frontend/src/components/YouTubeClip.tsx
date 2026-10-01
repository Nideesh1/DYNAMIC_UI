import { defineComponent } from "@openuidev/react-lang";
import { useState } from "react";
import { z } from "zod/v4";

function clipEmbedUrl(videoId: string, start?: number): string {
  const params = new URLSearchParams({ autoplay: "1", rel: "0" });
  if (start && start > 0) params.set("start", String(Math.floor(start)));
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params}`;
}

function formatStart(s?: number): string | null {
  if (!s || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

function YouTubeClipView(props: { videoId: string; title: string; date?: string; start?: number }) {
  const { videoId, title, date, start } = props;
  const [playing, setPlaying] = useState(false);
  if (!videoId) return null;
  const ts = formatStart(start);
  return (
    <figure className="yt-clip">
      <div className="yt-clip__frame">
        {playing ? (
          <iframe
            src={clipEmbedUrl(videoId, start)}
            title={title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <button
            type="button"
            className="yt-clip__thumb"
            onClick={() => setPlaying(true)}
            aria-label={`Play ${title}`}
          >
            <img src={`https://img.youtube.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`} alt="" loading="lazy" />
            <span className="yt-clip__play" aria-hidden>
              ▶
            </span>
            {ts && <span className="yt-clip__ts">from {ts}</span>}
          </button>
        )}
      </div>
      <figcaption>
        <span className="yt-clip__title">{title}</span>
        {date && <span className="yt-clip__date">{date}</span>}
      </figcaption>
    </figure>
  );
}

export const YouTubeClip = defineComponent({
  name: "YouTubeClip",
  props: z.object({
    videoId: z.string().describe("YouTube video id (e.g. from search_meetings row.video_id)"),
    title: z.string(),
    date: z.string().optional().describe("Meeting date, YYYY-MM-DD"),
    start: z.number().optional().describe("Start offset in seconds"),
  }),
  description:
    "Recorded CB6 meeting video. Shows a thumbnail; clicking plays it inline. Use for meetings that have a video_id.",
  component: ({ props }) => <YouTubeClipView {...props} />,
});

function HearingCardView(props: {
  title: string;
  date: string;
  location?: string;
  url?: string;
  description?: string;
}) {
  const { title, date, location, url, description } = props;
  if (!title) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "");
  // Date-only strings parse as UTC midnight; build a local date instead so the day doesn't shift.
  const d = dateOnly ? new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) : new Date(date);
  const valid = !Number.isNaN(d.getTime());
  return (
    <article className="hearing-card">
      <div className="hearing-card__date" aria-hidden>
        <span>{valid ? d.toLocaleString("en-US", { month: "short" }) : ""}</span>
        <strong>{valid ? d.getDate() : "—"}</strong>
      </div>
      <div className="hearing-card__body">
        <h4>{url ? <a href={url} target="_blank" rel="noreferrer">{title}</a> : title}</h4>
        <p className="hearing-card__meta">
          {valid
            ? d.toLocaleString("en-US", dateOnly ? { weekday: "long" } : { weekday: "short", hour: "numeric", minute: "2-digit" })
            : date}
          {location ? ` · ${location}` : ""}
        </p>
        {description && <p className="hearing-card__desc">{description}</p>}
      </div>
    </article>
  );
}

export const HearingCard = defineComponent({
  name: "HearingCard",
  props: z.object({
    title: z.string(),
    date: z.string().describe("ISO date or datetime"),
    location: z.string().optional(),
    url: z.string().optional(),
    description: z.string().optional(),
  }),
  description: "An upcoming CB6 hearing or meeting (calendar-style date badge, title linked to url, location).",
  component: ({ props }) => <HearingCardView {...props} />,
});
