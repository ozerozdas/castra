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
