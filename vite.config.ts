import { defineConfig } from "vite";
export default defineConfig({
  root: "src/web",
  build: { outDir: "../../dist", emptyOutDir: true },
  worker: { format: "es" },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/auth": "http://127.0.0.1:3000",
    },
  },
});
