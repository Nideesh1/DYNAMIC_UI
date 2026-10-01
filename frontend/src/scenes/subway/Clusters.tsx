/** Subway LOD: each collapsed lane of runs becomes a flattened star-cluster "interchange" on that lane's bearing. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { slotAngle } from "./layout";

function place(lane: number, out: THREE.Vector3) {
  // alone: on the lane's bearing, between research and write. Sharing the lane with expanded lines (which fan to
  // +0.22 rad per extra run): swing to the other side of the bearing so it never sits on their track.
  const shared = lod.laneExpanded[lane] > 0;
  const a = slotAngle(lane) - (shared ? 0.45 : 0);
  const r = shared ? 15.5 : 15;
  return out.set(Math.cos(a) * r, 1.9, Math.sin(a) * r);
}

export function SubwayClusters() {
  return <ClusterBalls place={place} radius={1.9} variant="stars" pointSize={1.1} />;
}
