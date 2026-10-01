/** Atom LOD: each collapsed lane of runs becomes an electron cloud parked on that lane's shell radius. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { shellRadius } from "./fx";

const DEG = Math.PI / 180;
/** Screen-plane angle per lane (stage space, nucleus at origin) — spread around the atom, clear of the HUD corners at 16:9. */
const ANGLE = [200, 20, 100, 290, 150, 340];

function place(lane: number, out: THREE.Vector3) {
  // sharing the lane with expanded runs: slide along and out so the cloud sits beside their shell, not on it
  const beside = lod.laneExpanded[lane] > 0;
  const a = (ANGLE[lane] + (beside ? 38 : 0)) * DEG;
  const r = shellRadius(lane) + (beside ? 1.2 : 0);
  return out.set(Math.cos(a) * r, Math.sin(a) * r, beside ? -1.5 : -0.5);
}

export function AtomClusters() {
  return <ClusterBalls place={place} radius={1.3} variant="orb" />;
}
