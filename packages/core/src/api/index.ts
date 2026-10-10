/**
 * REST API layer: request parsing, planning (compiled SQL + policy explanations, no execution),
 * execution, OpenAPI and the Hono router. MCP reuses `parseRequest` → `planRequest` → `executePlan`.
 * See docs/ARCHITECTURE.md §4 and ADRs 0040–0044.
 */
export { d1Batch } from "./batch.js";
export type { BatchRunner, BatchStatementResult, D1BatchCapable } from "./batch.js";
export { apiModel, DEFAULT_MAX_LIMIT, DEFAULT_PAGE_SIZE, INCLUDE_MANY_PER_PARENT } from "./model.js";
export type { ApiModel, Relation, TableModel } from "./model.js";
export { generateOpenApi } from "./openapi.js";
export type { JsonObject, OpenApiOptions } from "./openapi.js";
export { decodeCursor, encodeCursor, FILTER_OPERATORS, LIMITS, parseFilter, parseRequest, RESERVED_PARAMS } from "./parse.js";
export type { FilterOperator, ListOptions, ParsedFilter, ParsedRequest, RawCursor, RequestInput, SortKey } from "./parse.js";
export { executePlan, isGuardFailure, PARENT_KEYS, planRequest } from "./plan.js";
export type { ApiResult, ExecuteOptions, Plan, PlannedStatement } from "./plan.js";
export { ApiError, problemBody, problemResponse, toProblem } from "./problem.js";
export type { ApiErrorStatus, ProblemDetails } from "./problem.js";
export { createRestRouter, DEFAULT_MAX_BODY_BYTES } from "./router.js";
export type { RestRequestInfo, RestRouterOptions } from "./router.js";
