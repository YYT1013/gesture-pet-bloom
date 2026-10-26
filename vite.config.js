import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    assetsDir: "bundles",
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "index.html"),
        analytics: resolve(process.cwd(), "analytics.html"),
      },
    },
  },
});
