/**
 * Factory LOD: each collapsed lane of runs becomes a glowing orange orb hovering over that lane's production line
 * (row z = rowZ(lane)); when an expanded run's line occupies the row, the orb parks at the head of the line
 * (left, clear of the agent panel) instead of on top of its machines.
 */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { LANE_X0, rowBusy, rowZ } from "./layout";

function place(lane: number, out: THREE.Vector3) {
  return out.set(rowBusy(lane) ? LANE_X0 + 3.4 : -4, 2.4, rowZ(lane));
}

export function FactoryClusters() {
  return <ClusterBalls place={place} radius={1.35} variant="orb" color="#ff8a1f" />;
}
