import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package managers the scaffolder knows how to install with. */
export type PackageManager = "pnpm" | "npm";

/** Templates shipped in `template/` (one for v0.1, ADR 0035). */
export const TEMPLATES = ["default"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** Directory holding the template files (next to `src/` and `dist/`). */
export const TEMPLATE_DIR = fileURLToPath(new URL("../template/", import.meta.url));

/** Name used inside the template; replaced by the project name in {@link SUBSTITUTED_FILES}. */
export const TEMPLATE_NAME = "castra-app";

/** Files whose `castra-app` occurrences are replaced with the project name. */
export const SUBSTITUTED_FILES = ["package.json", "wrangler.jsonc", "README.md"] as const;

/**
 * Template files stored under another name because npm drops `.gitignore` from published packages
 * (and dotfiles are easy to lose in other tooling). Renamed on copy.
 */
export const RENAMES: Readonly<Record<string, string>> = {
  _gitignore: ".gitignore",
  "_dev.vars.example": ".dev.vars.example",
};

/** Never copied out of the template directory (local state from running the template's own tests). */
const SKIP = new Set(["node_modules", ".wrangler", "dist", ".dev.vars", ".DS_Store"]);

/** Castra packages in the generated `package.json` and their directory in the Castra repository. */
export const CASTRA_PACKAGES: Readonly<Record<string, string>> = {
  castra: "packages/core",
  "@castra-kit/auth": "packages/auth",
  "@castra-kit/mcp": "packages/mcp",
  "@castra-kit/cli": "packages/cli",
};

/** A usage or input problem: printed with the usage text, exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** A runtime problem (target exists, bad repo path): exit code 1. */
export class ScaffoldError extends Error {
  override name = "ScaffoldError";
}

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validates a project name as a Cloudflare Worker name: lowercase letters, digits and dashes, no leading or
 * trailing dash, at most 63 characters. The name is also the directory name, the Worker name and the D1
 * database name prefix (`<name>-db`).
 *
 * @returns an error message, or `null` when the name is valid.
 */
export function validateProjectName(name: string): string | null {
  if (name.length === 0) return "The project name is empty.";
  if (name.length > 63) return `"${name}" is ${name.length} characters; Worker names are at most 63.`;
  if (!WORKER_NAME.test(name)) {
    return `"${name}" is not a valid Worker name: use lowercase letters, digits and dashes, not starting or ending with a dash.`;
  }
  return null;
}

/** Options of {@link scaffold}. */
export interface ScaffoldOptions {
  /** Project name (validated with {@link validateProjectName}). */
  name: string;
  /** Directory to create; must not exist or be empty. */
  targetDir: string;
  /** Template to copy. Default `default`. */
  template?: TemplateName;
  /** Package manager the project will be installed with; picks the local-packages protocol. */
  packageManager: PackageManager;
  /** Version written for the Castra packages (the scaffolder's own version). */
  castraVersion: string;
  /**
   * Path to a Castra repository checkout. Castra dependencies become `link:` (pnpm) or `file:` (npm) paths into
   * its `packages/*` instead of registry versions (ADR 0036).
   */
  localPackages?: string;
  /** Template directory override (tests). */
  templateDir?: string;
}

/** What {@link scaffold} did. */
export interface ScaffoldResult {
  targetDir: string;
  /** Written files, relative to the target, sorted. */
  files: string[];
  /** Castra dependency specifiers written into package.json. */
  castraDependencies: Record<string, string>;
  /** Non-fatal notes (e.g. local packages not built yet). */
  warnings: string[];
}

async function isNonEmptyDir(path: string): Promise<boolean> {
  let info;
  try {
    info = await stat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (!info.isDirectory()) throw new ScaffoldError(`${path} exists and is not a directory.`);
  return (await readdir(path)).length > 0;
}

async function listTemplate(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listTemplate(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Destination path of a template file (applies {@link RENAMES} to top-level files). */
export function destinationName(rel: string): string {
  return RENAMES[rel] ?? rel;
}

/**
 * Resolves `castra`/`@castra-kit/*` dependency specifiers for a local Castra checkout.
 * Throws {@link ScaffoldError} when the path is not a Castra repository.
 */
export async function localPackageSpecs(
  repo: string,
  packageManager: PackageManager,
): Promise<{ specs: Record<string, string>; warnings: string[] }> {
  const root = resolve(repo);
  const protocol = packageManager === "pnpm" ? "link:" : "file:";
  const specs: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [pkg, rel] of Object.entries(CASTRA_PACKAGES)) {
    const dir = join(root, rel);
    let manifest: { name?: string };
    try {
      manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string };
    } catch {
      throw new ScaffoldError(`--local-packages ${repo}: ${join(rel, "package.json")} not found; expected a Castra repository checkout.`);
    }
    if (manifest.name !== pkg) {
      throw new ScaffoldError(`--local-packages ${repo}: ${rel} is "${manifest.name}", expected "${pkg}".`);
    }
    if (!existsSync(join(dir, "dist"))) warnings.push(`${pkg} is not built (${join(dir, "dist")} missing); run \`pnpm -r build\` in ${root}.`);
    specs[pkg] = `${protocol}${dir}`;
  }
  return { specs, warnings };
}

/** Rewrites the generated package.json: project name and Castra dependency specifiers. */
export function rewritePackageJson(text: string, name: string, castraDeps: Record<string, string>): string {
  const pkg = JSON.parse(text) as { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  pkg.name = name;
  for (const section of [pkg.dependencies, pkg.devDependencies]) {
    if (!section) continue;
    for (const dep of Object.keys(section)) if (dep in castraDeps) section[dep] = castraDeps[dep]!;
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Replaces the template name in wrangler.jsonc (`name`, `database_name`) and README.md. */
export function substituteName(text: string, name: string): string {
  return text.replaceAll(TEMPLATE_NAME, name);
}

/**
 * Copies the template into `targetDir` and personalises it. Refuses a non-empty target. Does not install.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const nameError = validateProjectName(options.name);
  if (nameError) throw new UsageError(nameError);
  const template = options.template ?? "default";
  if (!(TEMPLATES as readonly string[]).includes(template)) {
    throw new UsageError(`Unknown template "${template}". Available: ${TEMPLATES.join(", ")}.`);
  }
  const targetDir = resolve(options.targetDir);
  if (await isNonEmptyDir(targetDir)) throw new ScaffoldError(`${targetDir} is not empty. Choose another name or remove it.`);

  let castraDependencies: Record<string, string> = Object.fromEntries(
    Object.keys(CASTRA_PACKAGES).map((pkg) => [pkg, options.castraVersion]),
  );
  const warnings: string[] = [];
  if (options.localPackages !== undefined) {
    const local = await localPackageSpecs(options.localPackages, options.packageManager);
    castraDependencies = local.specs;
    warnings.push(...local.warnings);
  }

  const source = options.templateDir ?? TEMPLATE_DIR;
  const files = await listTemplate(source);
  const written: string[] = [];
  await mkdir(targetDir, { recursive: true });
  for (const rel of files) {
    const dest = destinationName(rel);
    const to = join(targetDir, dest);
    await mkdir(join(to, ".."), { recursive: true });
    if (dest === "package.json") {
      await writeFile(to, rewritePackageJson(await readFile(join(source, rel), "utf8"), options.name, castraDependencies));
    } else if ((SUBSTITUTED_FILES as readonly string[]).includes(dest)) {
      await writeFile(to, substituteName(await readFile(join(source, rel), "utf8"), options.name));
    } else {
      await copyFile(join(source, rel), to);
    }
    written.push(dest);
  }
  return { targetDir, files: written.sort(), castraDependencies, warnings };
}
