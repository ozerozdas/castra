import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Run against core's sources so tests do not depend on a prior build of `castra`.
    alias: { castra: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
});
