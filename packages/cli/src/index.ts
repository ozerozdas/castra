/** Package identifier (placeholder until real exports land). */
export const name = "@castra/cli";

export { run } from "./run.js";
export type { RunEnv } from "./run.js";
export { generate } from "./commands/generate.js";
export type { GenerateDeps, GenerateOptions } from "./commands/generate.js";
export { readD1Target } from "./wrangler-config.js";
export type { D1Target } from "./wrangler-config.js";
export type { OpenDatabase, OpenDatabaseFn } from "./local-d1.js";
