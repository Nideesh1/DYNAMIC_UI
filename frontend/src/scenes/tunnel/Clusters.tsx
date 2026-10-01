/** Tunnel LOD: each collapsed lane of runs becomes a convoy swarm hovering inside the tunnel on that lane's angle. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { LANE_R, MOTION, laneAngle } from "./lanes";

/** Clusters hang a little ahead of the active gates (closer to the camera) so the six lanes fan out on screen
 * instead of converging on the vanishing point. */
const R = LANE_R - 0.7;
const Z = -5;

function place(lane: number, out: THREE.Vector3, t: number) {
  // alone in its lane: on the lane's own angle; sharing it with expanded runs: swing half-way to the next lane
  // (lanes are 60° apart) so the swarm never sits in front of their ships
  const shared = lod.laneExpanded[lane] > 0;
  const a = laneAngle(lane) + (shared ? Math.PI / 6 : 0);
  const bob = Math.sin(t * 0.7 + lane * 1.7) * 0.2 * MOTION;
  return out.set(Math.cos(a) * R, Math.sin(a) * R + bob, Z);
}

export function TunnelClusters() {
  return <ClusterBalls place={place} radius={0.85} variant="swarm" glowGain={1.1} labelBelow={1.1} />;
}
