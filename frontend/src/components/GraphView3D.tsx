import { defineComponent, useTriggerAction } from "@openuidev/react-lang";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import SpriteText from "three-spritetext";
import { z } from "zod/v4";
import { toolProvider } from "../api";

// three.js is heavy — only load it when a page actually shows a graph
const ForceGraph3D = lazy(() => import("react-force-graph-3d"));

type GNode = { id: string; name: string; kind: string; center?: boolean; x?: number; y?: number; z?: number };
type GLink = { source: string; target: string; rel: string };
type Sub = { center: string | null; nodes: GNode[]; links: GLink[] };

export const KIND_COLORS: Record<string, string> = {
  Business: "#f59e0b",
  Address: "#38bdf8",
  Resolution: "#22c55e",
  Meeting: "#a78bfa",
  Hearing: "#f472b6",
  Agency: "#ef4444",
  Committee: "#14b8a6",
  Topic: "#eab308",
};

function short(s: string, n = 34) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function GraphView3DView({ q, title, height = 460 }: { q: string; title?: string; height?: number }) {
  const [data, setData] = useState<Sub | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const fg = useRef<any>(null);
  const [width, setWidth] = useState(800);
  const triggerAction = useTriggerAction();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null);
    setSettled(false);
    toolProvider.graph_subgraph({ q, hops: 2, limit: 150 })
      .then((r) => live && setData(r as Sub))
      .catch((e) => live && setErr(String(e)));
    return () => {
      live = false;
    };
  }, [q]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // slow auto-orbit until the user grabs it
  useEffect(() => {
    if (!settled) return; // orbit only after zoomToFit, or it cancels the zoom
    let angle = 0;
    let stop = false;
    const id = window.setInterval(() => {
      if (stop || !fg.current) return;
      const cam = fg.current.camera?.();
      if (!cam) return;
      // keep the zoomToFit distance, just orbit around the y axis
      const d = Math.hypot(cam.position.x, cam.position.z) || 200;
      angle = Math.atan2(cam.position.x, cam.position.z) + Math.PI / 900;
      fg.current.cameraPosition({ x: d * Math.sin(angle), y: cam.position.y, z: d * Math.cos(angle) });
    }, 30);
    const el = wrap.current;
    const halt = () => (stop = true);
    el?.addEventListener("pointerdown", halt);
    el?.addEventListener("wheel", halt);
    return () => {
      window.clearInterval(id);
      el?.removeEventListener("pointerdown", halt);
      el?.removeEventListener("wheel", halt);
    };
  }, [settled]);

  const graph = useMemo(() => data && { nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) }, [data]);
  const kinds = useMemo(() => [...new Set(data?.nodes.map((n) => n.kind) ?? [])], [data]);

  if (err) return null;
  if (data && !data.nodes.length) return null;

  return (
    <section className="graph3d">
      <header className="graph3d__head">
        <div>
          <h3>{title || `How ${data?.center ?? q} connects`}</h3>
          <p>
            {data ? `${data.nodes.length} entities · ${data.links.length} links from the CB6 knowledge graph` : "Loading graph…"} · drag to
            rotate, scroll to zoom, click a node to search it
          </p>
        </div>
        <ul className="graph3d__legend">
          {kinds.map((k) => (
            <li key={k}>
              <i style={{ background: KIND_COLORS[k] ?? "#94a3b8" }} />
              {k}
            </li>
          ))}
        </ul>
      </header>
      <div className="graph3d__canvas" ref={wrap} style={{ height }}>
        {graph && (
          <Suspense fallback={<div className="graph3d__loading">Loading 3D…</div>}>
            <ForceGraph3D
              ref={fg}
              graphData={graph}
              width={width}
              height={height}
              backgroundColor="rgba(0,0,0,0)"
              showNavInfo={false}
              nodeRelSize={5}
              nodeVal={(n: any) => (n.center ? 6 : n.kind === "Business" || n.kind === "Address" ? 2.2 : 1.2)}
              nodeColor={(n: any) => KIND_COLORS[n.kind] ?? "#94a3b8"}
              nodeOpacity={0.95}
              nodeLabel={(n: any) => `<b>${n.kind}</b><br/>${n.name}`}
              nodeThreeObjectExtend
              nodeThreeObject={(n: any) => {
                if (!(n.center || n.kind === "Business" || n.kind === "Address" || n.kind === "Agency")) return undefined as any;
                const t = new SpriteText(short(n.name));
                t.color = n.center ? "#ffffff" : "#cbd5e1";
                t.textHeight = n.center ? 6 : 3.4;
                (t as any).position.y = n.center ? 12 : 7;
                return t;
              }}
              linkColor={() => "rgba(148,163,184,0.35)"}
              linkWidth={0.6}
              linkLabel={(l: any) => l.rel}
              linkDirectionalParticles={1}
              linkDirectionalParticleWidth={1.4}
              linkDirectionalParticleSpeed={0.004}
              cooldownTicks={90}
              warmupTicks={40}
              onEngineStop={() => {
                if (settled) return;
                fg.current?.zoomToFit(700, 10);
                window.setTimeout(() => setSettled(true), 800);
              }}
              onNodeClick={(n: any) => {
                if (!n.center) triggerAction(n.kind === "Resolution" || n.kind === "Meeting" ? short(n.name, 80) : n.name);
              }}
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}

export const GraphView3D = defineComponent({
  name: "GraphView3D",
  props: z.object({
    q: z.string().describe("Business name or street address to center the graph on, e.g. \"Tara Rose\" or \"384 3rd Avenue\""),
    title: z.string().optional(),
    height: z.number().optional(),
  }),
  description:
    "Interactive 3D knowledge-graph network (FalkorDB) around a business/address: businesses, addresses, votes, meetings, hearings, agencies. Fetches its own data. Clicking a node searches it.",
  component: ({ props }) => <GraphView3DView q={props.q} title={props.title} height={props.height} />,
});
