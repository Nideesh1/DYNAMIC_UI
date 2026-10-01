/**
 * Wraps a scene's knowledge-graph centerpiece (and its GraphLabel3D). Renders nothing until the session has a
 * graph (world.hasGraph); when it flips true mid-session the graph grows in from `pivot` over GRAPH_FADE_MS
 * (smoothstep, matched by graphMix() so agent layouts ease outward in sync). In sim it is simply there.
 */
import { useFrame } from "@react-three/fiber";
import { useRef, type ReactNode } from "react";
import type * as THREE from "three";
import { graphMix, useHasGraph } from "./world";

export function GraphFade({ children, pivot = [0, 0, 0], show = true }: { children: ReactNode; pivot?: [number, number, number]; show?: boolean }) {
  const has = useHasGraph();
  const outer = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = outer.current;
    if (!g) return;
    const m = graphMix();
    const s = Math.max(0.001, m);
    g.scale.setScalar(s);
    g.visible = m > 0.002;
  });
  if (!has || !show) return null;
  // pivot: scale about the centerpiece's own center (outer group sits at pivot, inner shifts back)
  return (
    <group ref={outer} position={pivot} scale={0.001}>
      <group position={[-pivot[0], -pivot[1], -pivot[2]]}>{children}</group>
    </group>
  );
}
