/**
 * Test oracle: a reference JavaScript evaluator for rule trees, written independently of the
 * compiler. It is NEVER used at runtime (rules always compile to SQL); it exists so property tests
 * can compare SQL results with an obviously-correct model. Uses SQL three-valued logic.
 */
import fc from "fast-check";
import { authenticated, isPublic, owner, role, type CastraContext, type Rule } from "../../src/index.js";

export type Cmp = "=" | "<>" | "<" | ">" | "<=" | ">=";
export type ItemRow = { id: number; owner_id: string | null; status: string | null; category: string | null; score: number | null };
type TextCol = "owner_id" | "status" | "category";

export type Spec =
  | { k: "public" }
  | { k: "authenticated" }
  | { k: "role"; roles: string[] }
  | { k: "owner"; col: TextCol }
  | { k: "where"; base: Spec; col: "status" | "category"; op: Cmp; value: string }
  | { k: "whereNum"; base: Spec; op: Cmp; value: number }
  | { k: "and"; a: Spec; b: Spec }
  | { k: "or"; a: Spec; b: Spec };

export const USER_IDS = ["u1", "u2", "u3"];
export const ROLE_POOL = ["admin", "editor", "member"];
const WORDS = ["a", "b", "draft", "published", "B", ""];

/** Converts a spec into a Castra rule. */
export function toRule(s: Spec): Rule {
  switch (s.k) {
    case "public":
      return isPublic();
    case "authenticated":
      return authenticated();
    case "role":
      return role(...s.roles);
    case "owner":
      return owner(s.col);
    case "where":
      return toRule(s.base).where((q) => q.eb(s.col, s.op, s.value));
    case "whereNum":
      return toRule(s.base).where((q) => q.eb("score", s.op, s.value));
    case "and":
      return toRule(s.a).and(toRule(s.b));
    case "or":
      return toRule(s.a).or(toRule(s.b));
  }
}

type TV = boolean | null; // SQL three-valued logic: null = unknown

function cmp(a: string | number | null, op: Cmp, b: string | number): TV {
  if (a === null) return null;
  // Same-type operands only (the generators guarantee this), ASCII strings → BINARY collation = JS order.
  switch (op) {
    case "=":
      return a === b;
    case "<>":
      return a !== b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
  }
}

function and3(a: TV, b: TV): TV {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

function or3(a: TV, b: TV): TV {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

function hasUser(ctx: CastraContext): boolean {
  return ctx.user !== null && typeof ctx.user.id === "string" && ctx.user.id !== "";
}

/** Reference semantics of a rule for a context and a row. */
export function evaluate(s: Spec, ctx: CastraContext, row: ItemRow): TV {
  switch (s.k) {
    case "public":
      return true;
    case "authenticated":
      return hasUser(ctx);
    case "role":
      // Anonymous callers never hold roles (ADR 0005).
      return hasUser(ctx) && s.roles.some((r) => ctx.roles.includes(r));
    case "owner":
      if (!hasUser(ctx)) return false;
      return cmp(row[s.col], "=", ctx.user!.id);
    case "where":
      return and3(evaluate(s.base, ctx, row), cmp(row[s.col], s.op, s.value));
    case "whereNum":
      return and3(evaluate(s.base, ctx, row), cmp(row.score, s.op, s.value));
    case "and":
      return and3(evaluate(s.a, ctx, row), evaluate(s.b, ctx, row));
    case "or":
      return or3(evaluate(s.a, ctx, row), evaluate(s.b, ctx, row));
  }
}

// ---------- fast-check arbitraries ----------

const cmpArb = fc.constantFrom<Cmp>("=", "<>", "<", ">", "<=", ">=");
const wordArb = fc.constantFrom(...WORDS);

export const specArb: fc.Arbitrary<Spec> = fc.letrec<{ spec: Spec }>((tie) => ({
  spec: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constant<Spec>({ k: "public" }),
    fc.constant<Spec>({ k: "authenticated" }),
    fc.uniqueArray(fc.constantFrom(...ROLE_POOL), { minLength: 1, maxLength: 3 }).map<Spec>((roles) => ({ k: "role", roles })),
    fc.constantFrom<TextCol>("owner_id", "status").map<Spec>((col) => ({ k: "owner", col })),
    fc
      .record({ base: tie("spec"), col: fc.constantFrom<"status" | "category">("status", "category"), op: cmpArb, value: wordArb })
      .map<Spec>((r) => ({ k: "where", ...r })),
    fc.record({ base: tie("spec"), op: cmpArb, value: fc.integer({ min: -3, max: 3 }) }).map<Spec>((r) => ({ k: "whereNum", ...r })),
    fc.record({ a: tie("spec"), b: tie("spec") }).map<Spec>((r) => ({ k: "and", ...r })),
    fc.record({ a: tie("spec"), b: tie("spec") }).map<Spec>((r) => ({ k: "or", ...r })),
  ),
})).spec;

export const ctxArb: fc.Arbitrary<CastraContext> = fc
  .record({
    userId: fc.option(fc.constantFrom(...USER_IDS), { nil: null }),
    roles: fc.subarray(ROLE_POOL),
  })
  .map(({ userId, roles }) => ({
    user: userId === null ? null : { id: userId },
    roles, // anonymous contexts may carry roles; they must be ignored
    session: null,
    request: null,
    via: userId === null ? ("anonymous" as const) : ("test" as const),
  }));

const textOrNull = (values: string[]) => fc.option(fc.constantFrom(...values), { nil: null, freq: 4 });

export const rowsArb: fc.Arbitrary<ItemRow[]> = fc
  .array(
    fc.record({
      owner_id: textOrNull([...USER_IDS, "u9"]),
      status: textOrNull([...WORDS, "u1", "u2"]),
      category: textOrNull(WORDS),
      score: fc.option(fc.integer({ min: -3, max: 3 }), { nil: null, freq: 4 }),
    }),
    { minLength: 0, maxLength: 8 },
  )
  .map((rows) => rows.map((r, i) => ({ id: i + 1, ...r })));
