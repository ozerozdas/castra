/** Package identifier (placeholder until real exports land). */
export const name = "castra";

export type {
  CastraContext,
  ColumnSnapshot,
  ContextVia,
  ForeignKeySnapshot,
  IndexSnapshot,
  Operation,
  SchemaSnapshot,
  SqliteAffinity,
  TableSnapshot,
} from "./types.js";

export { AUTH_TABLES, defineConfig, isReservedTable } from "./config.js";
export type { AuthConfig, CastraConfig, FieldConfig, TableConfig } from "./config.js";

export {
  authenticated,
  CastraConfigError,
  createPolicyEngine,
  custom,
  isPublic,
  isRule,
  owner,
  PolicyError,
  role,
  Rule,
} from "./policy/index.js";
export type {
  CustomPredicate,
  Decision,
  Explanation,
  Filter,
  PolicyEngine,
  PolicyEngineOptions,
  PolicyErrorCode,
  PolicyErrorStatus,
  PreparedWrite,
  RuleNode,
  WhereArgs,
  WherePredicate,
} from "./policy/index.js";
