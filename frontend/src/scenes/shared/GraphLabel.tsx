import { useWorld } from "./world";

/** Graph/memory label: "FalkorDB · knowledge graph" when the server serves a real FalkorDB graph, else generic. */
export function GraphLabel({ suffix = "" }: { suffix?: string }) {
  const w = useWorld();
  return <>{w.graphLabel + suffix}</>;
}
