import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import budgets from "./budgets.json" with { type: "json" };

const apiPort = process.env.CABIN_KIT_PORT ?? "4310";

export default defineConfig({
  root: "src/web",
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: false,
    // the scene chunk's raw-size budget (budgets.json, which tools/check-budgets.ts asserts): a larger chunk warns here too
    chunkSizeWarningLimit: budgets.bundle.sceneJsRawKb,
  },
  server: {
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});
