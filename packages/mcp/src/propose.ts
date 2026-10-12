/**
 * `propose_policy` (ADR 0082): turns a rule expression into a reviewable diff of `castra.config.ts`. Pure: it reads the
 * config source it is given and returns text. Nothing is written and the running engine is never touched.
 */
import {
  ApiError,
  authenticated,
  createPolicyEngine,
  defineConfig,
  isPublic,
  owner,
  role,
  type CastraConfig,
  type Operation,
  type Rule,
  type SchemaSnapshot,
} from "@castra-kit/core";

/** The builders a proposal may use. `.where` and `custom` need code, so they are left to the developer. */
const BUILDERS = { isPublic, authenticated, role, owner } as const;
type Builder = keyof typeof BUILDERS;

interface Node {
  fn: Builder | "and" | "or";
  args: (string | Node)[];
}

const bad = (detail: string) => new ApiError(400, "invalid_rule", detail);

/**
 * Parses `role("admin").or(owner("author_id"))` and the like. Only the four builders, `.and(...)` / `.or(...)` and
 * double- or single-quoted string literals are accepted. The text is parsed, never evaluated.
 */
export function parseRuleExpression(text: string): Node {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const ident = () => {
    ws();
    const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (!m) throw bad(`expected a rule builder at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const expect = (ch: string) => {
    ws();
    if (text[i] !== ch) throw bad(`expected "${ch}" at ${i}`);
    i++;
  };
  const str = (): string => {
    ws();
    const q = text[i];
    if (q !== '"' && q !== "'") throw bad(`expected a string at ${i}`);
    const end = text.indexOf(q, i + 1);
    const value = end < 0 ? "" : text.slice(i + 1, end);
    if (end < 0 || /[\\\n]/.test(value)) throw bad(`unterminated or escaped string at ${i}`);
    i = end + 1;
    return value;
  };
  const args = (each: () => string | Node): (string | Node)[] => {
    expect("(");
    const out: (string | Node)[] = [];
    ws();
    if (text[i] === ")") return i++, out;
    for (;;) {
      out.push(each());
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      expect(")");
      return out;
    }
  };
  const expr = (depth: number): Node => {
    if (depth > 32) throw bad("rule is nested too deeply");
    const name = ident();
    if (!(name in BUILDERS)) throw bad(`"${name}" is not allowed; use ${Object.keys(BUILDERS).join(", ")}, .and(), .or()`);
    let node: Node = { fn: name as Builder, args: args(str) };
    for (;;) {
      ws();
      if (text[i] !== ".") return node;
      i++;
      const method = ident();
      if (method !== "and" && method !== "or") throw bad(`".${method}()" is not allowed; .where() and custom() need code, add them by hand`);
      const [other, ...rest] = args(() => expr(depth + 1));
      if (!other || rest.length > 0 || typeof other === "string") throw bad(`.${method}() takes one rule`);
      node = { fn: method, args: [node, other] };
    }
  };
  const node = expr(0);
  ws();
  if (i !== text.length) throw bad(`unexpected text at ${i}`);
  return node;
}

function build(node: Node): Rule {
  if (node.fn === "and" || node.fn === "or") {
    const [a, b] = node.args as Node[];
    return node.fn === "and" ? build(a!).and(build(b!)) : build(a!).or(build(b!));
  }
  const strings = node.args as string[];
  if (node.fn === "isPublic" || node.fn === "authenticated") {
    if (strings.length > 0) throw bad(`${node.fn}() takes no arguments`);
    return BUILDERS[node.fn]();
  }
  if (node.fn === "owner") {
    if (strings.length !== 1) throw bad("owner() takes one column name");
    return owner(strings[0]!);
  }
  return role(...strings);
}

/** Canonical source of a parsed rule (what goes into the file). */
function print(node: Node): string {
  if (node.fn === "and" || node.fn === "or") return `${print(node.args[0] as Node)}.${node.fn}(${print(node.args[1] as Node)})`;
  return `${node.fn}(${(node.args as string[]).map((s) => JSON.stringify(s)).join(", ")})`;
}

function builders(node: Node, out = new Set<string>()): Set<string> {
  if (node.fn === "and" || node.fn === "or") for (const a of node.args) builders(a as Node, out);
  else out.add(node.fn);
  return out;
}

/** Index just past the string, comment or template starting at `i`, or `i` if none starts there. */
function skipLiteral(src: string, i: number): number {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") return src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
  if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) < 0 ? src.length : src.indexOf("*/", i + 2) + 2;
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  return i;
}

/** Index of the `}` closing the `{` at `open`. */
function closeOf(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const skipped = skipLiteral(src, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    if ("{([".includes(src[i]!)) depth++;
    else if ("})]".includes(src[i]!) && --depth === 0) return i;
  }
  throw bad("unbalanced braces in the config");
}

/** Top-level properties of the object literal `{...}` at `open`: key, start of the key, value range. */
function properties(src: string, open: number): { key: string; start: number; valueStart: number; valueEnd: number }[] {
  const close = closeOf(src, open);
  const out: { key: string; start: number; valueStart: number; valueEnd: number }[] = [];
  let i = open + 1;
  while (i < close) {
    const skipped = skipLiteral(src, i);
    if (/\s|,/.test(src[i]!) || (skipped !== i && src[i] === "/")) {
      i = skipped !== i ? skipped : i + 1;
      continue;
    }
    const m = /^(?:([A-Za-z_$][\w$]*)|"([^"\\]*)"|'([^'\\]*)')\s*:/.exec(src.slice(i));
    if (!m) throw bad(`cannot read the object at ${open} (spread or computed key?); edit it by hand`);
    const valueStart = i + m[0].length;
    let j = valueStart;
    let depth = 0;
    for (; j < close; j++) {
      const s = skipLiteral(src, j);
      if (s !== j) {
        j = s - 1;
        continue;
      }
      if ("{([".includes(src[j]!)) depth++;
      else if ("})]".includes(src[j]!)) depth--;
      else if (src[j] === "," && depth === 0) break;
    }
    out.push({ key: m[1] ?? m[2] ?? m[3]!, start: i, valueStart, valueEnd: j });
    i = j + 1;
  }
  return out;
}

function lineIndent(src: string, at: number): string {
  const lineStart = src.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(src.slice(lineStart))![0];
}

/** The edited source: `op` of `table` set to `rule` (or removed), plus any missing builder import. */
function edit(src: string, table: string, op: Operation, rule: string | null, needed: Set<string>): string {
  const tablesKey = /\btables\s*:\s*\{/.exec(src);
  if (!tablesKey) throw bad("no `tables: {` in the config; edit it by hand");
  const tablesOpen = tablesKey.index + tablesKey[0].length - 1;
  const entry = properties(src, tablesOpen).find((p) => p.key === table);
  let out: string;
  if (!entry) {
    if (rule === null) throw bad(`"${table}" has no policies to remove`);
    const indent = lineIndent(src, tablesOpen) + "  ";
    out = `${src.slice(0, tablesOpen + 1)}\n${indent}${table}: {\n${indent}  ${op}: ${rule},\n${indent}},${src.slice(tablesOpen + 1)}`;
  } else {
    const open = src.indexOf("{", entry.valueStart);
    if (open < 0 || open > entry.valueEnd || src.slice(entry.valueStart, open).trim() !== "") throw bad(`"${table}" is not an object literal; edit it by hand`);
    const prop = properties(src, open).find((p) => p.key === op);
    if (prop) {
      if (rule === null) {
        const lineStart = src.lastIndexOf("\n", prop.start - 1) + 1;
        const after = src[prop.valueEnd] === "," ? prop.valueEnd + 1 : prop.valueEnd;
        const lineEnd = src.indexOf("\n", after);
        const ownLine = src.slice(lineStart, prop.start).trim() === "" && src.slice(after, lineEnd).trim() === "";
        out = ownLine ? src.slice(0, lineStart) + src.slice(lineEnd + 1) : src.slice(0, prop.start) + src.slice(after);
      } else {
        out = `${src.slice(0, prop.valueStart)} ${rule}${src.slice(prop.valueEnd)}`;
      }
    } else {
      if (rule === null) throw bad(`"${table}" has no ${op} policy to remove`);
      const indent = lineIndent(src, open) + "  ";
      out = `${src.slice(0, open + 1)}\n${indent}${op}: ${rule},${src.slice(open + 1)}`;
    }
  }
  const imp = /import\s*\{([^}]*)\}\s*from\s*["']@castra-kit\/core["']/.exec(out);
  if (imp && needed.size > 0) {
    const names = imp[1]!.split(",").map((s) => s.trim()).filter(Boolean);
    const missing = [...needed].filter((n) => !names.includes(n));
    if (missing.length > 0) {
      const all = [...names, ...missing].sort((a, b) => a.replace(/^type /, "").localeCompare(b.replace(/^type /, "")));
      out = out.slice(0, imp.index) + imp[0].replace(imp[1]!, ` ${all.join(", ")} `) + out.slice(imp.index + imp[0].length);
    }
  }
  return out;
}

/** Minimal unified diff (LCS over lines, 3 lines of context). Config files are small. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { t: " " | "-" | "+"; line: string; ai: number; bi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ t: " ", line: a[i]!, ai: i++, bi: j++ });
    else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) ops.push({ t: "+", line: b[j]!, ai: i, bi: j++ });
    else ops.push({ t: "-", line: a[i]!, ai: i++, bi: j });
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (let k = 0; k < ops.length; ) {
    if (ops[k]!.t === " ") {
      k++;
      continue;
    }
    const start = Math.max(0, k - 3);
    let end = k;
    // Extend while changes are within 6 lines of each other.
    while (end < ops.length) {
      let next = end;
      while (next < ops.length && ops[next]!.t === " ") next++;
      if (next >= ops.length || next - end > 6) break;
      while (next < ops.length && ops[next]!.t !== " ") next++;
      end = next;
    }
    end = Math.min(ops.length, end + 3);
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((o) => o.t !== "+").length;
    const bCount = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${hunk[0]!.ai + (aCount ? 1 : 0)},${aCount} +${hunk[0]!.bi + (bCount ? 1 : 0)},${bCount} @@`);
    for (const o of hunk) out.push(o.t + o.line);
    k = end;
  }
  return out.join("\n") + "\n";
}

/** Input of {@link proposePolicy}. */
export interface ProposePolicyInput {
  table: string;
  op: Operation;
  /** Rule expression, or `null` to close the operation (remove its policy). */
  rule: string | null;
}

/**
 * Validates a proposed rule against the running config and snapshot (roles, owner columns, the table) and returns
 * the diff that would apply it to `source`. Never writes and never changes `config`.
 */
export function proposePolicy(
  input: ProposePolicyInput,
  current: { config: CastraConfig; snapshot: SchemaSnapshot; path: string; source: string },
): Record<string, unknown> {
  const { config, snapshot } = current;
  if (!snapshot.tables[input.table]) throw new ApiError(404, "not_found", `no table "${input.table}" in castra/schema.json`);
  const node = input.rule === null ? null : parseRuleExpression(input.rule);
  const tables = { ...config.tables };
  const table = { ...(tables[input.table] ?? {}) } as Record<string, unknown>;
  if (node) table[input.op] = build(node);
  else delete table[input.op];
  tables[input.table] = table as CastraConfig["tables"][string];
  try {
    createPolicyEngine({ config: defineConfig({ ...config, tables }), snapshot });
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
  const rule = node ? print(node) : null;
  const after = edit(current.source, input.table, input.op, rule, node ? builders(node) : new Set());
  const before = config.tables[input.table]?.[input.op];
  return {
    applied: false,
    path: current.path,
    table: input.table,
    op: input.op,
    before: before ? String(before) : null,
    after: node ? String(build(node)) : null,
    diff: unifiedDiff(current.path, current.source, after),
    next: "Review the diff, apply it by hand, add allow and deny tests for the rule, then run `castra test` and redeploy.",
  };
}
