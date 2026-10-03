// After `vite build -c vite.lib.config.ts && tsc -p tsconfig.lib.json`:
//  1. make `import { AgentScene } from "agentglow"` pull in dist/style.css automatically;
//  2. keep only the public declaration files (scene internals are not API);
//  3. `agentglow/pulse` (dist/pulse.js) stays free of React / three.js / CSS.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const dist = (p) => new URL(`../dist/${p}`, import.meta.url);
if (!existsSync(dist("style.css"))) throw new Error("dist/style.css missing");
//  ("use client" first, so Next.js App Router users can import <AgentScene/> from a server component)
const js = readFileSync(dist("index.js"), "utf8").replace(/^"use client";\n/, "").replace(/^import "\.\/style\.css";\n/, "");
writeFileSync(dist("index.js"), `"use client";\nimport "./style.css";\n${js}`);

const world = readFileSync(dist("types/scenes/shared/world.d.ts"), "utf8");
rmSync(dist("types/scenes"), { recursive: true, force: true });
writeFileSync(dist("types/world.d.ts"), world);
writeFileSync(dist("types/index.d.ts"), readFileSync(dist("types/index.d.ts"), "utf8").replace("./scenes/shared/world", "./world"));
for (const f of ["index.d.ts", "AgentScene.d.ts", "themes.d.ts", "world.d.ts", "pulse.d.ts"]) if (!existsSync(dist(`types/${f}`))) throw new Error(`missing types/${f}`);
if (/from\s*["'](react|three|@react-three)|style\.css/.test(readFileSync(dist("pulse.js"), "utf8"))) throw new Error("dist/pulse.js must not import React / three / CSS");
