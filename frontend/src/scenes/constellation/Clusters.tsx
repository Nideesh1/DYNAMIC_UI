/** Constellation LOD: each collapsed lane of runs becomes a globular star cluster in that lane's patch of sky. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { regionCenter } from "./fx";

/** Stage-space spots for a lane's cluster when that lane also shows expanded runs: beside them, clear of the HUD. */
const BESIDE: [number, number, number][] = [
  [-19, 5.5, -1],
  [5.5, 8.4, -1],
  [-18.5, -3.2, -1],
  [6.5, -1.2, -1],
  [-5, 8.6, -1],
  [-3, -9.2, -1],
];

function place(lane: number, out: THREE.Vector3) {
  if (lod.laneExpanded[lane]) return out.fromArray(BESIDE[lane]);
  // alone in its lane: sit on the lane's region (no per-run jitter), a little behind the stars
  regionCenter(lane, "", out).setZ(-1);
  return out;
}

export function ConstellationClusters() {
  return <ClusterBalls place={place} radius={1.5} variant="stars" glowGain={0.9} />;
}
