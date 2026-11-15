import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.CABIN_KIT_PORT ?? "4310";

export default defineConfig({
  root: "src/web",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});
