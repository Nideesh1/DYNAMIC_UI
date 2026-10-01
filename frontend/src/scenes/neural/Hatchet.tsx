/** Hatchet run = a soft aura in run.color behind its agents + one label (topic, plan › research › write). */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { RUN_LINGER_MS, STEPS, useWorld, world, type Run } from "../shared/world";
import { clamp01, easeOut, glowSpriteMaterial, slotOf } from "./fx";

function RunAura({ run }: { run: Run }) {
  const S = slotOf(run.slot);
  const col = useMemo(() => new THREE.Color(run.color), [run.color]);
  const mat = useMemo(() => glowSpriteMaterial("#000"), []);
  const center = useMemo(() => S.dir.clone().multiplyScalar(S.somaR + S.fanLen * 0.35).setZ(-1.5), [S]);
  const horizontal = Math.abs(S.dir.x) > 0.5;
  const aura = useRef<THREE.Sprite>(null);
  useFrame(({ clock }) => {
    const now = performance.now();
    const grow = easeOut((now - run.startedAt) / 1200);
    const fade = run.endedAt ? clamp01(1 - (now - run.endedAt - (RUN_LINGER_MS - 2500)) / 2500) : 1;
    const breathe = 0.9 + 0.1 * Math.sin(clock.elapsedTime * 0.6 + run.slot);
    mat.color.copy(col).multiplyScalar(0.16 * grow * fade * breathe);
    aura.current?.scale.set(horizontal ? 9.5 : 13, horizontal ? 11 : 7.5, 1);
  });
  const labelPos = useMemo(() => {
    const v = S.dir.clone().multiplyScalar(S.somaR);
    if (horizontal) v.y += S.spread + 1.9;
    else v.addScaledVector(S.dir, S.fanLen + 1.8);
    return v;
  }, [S, horizontal]);
  return (
    <>
      <sprite ref={aura} material={mat} position={center} />
      <RunLabel run={run} pos={labelPos} />
    </>
  );
}

function RunLabel({ run, pos }: { run: Run; pos: THREE.Vector3 }) {
  useWorld(); // DOM-only re-render on events
  const current = STEPS.find((s) => run.steps[s] === "running");
  const done = run.status !== "started";
  return (
    <Html center position={pos} zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
      <div className="scene-label" style={{ ["--c" as string]: run.color, opacity: done ? 0.5 : 1, display: "grid", gap: 2, textAlign: "center", padding: "4px 10px" }}>
        <span>{run.topic}</span>
        {run.hasSteps ? (
        <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.03em", color: "#94a3b8" }}>
          hatchet ·{" "}
          {STEPS.map((s, i) => (
            <span key={s}>
              {i ? " › " : ""}
              <span style={s === current ? { color: "#fde68a", fontWeight: 800 } : run.steps[s] === "done" ? { color: "#cbd5e1" } : { opacity: 0.55 }}>{s}</span>
            </span>
          ))}
          {done ? " ✓" : ""}
        </span>
        ) : (
          <span style={{ fontSize: 10, fontWeight: 500, color: "#94a3b8" }}>{done ? "run complete ✓" : "running…"}</span>
        )}
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
        <RunAura key={r.id} run={r} />
      ))}
    </>
  );
}
