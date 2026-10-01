/** App build: gallery + full-screen scenes, written into the Python package (served at / by `agentglow serve`). */
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const target = process.env.AGENTGLOW_URL ?? "http://localhost:8100";

export default defineConfig({
  base: "/",
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../backend/agentglow/static", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  // dev: same-origin /live/* → agentglow server
  server: { proxy: { "/live": { target, changeOrigin: true } } },
});
