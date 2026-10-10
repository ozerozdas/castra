import type { Expression, ExpressionBuilder, SqlBool } from "kysely";
import type { CastraContext } from "../types.js";

/**
 * Predicate used by {@link custom}. Receives the expression builder of the base table and the
 * request context, and must return a Kysely boolean expression. It is compiled into SQL; it is
 * never evaluated in JavaScript against fetched rows.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CustomPredicate = (eb: ExpressionBuilder<any, any>, ctx: CastraContext) => Expression<SqlBool>;

/** Argument passed to a {@link Rule.where} predicate. */
export interface WhereArgs {
  /** Expression builder of the base table. Callable: `q.eb("status", "=", "published")`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eb: ExpressionBuilder<any, any>;
  /** Request context the rule is evaluated against. */
  ctx: CastraContext;
}

/** Row predicate used by {@link Rule.where}. */
export type WherePredicate = (q: WhereArgs) => Expression<SqlBool>;

/** Internal rule tree. Exported for the engine and tests; not part of the config surface. */
export type RuleNode =
  | { readonly kind: "public" }
  | { readonly kind: "authenticated" }
  | { readonly kind: "role"; readonly roles: readonly string[] }
  | { readonly kind: "owner"; readonly column: string }
  | { readonly kind: "custom"; readonly name: string; readonly fn: CustomPredicate }
  | { readonly kind: "where"; readonly fn: WherePredicate }
  | { readonly kind: "and"; readonly children: readonly RuleNode[] }
  | { readonly kind: "or"; readonly children: readonly RuleNode[] };

const RULE_BRAND: unique symbol = Symbol("castra.rule");

/**
 * An immutable access rule. Build rules with {@link isPublic}, {@link authenticated}, {@link role},
 * {@link owner} and {@link custom}, then combine them with {@link Rule.and}, {@link Rule.or} and
 * {@link Rule.where}. Every combinator returns a new rule; the receiver is never modified.
 */
export class Rule {
  /** @internal Brand that lets `defineConfig` reject look-alike objects. */
  readonly [RULE_BRAND] = true;
  /** The rule tree. */
  readonly node: RuleNode;

  /** @internal Use the rule builders instead. */
  constructor(node: RuleNode) {
    this.node = node;
    Object.freeze(this);
  }

  /** Both this rule and `other` must allow. */
  and(other: Rule): Rule {
    assertRule(other, "and()");
    return new Rule(combine("and", this.node, other.node));
  }

  /** Either this rule or `other` must allow. */
  or(other: Rule): Rule {
    assertRule(other, "or()");
    return new Rule(combine("or", this.node, other.node));
  }

  /**
   * Narrows this rule by a row predicate: the result allows a row only if this rule allows it AND
   * the predicate holds for the row. Example: `isPublic().where((q) => q.eb("status", "=", "published"))`.
   */
  where(fn: WherePredicate): Rule {
    if (typeof fn !== "function") throw new TypeError("Rule.where() expects a function");
    return new Rule(combine("and", this.node, Object.freeze({ kind: "where", fn })));
  }

  /** Human-readable rule tree, e.g. `or(and(public, where), owner(author_id), role(admin))`. */
  toString(): string {
    return describeRule(this.node);
  }
}

function combine(kind: "and" | "or", a: RuleNode, b: RuleNode): RuleNode {
  const children: RuleNode[] = [];
  for (const n of [a, b]) {
    if (n.kind === kind) children.push(...n.children);
    else children.push(n);
  }
  return Object.freeze({ kind, children: Object.freeze(children) });
}

/** True if `value` is a {@link Rule} created by Castra's builders. */
export function isRule(value: unknown): value is Rule {
  return value instanceof Rule && (value as Rule)[RULE_BRAND] === true;
}

function assertRule(value: unknown, where: string): asserts value is Rule {
  if (!isRule(value)) throw new TypeError(`${where} expects a rule built with castra's rule builders`);
}

/** Allows everyone, including anonymous callers. */
export function isPublic(): Rule {
  return new Rule(Object.freeze({ kind: "public" }));
}

/** Allows any authenticated user. */
export function authenticated(): Rule {
  return new Rule(Object.freeze({ kind: "authenticated" }));
}

/**
 * Allows authenticated users holding at least one of `roles`. Roles must be declared in
 * `config.roles`; `defineConfig` rejects unknown ones.
 */
export function role(...roles: string[]): Rule {
  if (roles.length === 0) throw new TypeError("role() needs at least one role name");
  for (const r of roles) {
    if (typeof r !== "string" || r.length === 0) throw new TypeError("role() names must be non-empty strings");
  }
  return new Rule(Object.freeze({ kind: "role", roles: Object.freeze([...new Set(roles)]) }));
}

/**
 * Allows rows whose `column` equals the caller's user id. Compiles to `"table"."column" = ?`;
 * always false for anonymous callers. The column must exist in the schema snapshot.
 */
export function owner(column: string): Rule {
  if (typeof column !== "string" || column.length === 0) throw new TypeError("owner() needs a column name");
  return new Rule(Object.freeze({ kind: "owner", column }));
}

/**
 * A named custom predicate that compiles to SQL. `name` appears in explanations.
 * The predicate must not read row data in JavaScript; it builds an expression only.
 */
export function custom(name: string, fn: CustomPredicate): Rule {
  if (typeof name !== "string" || name.length === 0) throw new TypeError("custom() needs a name");
  if (typeof fn !== "function") throw new TypeError("custom() needs a predicate function");
  return new Rule(Object.freeze({ kind: "custom", name, fn }));
}

/** Renders a rule tree as a stable, human-readable string. */
export function describeRule(node: RuleNode): string {
  switch (node.kind) {
    case "public":
      return "public";
    case "authenticated":
      return "authenticated";
    case "role":
      return `role(${node.roles.join(", ")})`;
    case "owner":
      return `owner(${node.column})`;
    case "custom":
      return `custom(${node.name})`;
    case "where":
      return "where";
    case "and":
    case "or":
      return `${node.kind}(${node.children.map(describeRule).join(", ")})`;
  }
}

/** Visits every node of a rule tree. */
export function walkRule(node: RuleNode, visit: (n: RuleNode) => void): void {
  visit(node);
  if (node.kind === "and" || node.kind === "or") for (const c of node.children) walkRule(c, visit);
}
