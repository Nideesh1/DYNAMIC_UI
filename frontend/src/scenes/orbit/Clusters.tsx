/** Orbit LOD: each collapsed lane of runs becomes a globular star cluster parked on that lane's orbital ring. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { ringLocal, ringOf } from "./layout";

const TAU = Math.PI * 2;
/** [ring angle (twelfths of a turn), radius multiplier] per lane - spread around the core, clear of the HUD at 16:9. */
const HOME: [number, number][] = [[4, 1], [1, 1], [1, 1], [2, 1.15], [7, 1], [2, 1]];
/** when the lane also shows expanded runs: slide further along / outside the ring so the cluster sits beside them */
const BESIDE: [number, number][] = [[5, 1.3], [4, 1.15], [11, 1.15], [1, 1], [5, 1], [3, 1.3]];
// lane 5 shares ring 0 with lane 0 (5 rings); its spots are picked on the other side of that ring

function place(lane: number, out: THREE.Vector3) {
  const ring = ringOf(lane);
  const [k, m] = (lod.laneExpanded[lane] ? BESIDE : HOME)[lane];
  return ringLocal(ring.r * m, (k / 12) * TAU, out).applyQuaternion(ring.q);
}

export function OrbitClusters() {
  return <ClusterBalls place={place} radius={1.35} variant="stars" />;
}
