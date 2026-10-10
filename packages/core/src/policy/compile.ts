import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
  type Expression,
  type ExpressionBuilder,
  type SqlBool,
} from "kysely";
import type { CastraContext } from "../types.js";
import { describeRule, type RuleNode } from "./rules.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEB = ExpressionBuilder<any, any>;

/**
 * Result of partially evaluating a rule against a context: either a constant decision, or a
 * residual row predicate that still has to run in SQL.
 */
export type Residual =
  | { readonly kind: "const"; readonly value: boolean }
  | { readonly kind: "expr"; readonly label: string; readonly build: (eb: AnyEB) => Expression<SqlBool> };

const TRUE: Residual = Object.freeze({ kind: "const", value: true });
const FALSE: Residual = Object.freeze({ kind: "const", value: false });

/** True when the context carries an authenticated user with a usable id. */
export function hasUser(ctx: CastraContext): ctx is CastraContext & { user: { id: string } } {
  return ctx.user !== null && typeof ctx.user === "object" && typeof ctx.user.id === "string" && ctx.user.id.length > 0;
}

/** Roles that count for this context. Anonymous callers never hold roles, whatever `ctx.roles` says. */
export function effectiveRoles(ctx: CastraContext): readonly string[] {
  if (!hasUser(ctx) || !Array.isArray(ctx.roles)) return [];
  return ctx.roles.filter((r): r is string => typeof r === "string");
}

function assertExpression(value: unknown, source: string): Expression<SqlBool> {
  if (typeof value !== "object" || value === null || typeof (value as { toOperationNode?: unknown }).toOperationNode !== "function") {
    throw new TypeError(`${source} must return a Kysely expression`);
  }
  return value as Expression<SqlBool>;
}

/**
 * Partially evaluates `node` for `ctx`. Context-only rules (`public`, `authenticated`, `role`) become
 * constants; row rules (`owner`, `where`, `custom`) become SQL builders. `and`/`or` are constant-folded.
 *
 * `owner(col)` references the column qualified with the base table name (`"table"."col"`) so the
 * fragment stays unambiguous when the API layer joins other tables. The base table must therefore be
 * addressable by its own name (not aliased) in the query the filter is applied to.
 */
export function partialEvaluate(node: RuleNode, ctx: CastraContext, table: string): Residual {
  switch (node.kind) {
    case "public":
      return TRUE;
    case "authenticated":
      return hasUser(ctx) ? TRUE : FALSE;
    case "role": {
      const roles = effectiveRoles(ctx);
      return node.roles.some((r) => roles.includes(r)) ? TRUE : FALSE;
    }
    case "owner": {
      if (!hasUser(ctx)) return FALSE;
      const userId = ctx.user.id;
      const ref = `${table}.${node.column}`;
      return { kind: "expr", label: describeRule(node), build: (eb) => eb(eb.ref(ref), "=", userId) };
    }
    case "custom": {
      const { fn, name } = node;
      return { kind: "expr", label: describeRule(node), build: (eb) => assertExpression(fn(eb, ctx), `custom("${name}")`) };
    }
    case "where": {
      const { fn } = node;
      return { kind: "expr", label: "where", build: (eb) => assertExpression(fn({ eb, ctx }), "where()") };
    }
    case "and":
    case "or": {
      const isAnd = node.kind === "and";
      const parts: Extract<Residual, { kind: "expr" }>[] = [];
      for (const child of node.children) {
        const r = partialEvaluate(child, ctx, table);
        if (r.kind === "const") {
          if (r.value !== isAnd) return isAnd ? FALSE : TRUE; // false in and / true in or decides
          continue; // neutral element
        }
        parts.push(r);
      }
      if (parts.length === 0) return isAnd ? TRUE : FALSE;
      if (parts.length === 1) return parts[0]!;
      return {
        kind: "expr",
        label: `${node.kind}(${parts.map((p) => p.label).join(", ")})`,
        build: (eb) => {
          const exprs = parts.map((p) => p.build(eb));
          return isAnd ? eb.and(exprs) : eb.or(exprs);
        },
      };
    }
  }
}

/** The SQL fragment for a residual. Constants compile to `1 = 1` / `1 = 0`. */
export function residualToExpression(residual: Residual, eb: AnyEB): Expression<SqlBool> {
  if (residual.kind === "const") return residual.value ? sql<SqlBool>`1 = 1` : sql<SqlBool>`1 = 0`;
  return residual.build(eb);
}

/** Human-readable form of a residual. */
export function describeResidual(residual: Residual): string {
  return residual.kind === "const" ? String(residual.value) : residual.label;
}

let compileOnly: Kysely<unknown> | undefined;

/** A Kysely instance that can only compile (SQLite dialect, no driver). Used for explanations. */
export function compileOnlyDb(): Kysely<unknown> {
  compileOnly ??= new Kysely<unknown>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
  return compileOnly;
}

/** Compiles a boolean expression to SQLite SQL with `?` placeholders. */
export function compileExpression(expr: Expression<SqlBool>): { sql: string; parameters: unknown[] } {
  const compiled = sql`${expr}`.compile(compileOnlyDb());
  return { sql: compiled.sql, parameters: [...compiled.parameters] };
}
