import {
  apiModel,
  createPolicyEngine,
  executePlan,
  isReservedTable,
  notFound,
  parseRequest,
  planRequest,
  PolicyError,
  problemBody,
  toProblem,
  type CastraConfig,
  type CastraContext,
  type Explanation,
  type Operation,
  type PolicyEngine,
  type ProblemDetails,
  type SchemaSnapshot,
} from "castra";
import type { Kysely } from "kysely";
import { z } from "zod";
import { asSchema, describeIdentity, ToolDenied, type AsInput, type ToolAccess } from "./identity.js";
import type { ToolName } from "./scopes.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any>;

const OPERATIONS: readonly Operation[] = ["read", "create", "update", "delete"];
const OP_BY_METHOD: Record<string, (hasId: boolean) => Operation | undefined> = {
  GET: () => "read",
  POST: (hasId) => (hasId ? undefined : "create"),
  PATCH: (hasId) => (hasId ? "update" : undefined),
  DELETE: (hasId) => (hasId ? "delete" : undefined),
};

/** What the tools need: the same config, snapshot and engine the REST router uses. */
export interface CastraToolsOptions {
  config: CastraConfig;
  snapshot: SchemaSnapshot;
  /** Reuse the engine the REST router uses (recommended). Built from config + snapshot otherwise. */
  engine?: PolicyEngine;
  /** Kysely over the D1 binding. Used only for reads (`query_data`) and the `check_access` dry run. */
  db: AnyDb;
  /** REST base path that `path` arguments start with. Default `/api`. */
  basePath?: string;
}

/** Outcome of one tool call, independent of the MCP transport. */
export interface ToolOutcome {
  /** `ok`; `error` for a problem (4xx/5xx); `denied` when a token scope is missing. */
  outcome: "ok" | "error" | "denied";
  /** HTTP-style status (200 for success, the problem status otherwise). */
  status: number;
  /** JSON result (tool-specific), or `{ status, body: problem }` for `query_data` / a problem body. */
  data: Record<string, unknown>;
}

/** One shared tool definition (ADR 0060): the stdio and the remote server register exactly these. */
export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  run(args: Record<string, unknown>, access: ToolAccess): Promise<ToolOutcome>;
}

const queryInput = z
  .union([z.string().max(8192), z.record(z.string(), z.union([z.string(), z.array(z.string()).max(100)]))])
  .optional()
  .describe('Query parameters: "status=eq.draft&sort=-created_at" or { "status": "eq.draft" }.');

/** True for a JSON object (`{...}` from `JSON.parse`), not an array, `null` or a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Candidate row for `check_access`. Validated as a plain object but passed through UNCHANGED: a zod
 * record/object parse copies keys into a new object, where an own `"__proto__"` key from `JSON.parse`
 * becomes the prototype and disappears. The engine must see exactly the keys REST would see.
 */
const rowInput = z
  .unknown()
  .refine((v) => v === undefined || isPlainObject(v), { message: "row must be a JSON object" })
  .optional()
  .meta({ type: "object" })
  .describe("Candidate row (create: the input; update: the row after the update).");

const pathInput = z
  .string()
  .min(1)
  .max(2048)
  .describe('REST path, e.g. "/api/posts" or "/api/posts/<id>" (a query string is allowed).');

/** Splits a REST path into table, id and query, exactly as the router's `/:table/:id` would. */
export function parseRestPath(path: string, basePath: string, query: unknown): { table: string; id: string | undefined; query: URLSearchParams } {
  const q = path.indexOf("?");
  const pathname = q >= 0 ? path.slice(0, q) : path;
  const params = new URLSearchParams(q >= 0 ? path.slice(q + 1) : "");
  if (typeof query === "string") {
    for (const [k, v] of new URLSearchParams(query.startsWith("?") ? query.slice(1) : query)) params.append(k, v);
  } else if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query as Record<string, string | string[]>)) {
      for (const one of Array.isArray(v) ? v : [v]) params.append(k, one);
    }
  }
  const base = basePath.replace(/\/+$/, "");
  if (!pathname.startsWith(`${base}/`)) throw notFound();
  const segments = pathname.slice(base.length + 1).split("/");
  if (segments.length > 2 || segments.some((s) => s.length === 0)) throw notFound();
  let decoded: string[];
  try {
    decoded = segments.map((s) => decodeURIComponent(s));
  } catch {
    throw notFound();
  }
  return { table: decoded[0]!, id: decoded[1], query: params };
}

function problemOutcome(err: unknown): ToolOutcome {
  if (err instanceof ToolDenied) {
    return { outcome: "denied", status: 403, data: { ...problemBody(403, err.message, "insufficient_scope"), scope: err.scope } };
  }
  const p = toProblem(err);
  if (p.status >= 500) console.error("castra mcp: tool failed", err);
  return { outcome: "error", status: p.status, data: { ...p } };
}

