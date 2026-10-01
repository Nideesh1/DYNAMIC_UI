/** Forest LOD: each collapsed lane of runs becomes a cloud of fireflies hovering over that lane's grove. */
import * as THREE from "three";
import { ClusterBalls } from "../shared/ClusterBall";
import { lod } from "../shared/lod";
import { laneClusterPos } from "./layout";

function place(lane: number, out: THREE.Vector3) {
  return laneClusterPos(lane, lod.laneExpanded[lane] > 0, out);
}

export function ForestClusters() {
  return <ClusterBalls place={place} radius={1.35} variant="swarm" color="#b6f36a" pointSize={0.85} />;
}
