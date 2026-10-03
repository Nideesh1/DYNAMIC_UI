/** Library build: `agentglow` → dist/ (ESM, one lazy chunk per theme, dist/style.css) + `agentglow/pulse` → dist/pulse.js. */
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const external = [/^react($|\/)/, /^react-dom($|\/)/, /^three($|\/)/, /^@react-three\//, /^postprocessing($|\/)/];

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: { index: fileURLToPath(new URL("src/index.ts", import.meta.url)), pulse: fileURLToPath(new URL("src/pulse.ts", import.meta.url)) },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: "style",
    },
    rollupOptions: {
      external: (id) => external.some((re) => re.test(id)),
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
