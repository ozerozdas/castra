/** Package identifier. */
export const name = "create-castra";

export { main, USAGE, detectPackageManager, nextSteps, ownVersion, spawnCommand } from "./main.js";
export type { MainEnv, RunCommandFn } from "./main.js";
export {
  scaffold,
  validateProjectName,
  localPackageSpecs,
  rewritePackageJson,
  substituteName,
  destinationName,
  ScaffoldError,
  UsageError,
  CASTRA_PACKAGES,
  RENAMES,
  SUBSTITUTED_FILES,
  TEMPLATES,
  TEMPLATE_DIR,
  TEMPLATE_NAME,
} from "./scaffold.js";
export type { PackageManager, ScaffoldOptions, ScaffoldResult, TemplateName } from "./scaffold.js";
