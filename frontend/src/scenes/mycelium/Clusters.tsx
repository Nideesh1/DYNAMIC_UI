/**
 * Mycelium LOD: each collapsed lane of runs becomes a churning spore swarm (violet / teal, alternating round the
 * mat) hovering over that lane's sector of the network; when the sector also holds expanded colonies, the swarm
 * steps round beside them.
 */
import * as THREE from "three";
import { ClusterBall } from "../shared/ClusterBall";
import { LOD_LANES, lod } from "../shared/lod";
import { RUN_R } from "./fx";

const COLORS = ["#a855f7", "#2dd4bf"];
const LANES = Array.from({ length: LOD_LANES }, (_, k) => k);

function place(lane: number, out: THREE.Vector3) {
  // same angle as runAngle(lane) without the per-run jitter; aside + further out when the sector is busy
  const busy = lod.laneExpanded[lane] > 0;
  const a = lane * (Math.PI / 3) + Math.PI / 6 + (busy ? -0.5 : 0);
  const r = RUN_R + (busy ? 4.2 : 1.6);
  return out.set(Math.cos(a) * r, 1.6, Math.sin(a) * r);
}

export function MyceliumClusters() {
  return (
    <>
      {LANES.map((k) => (
        <ClusterBall key={k} cluster={lod.clusters[k]} place={place} radius={1.4} variant="swarm" color={COLORS[k % 2]} />
      ))}
    </>
  );
}
