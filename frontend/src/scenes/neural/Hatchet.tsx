/** Hatchet runs = firing pathways: 3 ganglia (plan/research/write) glowing by step status, action potential on handoff. */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RUN_LINGER_MS, STEPS, useWorld, world, type Run } from "../shared/world";
import { ICO_GEO, SPHERE_GEO, TUBE_GEO, additiveBasic, anchorPos, bezier, clamp01, easeInOut, easeOut, gangPos, glowSpriteMaterial, reduced, slotOf, tubeMaterial } from "./fx";

const C_QUEUED = new THREE.Color("#3a3f5c");
const C_DONE = new THREE.Color("#4ade80");
const C_FAIL = new THREE.Color("#ef4444");
const AGENT_OF = ["planner", "researcher", "writer"] as const;

function RunRegion({ run }: { run: Run }) {
  const col = useMemo(() => new THREE.Color(run.color), [run.color]);
  const G = useMemo(() => [0, 1, 2].map((k) => gangPos(run.slot, k, new THREE.Vector3())), [run.slot]);
  const m = useMemo(() => {
    const path = tubeMaterial(run.color, 0.05, 1);
    const ctrl = G[1].clone().multiplyScalar(2).sub(G[0].clone().add(G[2]).multiplyScalar(0.5));
    path.uniforms.uP0.value.copy(G[0]);
    path.uniforms.uP1.value.copy(ctrl);
    path.uniforms.uP2.value.copy(G[2]);
    const dispatch = [0, 1, 2].map((k) => {
      const d = tubeMaterial(run.color, 0.03, 0.6);
      const a = anchorPos(run.slot, AGENT_OF[k], new THREE.Vector3());
      d.uniforms.uP0.value.copy(G[k]);
      d.uniforms.uP2.value.copy(a);
      d.uniforms.uP1.value.copy(G[k]).add(a).multiplyScalar(0.5).setZ(1.2);
      return d;
    });
    return {
      path,
      dispatch,
      core: [0, 1, 2].map(() => additiveBasic("#fff")),
      wire: [0, 1, 2].map(() => {
        const w = additiveBasic(run.color);
        w.wireframe = true;
        return w;
      }),
      halo: [0, 1, 2].map(() => glowSpriteMaterial("#fff")),
      head: glowSpriteMaterial(new THREE.Color("#fde68a").multiplyScalar(3)),
      nebula: glowSpriteMaterial(col.clone().multiplyScalar(0.12)),
    };
  }, [G, run.color, run.slot, col]);
  const refs = useRef<{ wire: (THREE.Mesh | null)[]; core: (THREE.Mesh | null)[]; halo: (THREE.Sprite | null)[] }>({ wire: [], core: [], halo: [] });
  const head = useRef<THREE.Sprite>(null);
  const root = useRef<THREE.Group>(null);
  const tmp = useMemo(() => ({ c: new THREE.Color(), v: new THREE.Vector3() }), []);
  const S = slotOf(run.slot);
  const center = useMemo(() => S.dir.clone().multiplyScalar((S.somaR + S.gangR) / 2 - 0.5), [S]);

  useFrame(({ clock }, dt) => {
    const now = performance.now();
    const t = clock.elapsedTime;
    const grow = easeOut((now - run.startedAt) / 900);
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2200)) / 2000) : 1;
    const pres = grow * fade;
    root.current?.scale.setScalar(0.4 + 0.6 * grow);
    const { c } = tmp;
    let anyRunning = false;
    STEPS.forEach((st, k) => {
      const s = run.steps[st];
      const running = s === "running";
      anyRunning ||= running;
      const beat = running ? 0.5 + 0.5 * Math.sin(t * (reduced ? 2 : 6)) : 0;
      c.copy(s === "queued" ? C_QUEUED : s === "done" ? C_DONE : s === "failed" ? C_FAIL : col).multiplyScalar((running ? 1.0 + beat * 1.0 : s === "done" ? 0.8 : 0.6) * pres);
      m.core[k].color.copy(c);
      m.wire[k].color.copy(c).multiplyScalar(running ? 1.2 : 0.7);
      m.halo[k].color.copy(c).multiplyScalar(running ? 0.45 : s === "done" ? 0.25 : 0.1);
      const w = refs.current.wire[k];
      if (w) {
        w.rotation.y += dt * (running ? 2.2 : 0.25);
        w.rotation.x += dt * (running ? 1.1 : 0.1);
        w.scale.setScalar(0.62 + beat * 0.12);
      }
      refs.current.core[k]?.scale.setScalar(running ? 0.3 + beat * 0.08 : 0.24);
      refs.current.halo[k]?.scale.setScalar(running ? 2.4 + beat * 0.7 : s === "done" ? 1.6 : 1.1);
      const d = m.dispatch[k].uniforms;
      d.uColor.value.copy(running ? col : s === "done" ? C_DONE : C_QUEUED);
      d.uOpacity.value = (running ? 0.9 : s === "done" ? 0.25 : 0.12) * pres;
      d.uSpark.value = running ? 1 : 0;
      d.uTime.value = t;
    });
    // action potential racing between ganglia on handoff
    const p = m.path.uniforms;
    p.uOpacity.value = 0.35 * pres;
    p.uSpark.value = anyRunning ? 0.6 : 0;
    p.uTime.value = t;
    const ht = run.handoffAt ? (now - run.handoffAt) / 1200 : 9;
    if (ht >= 0 && ht < 1) {
      const a = STEPS.indexOf(run.handoffFrom) / 2;
      const b = STEPS.indexOf(run.handoffTo) / 2;
      const u = a + (b - a) * easeInOut(ht);
      p.uHead.value = u;
      p.uTail.value = 0.12;
      p.uHeadColor.value.setRGB(5, 4.2, 2.2);
      if (head.current) {
        bezier(p.uP0.value, p.uP1.value, p.uP2.value, u, tmp.v);
        head.current.position.copy(tmp.v);
        head.current.scale.setScalar(2.2 + Math.sin(t * 40) * 0.3);
      }
    } else {
      p.uHead.value = -1;
      head.current?.scale.setScalar(0.0001);
    }
    m.nebula.color.copy(col).multiplyScalar(0.11 * pres);
  });

  return (
    <group>
      <sprite material={m.nebula} position={center} scale={[11, 9, 1]} />
      <mesh geometry={TUBE_GEO} material={m.path} frustumCulled={false} />
      {m.dispatch.map((d, k) => (
        <mesh key={k} geometry={TUBE_GEO} material={d} frustumCulled={false} />
      ))}
      <sprite ref={head} material={m.head} scale={0.0001} />
      <group ref={root}>
        {G.map((g, k) => (
          <group key={k} position={g}>
            <mesh ref={(x) => void (refs.current.core[k] = x)} geometry={SPHERE_GEO} material={m.core[k]} />
            <mesh ref={(x) => void (refs.current.wire[k] = x)} geometry={ICO_GEO} material={m.wire[k]} />
            <sprite ref={(x) => void (refs.current.halo[k] = x)} material={m.halo[k]} />
          </group>
        ))}
      </group>
      <RunLabel run={run} pos={Math.abs(S.dir.x) > 0.5 ? G[0] : G[2]} out={S.dir} tan={S.tan} />
    </group>
  );
}

