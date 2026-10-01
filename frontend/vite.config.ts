import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { dedupe: ["react", "react-dom", "zod"] },
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8000",
      "/obs": { target: "http://localhost:8100", rewrite: (p) => p.replace(/^\/obs/, "") },
    },
  },
});
