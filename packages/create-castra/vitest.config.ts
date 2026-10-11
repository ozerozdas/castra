import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Node-side tests of the scaffolder. template/ has its own Workers-runtime config (`pnpm test:template`).
export default defineConfig({
  resolve: {
    // Run against core's and the CLI's sources so tests do not depend on a prior build of them.
    alias: {
      castra: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@castra/cli": fileURLToPath(new URL("../cli/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "template/**"],
  },
});
