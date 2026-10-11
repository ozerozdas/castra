/** Package identifier. */
export const name = "@castra/cli";

export { run } from "./run.js";
export type { RunEnv } from "./run.js";

// Commands (each takes plain options + injectable side effects; reusable by create-castra).
export { generate } from "./commands/generate.js";
export type { GenerateDeps, GenerateOptions } from "./commands/generate.js";
export { provision, defaultBucketName, KV_BINDING, R2_BINDING, R2_BUCKET_NAME_MAX } from "./commands/provision.js";
export type {
  CloudflareDeps,
  ProvisionOptions,
  ProvisionResult,
  ProvisionedResource,
} from "./commands/provision.js";
export { migrate } from "./commands/migrate.js";
export type { MigrateDeps, MigrateOptions } from "./commands/migrate.js";
export { doctor, formatTable, PERMISSIONS } from "./commands/doctor.js";
export type { CheckStatus, DoctorCheck, DoctorDeps, DoctorOptions, PermissionSpec } from "./commands/doctor.js";
export { deploy, parseDeployedUrl, AUTH_SECRET_NAME } from "./commands/deploy.js";
export type { DeployDeps, DeployOptions, DeployResult } from "./commands/deploy.js";
export { mcp, loadCastraConfig } from "./commands/mcp.js";
export type { McpOptions } from "./commands/mcp.js";
export { testPolicies, POLICY_TEST_FILTER } from "./commands/test-policies.js";
export type { TestPoliciesDeps, TestPoliciesOptions } from "./commands/test-policies.js";
export { createMcpTokenCommand, revokeMcpTokenCommand } from "./commands/mcp-token.js";
export type { CreateMcpTokenOptions, McpTokenDeps, McpTokenTarget } from "./commands/mcp-token.js";

// Cloudflare API client and session.
export { CloudflareApi, CloudflareApiError, CLOUDFLARE_API_BASE } from "./cloudflare/api.js";
export type {
  Account,
  CloudflareMessage,
  D1Database,
  FetchFn,
  KvNamespace,
  R2Bucket,
  TokenPolicy,
  TokenVerification,
} from "./cloudflare/api.js";
export { connect } from "./cloudflare/connect.js";
export type { CloudflareEnv, CloudflareSession } from "./cloudflare/connect.js";
export { ProblemError, problems, TOKEN_DOCS } from "./problems.js";

// Process and config helpers.
export { spawnExec } from "./exec.js";
export type { ExecFn, ExecOptions, ExecResult } from "./exec.js";
export {
  CliError,
  UsageError,
  isPlaceholderId,
  readD1Target,
  readWranglerConfig,
  setJsoncValue,
} from "./wrangler-config.js";
export type { D1Binding, D1Target, KvBinding, R2Binding, WranglerConfig } from "./wrangler-config.js";
export { openLocalD1 } from "./local-d1.js";
export type { OpenDatabase, OpenDatabaseFn } from "./local-d1.js";
export { remoteD1Opener } from "./remote-d1.js";
