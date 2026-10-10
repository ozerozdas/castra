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

export {
  affinityOf,
  diffSnapshots,
  generateKyselyTypes,
  introspect,
  isInternalTable,
  quoteIdentifier,
} from "./schema/index.js";
export type { IntrospectOptions, QueryFn } from "./schema/index.js";
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
  WRITE_CHECK_MARKER,
} from "./policy/index.js";
export { isWriteCheckError, runGuardedWrite } from "./db/index.js";
export type { D1DatabaseLike, D1ResultLike, D1StatementLike } from "./db/index.js";
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
  WriteGuard,
  WriteTarget,
} from "./policy/index.js";

export * from "./api/index.js";
