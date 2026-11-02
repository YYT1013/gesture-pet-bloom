import { resolve } from "node:path";
import { defineConfig } from "vite";

// GitHub Pages project pages deploy below /<repository>/.
const basePath = process.env.VITE_BASE_PATH?.trim() || "/";

export default defineConfig({
  base: basePath.endsWith("/") ? basePath : `${basePath}/`,
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
