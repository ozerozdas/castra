import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every problem `type` Castra can emit must have a page at castra.mehmetozer.dev/problems/<code> (ADR 0067).
// The pages are built from site/problems.json; this test fails when a new code is added without one.

const repo = join(import.meta.dirname, "../../../..");
const catalogue = JSON.parse(readFileSync(join(repo, "site/problems.json"), "utf8")) as Record<string, { status: number }>;

// `hidden_column` is always rendered as `unknown_column` (toProblem), so it never reaches a client.
const NEVER_EMITTED = new Set(["hidden_column"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

function emittedCodes(): Set<string> {
  const codes = new Set<string>();
  const files = ["core", "mcp", "auth"].flatMap((p) => sources(join(repo, "packages", p, "src")));
  // ponytail: regex over call sites, not a TS AST; a code built at runtime would slip past it.
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\(\s*(?:\d{3}|status)\s*,\s*"([a-z][a-z_]+)"/g)) codes.add(m[1]!);
    for (const m of text.matchAll(/(?:problem|problemBody|problemResponse)\(\s*(?:\d{3}|[\w.]*status)\s*,[^;]*?,\s*"([a-z][a-z_]+)"/g)) codes.add(m[1]!);
    for (const m of text.matchAll(/bad\([^;]*?,\s*"([a-z][a-z_]+)"\)/g)) codes.add(m[1]!);
  }
  const union = readFileSync(join(repo, "packages/core/src/policy/errors.ts"), "utf8").match(/PolicyErrorCode =([\s\S]*?);/)![1]!;
  for (const m of union.matchAll(/\|\s*"([a-z_]+)"/g)) codes.add(m[1]!);
  for (const c of NEVER_EMITTED) codes.delete(c);
  return codes;
}

describe("problem type pages", () => {
  it("every emitted problem code has a page", () => {
    const missing = [...emittedCodes()].filter((c) => !(c in catalogue)).sort();
    expect(missing).toEqual([]);
  });

  it("the scan finds the codes it should (sanity check of the scanner)", () => {
    const codes = emittedCodes();
    for (const c of ["not_found", "invalid_cursor", "payload_too_large", "insufficient_scope", "unsafe_schema", "audit_failed", "invalid_include", "auth_error"]) {
      expect(codes).toContain(c);
    }
  });

  it("has no page for a code nothing emits", () => {
    const codes = emittedCodes();
    expect(Object.keys(catalogue).filter((c) => !codes.has(c)).sort()).toEqual([]);
  });
});
