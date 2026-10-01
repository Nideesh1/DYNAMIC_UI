/**
 * Validates OpenUI Lang strings (home dashboard + prompt examples) against the library:
 * no unknown components, no missing required props, no unresolved refs.
 * Run: npm run validate
 */
import { createParser } from "@openuidev/react-lang";
import { homeDashboard } from "../src/home";
import { library } from "../src/library";
import { examples } from "../src/prompt-examples";

const parser = createParser(library.toJSONSchema(), "Stack");
const cases: [string, string][] = [
  ["home", homeDashboard(20260930)],
  ...examples.map((e, i): [string, string] => [`example${i + 1}`, e.split("\n\n").slice(1).join("\n\n")]),
];

let failed = false;
for (const [name, src] of cases) {
  const r = parser.parse(src);
  const { errors, unresolved, orphaned, incomplete, statementCount } = r.meta;
  const ok = r.root && !errors.length && !unresolved.length && !orphaned.length && !incomplete;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${name}: root=${r.root?.typeName} statements=${statementCount} queries=${r.queryStatements.length}`,
  );
  if (!ok) {
    failed = true;
    console.log(JSON.stringify({ errors, unresolved, orphaned, incomplete }, null, 2));
  }
}
process.exit(failed ? 1 : 0);
