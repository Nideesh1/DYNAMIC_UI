/**
 * Airport LOD: each collapsed lane of runs becomes a radar-green cluster of returns sitting on the scope in that
 * lane's sector; when expanded flights also hold in the sector, the cluster moves out toward the rim beside them.
 */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { SCOPE_R, TAU, polar } from "./fx";

function place(lane: number, out: THREE.Vector3) {
  const b = (lane * TAU) / 6;
  if (lod.laneExpanded[lane]) return polar(b - 0.42, SCOPE_R - 2.2, 0.9, out);
  return polar(b, SCOPE_R * 0.52, 0.9, out);
}

export function AirportClusters() {
  return <ClusterBalls place={place} radius={1.2} variant="stars" color="#46ff9a" />;
}