const MARK = { queued: "○", running: "●", done: "✓", failed: "✕" } as const;
const MARK_C = { queued: "#64748b", running: "#fde68a", done: "#4ade80", failed: "#ef4444" } as const;

function RunLabel({ run, pos, out, tan }: { run: Run; pos: THREE.Vector3; out: THREE.Vector3; tan: THREE.Vector3 }) {
  useWorld(); // re-render on events (DOM only)
  const p = useMemo(() => {
    const v = pos.clone();
    if (Math.abs(out.x) > 0.5) v.y += 1.25;
    else v.addScaledVector(tan, 3.2);
    return v;
  }, [pos, out, tan]);
  return (
    <Html center position={p} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
      <div className="scene-label" style={{ ["--c" as string]: run.color, opacity: run.status === "started" ? 1 : 0.55, display: "grid", gap: 2, textAlign: "center" }}>
        <span>hatchet · {run.topic}</span>
        <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.04em" }}>
          {STEPS.map((s, i) => (
            <span key={s} style={{ color: MARK_C[run.steps[s]] }}>
              {i ? "  →  " : ""}
              {MARK[run.steps[s]]} {s}
            </span>
          ))}
        </span>
      </div>
    </Html>
  );
}

export function Pathways() {
  const [list, setList] = useState<Run[]>([]);
  const known = useRef(new Set<string>());
  useFrame(() => {
    const m = world.runs;
    let changed = m.size !== known.current.size;
    if (!changed) for (const id of m.keys()) if (!known.current.has(id)) changed = true;
    if (changed) {
      known.current = new Set(m.keys());
      setList([...m.values()]);
    }
  });
  return (
    <>
      {list.map((r) => (
        <RunRegion key={r.id} run={r} />
      ))}
    </>
  );
}
