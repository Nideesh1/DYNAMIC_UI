/** Ocean LOD: each collapsed lane of runs becomes a drifting school of plankton-jellies riding that lane's current. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { MOTION, currentPoint } from "./layout";

function place(lane: number, out: THREE.Vector3, t: number) {
  // alone on its current: the school drifts where that lane's jellies would gather (back-row lanes sit further right,
  // like their jellies do). Sharing the current with expanded runs: front lanes move to the current's mouth (left of
  // the plan step), back lanes to its far end — each on its own current, so balls never stack.
  const shared = lod.laneExpanded[lane] > 0;
  const x = shared ? (lane >= 3 ? 8.5 : -9.6) : lane >= 3 ? 4.5 : -2.5;
  currentPoint(lane, x + Math.sin(t * 0.13 * MOTION + lane) * 0.5, t, out);
  out.y += shared ? 0.35 : 1.3;
  out.z += 0.6;
  return out;
}

export function OceanClusters() {
  return <ClusterBalls place={place} radius={1.25} variant="swarm" pointSize={0.9} labelBelow={1.15} />;
}
