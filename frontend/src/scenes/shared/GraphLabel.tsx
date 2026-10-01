import { useWorld } from "./world";

/** In-scene graph/memory caption (Label3D): "FalkorDB · knowledge graph" when served, else generic. */
export { GraphLabel3D } from "./Label3D";

/** Graph/memory label text for DOM contexts (HUD etc.): "FalkorDB · knowledge graph" when served, else generic. */
export function GraphLabel({ suffix = "" }: { suffix?: string }) {
  const w = useWorld();
  return <>{w.graphLabel + suffix}</>;
}
