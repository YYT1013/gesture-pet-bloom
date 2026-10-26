/* Copy runtime assets after Vite has closed its own worker.
 * Keeping this as a separate process avoids Windows file-lock issues while
 * Vite is still flushing large model files. */

import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const outDir = resolve(process.cwd(), "dist");
await mkdir(outDir, { recursive: true });

for (const dir of ["assets", "models", "lib"]) {
  await cp(resolve(process.cwd(), dir), resolve(outDir, dir), {
    recursive: true,
    force: true,
  });
}

console.log("Copied assets/, models/, and lib/ into dist/.");
