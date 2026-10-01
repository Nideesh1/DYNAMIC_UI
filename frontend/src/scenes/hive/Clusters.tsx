/** Hive LOD: each collapsed lane of runs becomes an amber swarm hovering over that lane's patch of comb. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { laneSpot } from "./fx";

/** Stage-space spots for a lane's swarm when that lane also shows expanded runs: beside them, clear of the HUD. */
const BESIDE: [number, number, number][] = [
  [-15.5, 5.5, 3],
  [12, -8, 3],
  [2.5, 8.8, 3],
  [-16.5, -3.6, 3],
  [2, -8.6, 3],
  [-17.5, 0.5, 3],
];

function place(lane: number, out: THREE.Vector3) {
  if (lod.laneExpanded[lane]) return out.fromArray(BESIDE[lane]);
  laneSpot(lane, out);
  // lower-left lanes: lift so the badge clears the event ticker
  if (out.x < 0 && out.y < -3.4) out.y = -3.4;
  return out;
}

export function HiveClusters() {
  return <ClusterBalls place={place} radius={1.6} variant="swarm" color="#ffb627" />;
}
