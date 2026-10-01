/** Flow LOD: each collapsed lane of runs becomes a churning murmuration swarm over that lane's vortex. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { RUN_CENTERS } from "./engine";

function place(lane: number, out: THREE.Vector3, t: number) {
  const [cx, cz] = RUN_CENTERS[lane];
  // the right-hand vortex sits under the agent panel: pull its swarm inward
  let k = lane === 1 ? 0.74 : 1;
  // sharing the lane with an expanded run: rise above its vortex and lean toward the nebula, clear of its eddies + label
  const shared = lod.laneExpanded[lane] > 0;
  if (shared) k *= 0.82;
  return out.set(cx * k, (shared ? 5.2 : 1.8) + Math.sin(t * 0.6 + lane * 2.1) * 0.2, cz * k);
}

export function FlowClusters() {
  return <ClusterBalls place={place} radius={1.7} variant="swarm" pointSize={1.1} />;
}
