import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";

/** Options of one {@link ExecFn} call. */
export interface ExecOptions {
  cwd: string;
  /** Extra environment variables, merged over `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Written to the child's stdin, then stdin is closed. Secrets travel this way so they never appear in argv
   * (visible in `ps`) or on disk.
   */
  input?: string;
  /** Echo the child's stdout/stderr to the terminal while capturing it. Default true. */
  echo?: boolean;
}

/** Result of an {@link ExecFn} call. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run an external program. Injected into commands so tests never spawn wrangler. */
export type ExecFn = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

/**
 * Default {@link ExecFn}: `child_process.spawn` without a shell, with `<cwd>/node_modules/.bin` prepended to
 * `PATH` so the project's own wrangler is used. stdin is always a pipe, which also makes wrangler treat the run
 * as non-interactive (no confirmation prompts).
 */
export const spawnExec: ExecFn = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const env = { ...process.env, ...options.env };
    env.PATH = [join(options.cwd, "node_modules", ".bin"), env.PATH ?? ""].join(delimiter);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    const echo = options.echo ?? true;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (echo) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (echo) process.stderr.write(chunk);
    });
    child.on("error", reject);
    // A child may exit before reading its stdin (EPIPE / ERR_STREAM_DESTROYED). That is not a failure of ours:
    // the child's exit code (from "close") is the result, so the stdin error is swallowed instead of crashing.
    child.stdin.on("error", () => {});
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
