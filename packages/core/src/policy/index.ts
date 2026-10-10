/**
 * Policy engine: rule builders, compiler to Kysely `WHERE` fragments, write checks, field rules and
 * explanations. See docs/ARCHITECTURE.md §3 and ADRs 0005–0008.
 */
export { authenticated, custom, isPublic, isRule, owner, role, Rule } from "./rules.js";
export type { CustomPredicate, RuleNode, WhereArgs, WherePredicate } from "./rules.js";
export { CastraConfigError, PolicyError } from "./errors.js";
export type { Explanation, PolicyErrorCode, PolicyErrorStatus } from "./errors.js";
export { createPolicyEngine } from "./engine.js";
export type { Decision, Filter, PolicyEngine, PolicyEngineOptions, PreparedWrite } from "./engine.js";