function ok(data: Record<string, unknown>): ToolOutcome {
  return { outcome: "ok", status: 200, data };
}

/** A decision for a table × op that is not exposed: identical for unknown, closed and reserved tables. */
function notExposed(table: string, op: Operation): Explanation {
  return { table, op, allowed: false, matchedRule: "none", where: null, hiddenFields: [], reason: `${op} on "${table}" is not exposed` };
}

/**
 * Builds the four read-only tools. Every one goes through the policy engine; `explain_query` and
 * `query_data` go through the REST pipeline (`parseRequest → planRequest → executePlan`), so an
 * agent sees exactly what REST enforces (CLAUDE.md rule 7). No tool writes.
 */
export function castraTools(options: CastraToolsOptions): ToolDefinition[] {
  const { config, snapshot, db } = options;
  const engine = options.engine ?? createPolicyEngine({ config, snapshot });
  const basePath = options.basePath ?? "/api";
  const model = apiModel(config, snapshot);

  function describeSchema(only: string | undefined): ToolOutcome {
    const tables: Record<string, unknown> = {};
    for (const name of Object.keys(config.tables).sort()) {
      if (only !== undefined && name !== only) continue;
      if (isReservedTable(name)) continue;
      const open = OPERATIONS.filter((op) => engine.isOpen(name, op));
      const t = model.tables.get(name);
      if (open.length === 0 || !t) continue;
      const tc = config.tables[name]!;
      const visible = t.snapshot.columns.filter((c) => !t.hidden.has(c.name));
      const policies: Record<string, string | null> = {};
      for (const op of OPERATIONS) policies[op] = engine.isOpen(name, op) ? String(tc[op]) : null;
      tables[name] = {
        primaryKey: t.snapshot.primaryKey.filter((c) => !t.hidden.has(c)),
        columns: visible.map((c) => {
          const rules: Record<string, unknown> = {};
          if (t.readonly.has(c.name)) rules.readonly = true;
          if (t.server.has(c.name)) rules.setBy = "server";
          if (t.owner.has(c.name)) rules.owner = true;
          const vt = t.visibleTo.get(c.name);
          if (vt) rules.visibleTo = [...vt];
          return {
            name: c.name,
            type: c.type,
            affinity: c.affinity,
            notNull: c.notNull,
            primaryKey: c.primaryKeyPosition > 0,
            default: c.defaultValue,
            ...(Object.keys(rules).length > 0 ? { fields: rules } : {}),
          };
        }),
        policies,
        filterable: (tc.filterable ?? visible.map((c) => c.name)).filter((c) => !t.hidden.has(c)),
        relations: [...t.relations.values()]
          .filter((r) => {
            const target = model.tables.get(r.target);
            return engine.isOpen(r.target, "read") && target !== undefined && !t.hidden.has(r.localColumn) && !target.hidden.has(r.targetColumn);
          })
          .map((r) => ({ name: r.name, kind: r.kind, table: r.target, localColumn: r.localColumn, targetColumn: r.targetColumn })),
        ...(tc.selfColumn ? { selfColumn: tc.selfColumn } : {}),
      };
    }
    if (only !== undefined && !(only in tables)) throw notFound();
    return ok({ roles: [...config.roles], maxLimit: model.maxLimit, basePath, tables });
  }

  async function checkAccess(ctx: CastraContext, table: string, op: Operation, row: Record<string, unknown> | undefined): Promise<ToolOutcome> {
    const base = { table, op, as: describeIdentity(ctx), dryRun: true };
    if (!engine.isOpen(table, op)) return ok({ ...base, allowed: false, explanation: notExposed(table, op) });
    if (row === undefined) {
      let explanation: Explanation;
      if (op === "create") {
        const pk = snapshot.tables[table]!.primaryKey;
        const target = pk.length > 0 ? Object.fromEntries(pk.map((k) => [k, "<row>"])) : "last_insert_rowid";
        explanation = engine.writeGuard(table, "create", ctx, target).explanation;
        explanation = { ...explanation, hiddenFields: [...explanation.hiddenFields] };
      } else {
        explanation = engine.explain(engine.readFilter(table, op, ctx));
      }
      return ok({ ...base, allowed: explanation.allowed, explanation });
    }
    let candidate = row;
    if (op === "create") {
      try {
        candidate = engine.prepareWrite(table, "create", ctx, row).values;
      } catch (err) {
        if (!(err instanceof PolicyError)) throw err;
        return ok({ ...base, allowed: false, status: err.status, explanation: { ...err.explanation, reason: err.message } });
      }
    }
    const decision = await engine.checkRow(db, table, op, ctx, candidate);
    return ok({ ...base, allowed: decision.allowed, explanation: engine.explain(decision) });
  }

  function explainQuery(ctx: CastraContext, method: string, path: string, query: unknown, body: unknown): ToolOutcome {
    const m = method.toUpperCase();
    const target = parseRestPath(path, basePath, query);
    const op = OP_BY_METHOD[m]?.(target.id !== undefined);
    if (!op || !engine.isOpen(target.table, op)) throw notFound();
    const parsed = parseRequest({ method: m, table: target.table, id: target.id, query: target.query, body });
    const plan = planRequest(engine, snapshot, config, parsed, ctx);
    // The plan is never executed. JSON round trip drops the executable part (a symbol).
    return ok({ as: describeIdentity(ctx), executed: false, plan: JSON.parse(JSON.stringify(plan)) as unknown });
  }

  async function queryData(ctx: CastraContext, path: string, query: unknown): Promise<ToolOutcome> {
    try {
      const target = parseRestPath(path, basePath, query);
      if (!engine.isOpen(target.table, "read")) throw notFound();
      const parsed = parseRequest({ method: "GET", table: target.table, id: target.id, query: target.query });
      const plan = planRequest(engine, snapshot, config, parsed, ctx);
      // No D1 binding is passed: a write plan could not run even if one were built (fail closed).
      const result = await executePlan(db, plan, {});
      return { outcome: "ok", status: result.status, data: { status: result.status, body: result.body } };
    } catch (err) {
      if (err instanceof ToolDenied) throw err;
      const p: ProblemDetails = toProblem(err);
      if (p.status >= 500) console.error("castra mcp: query_data failed", err);
      return { outcome: "error", status: p.status, data: { status: p.status, body: p } };
    }
  }

  const guard =
    (fn: (args: Record<string, unknown>, access: ToolAccess) => Promise<ToolOutcome>) =>
    async (args: Record<string, unknown>, access: ToolAccess): Promise<ToolOutcome> => {
      try {
        return await fn(args, access);
      } catch (err) {
        return problemOutcome(err);
      }
    };

  return [
    {
      name: "describe_schema",
      title: "Describe schema",
      description:
        "Exposed tables only: columns (hidden columns omitted), field rules, relations usable in ?include=, and the policy rule of each operation (null = closed). Auth and internal tables are never listed.",
      inputSchema: { table: z.string().min(1).max(256).optional().describe("Limit the answer to one table.") },
      run: guard(async (args, access) => {
        await access.authorize("describe_schema", undefined);
        return describeSchema(args.table as string | undefined);
      }),
    },
    {
      name: "check_access",
      title: "Check access (dry run)",
      description:
        "Dry run of a policy decision for an identity × table × operation, optionally against a candidate row. Returns the decision and its explanation (matched rule, compiled WHERE SQL + parameters, hidden fields). Never writes; with a row, the check is approximate (the guarded write decides).",
      inputSchema: {
        table: z.string().min(1).max(256),
        op: z.enum(["read", "create", "update", "delete"]),
        as: asSchema.optional(),
        row: rowInput,
      },
      run: guard(async (args, access) => {
        const ctx = await access.authorize("check_access", args.as as AsInput | undefined);
        return checkAccess(ctx, args.table as string, args.op as Operation, args.row as Record<string, unknown> | undefined);
      }),
    },
    {
      name: "explain_query",
      title: "Explain a REST request",
      description:
        "Parses and plans a REST request exactly like the API (same parser, planner and policies) and returns the plan: every SQL statement with parameters and the policy explanations. Never executes, also for POST/PATCH/DELETE.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PATCH", "DELETE", "get", "post", "patch", "delete"]),
        path: pathInput,
        query: queryInput,
        body: z.unknown().optional().describe("JSON body for POST/PATCH."),
        as: asSchema.optional(),
      },
      run: guard(async (args, access) => {
        const ctx = await access.authorize("explain_query", args.as as AsInput | undefined);
        return explainQuery(ctx, args.method as string, args.path as string, args.query, args.body);
      }),
    },
    {
      name: "query_data",
      title: "Query data (GET only)",
      description:
        "Runs a GET through the REST pipeline as the given identity and returns { status, body } exactly as the REST API would (errors are problem+json bodies).",
      inputSchema: { path: pathInput, query: queryInput, as: asSchema.optional() },
      run: guard(async (args, access) => {
        const ctx = await access.authorize("query_data", args.as as AsInput | undefined);
        return queryData(ctx, args.path as string, args.query);
      }),
    },
  ];
}
