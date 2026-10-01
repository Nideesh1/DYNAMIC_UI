/** City LOD: each collapsed lane of runs becomes a hovering drone swarm over that lane's district lot. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { DISTRICT_R, slotAngle } from "./layout";

function place(lane: number, out: THREE.Vector3, t: number) {
  const a = slotAngle(lane);
  // alone: hover low over the empty lot. Sharing the lane with an expanded district: rise above its skyline
  // (towers top out ~9) and drift a little toward the outer ring so it doesn't hide the rooftops.
  const shared = lod.laneExpanded[lane] > 0;
  const r = shared ? DISTRICT_R + 3 : DISTRICT_R;
  const y = (shared ? 13.5 : 4.6) + Math.sin(t * 0.6 + lane) * 0.25;
  return out.set(Math.sin(a) * r, y, Math.cos(a) * r);
}

export function CityClusters() {
  return <ClusterBalls place={place} radius={2.3} variant="swarm" pointSize={1.05} />;
}
