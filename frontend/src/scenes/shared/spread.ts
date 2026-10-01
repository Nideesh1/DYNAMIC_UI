/**
 * Seeded placement helpers so agents don't land on the exact same coordinates every run.
 *   - per-run variation:   seed with `hash01(run.id, salt)`
 *   - per-agent variation: seed with `hash01(inst.id, salt)` (see `jit`)
 *   - same-role agents in one run: `spreadIndex` hands out a stable, lowest-free index per (run, group)
 * Everything is deterministic per id, so a position stays put for the agent's whole lifetime.
 */
import { hash01, world, type AgentType, type Instance } from "./world";

/** Subagents (scouts of any flavour, incl. the catch-all data_scout) fan out around their parent. */
export const isSubRole = (t: AgentType) => t === "graph_scout" || t === "records_scout" || t === "data_scout";

/** Seeded jitter in -0.5..0.5 for an id (stable per id + salt). */
export const jit = (id: string, salt: number) => hash01(id, salt) - 0.5;

/** 0, +1, -1, +2, -2, … - spreads a growing set symmetrically around a centre without knowing the final count. */
export const alt = (k: number) => (k === 0 ? 0 : k % 2 ? (k + 1) / 2 : -k / 2);

const groups = new Map<string, Map<string, number>>();

/**
 * Stable index of `inst` among living instances of the same run in `group` (lowest free index on first call,
 * then cached for its lifetime). Call with a constant group string (no per-frame string building).
 */
export function spreadIndex(inst: Instance, group: string): number {
  let g = groups.get(group);
  if (!g) groups.set(group, (g = new Map()));
  const have = g.get(inst.id);
  if (have !== undefined) return have;
  for (const id of g.keys()) if (!world.instances.has(id)) g.delete(id);
  let k = 0;
  for (let taken = true; taken; ) {
    taken = false;
    for (const [id, kk] of g)
      if (kk === k && world.instances.get(id)?.run === inst.run) {
        taken = true;
        k++;
        break;
      }
  }
  g.set(inst.id, k);
  return k;
}

/** spreadIndex grouped by the agent's role (subagents of any flavour share one group). */
const ROLE_GROUP: Record<AgentType, string> = {
  planner: "planner",
  researcher: "researcher",
  writer: "writer",
  graph_scout: "sub",
  records_scout: "sub",
  data_scout: "sub",
};
export const roleIndex = (inst: Instance) => spreadIndex(inst, ROLE_GROUP[inst.type]);
