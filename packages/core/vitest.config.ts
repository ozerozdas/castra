import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects:
// - "unit": plain Node, everything except `*.d1.test.ts`.
// - "d1": runs `*.d1.test.ts` inside workerd with a real local D1 binding `DB`, so compiled policy
//   SQL is executed by the same SQLite engine that runs in production.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.d1.test.ts"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: "2026-10-01",
              compatibilityFlags: ["nodejs_compat"],
              d1Databases: ["DB"],
            },
          }),
        ],
        test: {
          name: "d1",
          // D1 property tests run hundreds of real queries; the 5s default flakes under parallel load.
          testTimeout: 60_000,
          include: ["test/**/*.d1.test.ts"],
        },
      },
    ],
  },
});
