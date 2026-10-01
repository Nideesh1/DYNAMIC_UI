/** Every scene calls this once: starts the event source (simulator for now) and loads the FalkorDB galaxy sample. */
import { useEffect, useState } from "react";
import { runWorldSimulator } from "./sim";

export type GalaxyNode = { id: string; name: string; kind: string };
export type Galaxy = { nodes: GalaxyNode[]; links: { source: string; target: string }[] };

const KINDS = ["Business", "Address", "Resolution", "Meeting", "Hearing", "Agency", "Topic", "Committee"];
const WEIGHTS = [0.24, 0.24, 0.22, 0.12, 0.06, 0.03, 0.05, 0.04];
const NAMED = [
  "Tara Rose", "384 3rd Avenue", "Kips Bay Hospitality LLC", "Turtle Bay Tavern", "987 2nd Avenue",
  "New York State Liquor Authority", "Murray Cafe", "165 Lexington Avenue", "The Station Cafe", "245 East 34th Street",
  "HBSG LLC", "NYC Department of Transportation", "Dining Out NYC", "3rd Avenue", "Sanitation", "2nd Avenue",
  "Rat Mitigation Zone", "Posto", "310 2nd Avenue", "Housing", "Stuyvesant Town", "Peter Cooper Village",
];

function fakeGalaxy(n = 320): Galaxy {
  const nodes = Array.from({ length: n }, (_, i) => {
    if (i < NAMED.length) return { id: NAMED[i], name: NAMED[i], kind: /\d/.test(NAMED[i]) || /Avenue|Street/.test(NAMED[i]) ? "Address" : "Business" };
    let r = Math.random();
    let k = 0;
    while (k < WEIGHTS.length - 1 && (r -= WEIGHTS[k]) > 0) k++;
    return { id: `n${i}`, name: `${KINDS[k]} ${i}`, kind: KINDS[k] };
  });
  const links = Array.from({ length: n }, () => ({ source: nodes[Math.floor(Math.random() * n)].id, target: nodes[Math.floor(Math.random() * n)].id }));
  return { nodes, links };
}

export function useSceneSetup(): Galaxy {
  const [galaxy] = useState(fakeGalaxy);
  useEffect(() => runWorldSimulator(), []);
  return galaxy;
}

/** Deterministic node index for a name (so the same entity always flares in the same spot). */
export function nodeIndex(g: Galaxy, name: string): number {
  const i = g.nodes.findIndex((n) => n.name.toLowerCase() === name.toLowerCase());
  if (i >= 0) return i;
  let h = 7;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % g.nodes.length;
}
