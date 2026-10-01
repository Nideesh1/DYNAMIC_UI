/**
 * Circuit LOD: collapsed lanes become a rack of hovering power-core swarms along the front edge of the board,
 * one per lane in lane order (lane color). The far buses foreshorten too tightly to hold a badge each, so the
 * rack sits in the open foreground where every badge stays readable.
 */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";

const RACK_X0 = -9.5;
const RACK_DX = 4.1;
const RACK_Z = 7.5;

function place(lane: number, out: THREE.Vector3, t: number) {
  // two staggered rows so neighbouring badges never touch
  return out.set(RACK_X0 + lane * RACK_DX, 2.2 + Math.sin(t * 0.6 + lane) * 0.15, RACK_Z + (lane % 2 ? -3.2 : 1.2));
}

export function CircuitClusters() {
  return <ClusterBalls place={place} radius={1.1} variant="orb" glowGain={0.85} />;
}
