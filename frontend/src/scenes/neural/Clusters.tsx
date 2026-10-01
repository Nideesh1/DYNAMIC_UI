/** Neural LOD: each collapsed lane of runs becomes a glowing ganglion swarm where that lane's pathway lives. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { slotOf } from "./fx";

/** Stage-space spots for a lane's cluster when that lane also shows expanded runs: beside their fan, clear of the HUD. */
const BESIDE: [number, number, number][] = [
  [-12.5, -3.8, -1],
  [11.3, -3.4, -1.5],
  [10, 10.2, -3],
  [4.5, -10, -1],
  [-10.5, 7.3, -1],
  [10.5, -7.5, -1],
];

function place(lane: number, out: THREE.Vector3) {
  if (lod.laneExpanded[lane]) return out.fromArray(BESIDE[lane]);
  // alone in its lane: sit where that lane's runs would be
  const S = slotOf(lane);
  // (the upper lane sits a little higher so its badge clears the cortex)
  return out.copy(S.dir).multiplyScalar(S.somaR + S.fanLen * 0.35 + (lane === 2 ? 1.3 : 0)).setZ(-0.4);
}

export function NeuralClusters() {
  return <ClusterBalls place={place} radius={1.45} variant="orb" />;
}
