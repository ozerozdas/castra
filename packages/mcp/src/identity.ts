import { getRoles, type AuthDbInput } from "@castra/auth";
import { ApiError, type CastraConfig, type CastraContext, type ContextVia } from "castra";
import { z } from "zod";
import type { McpDb } from "./db.js";
import { ANY_USER_SCOPE, TOOL_SCOPES, type McpScope, type ToolName } from "./scopes.js";

/**
 * The identity a tool evaluates as: `"anonymous"`, or a user id with optional explicit roles.
 * Omitted: anonymous on the local server, the token's own user on the remote server.
 */
export const asSchema = z.union([
  z.literal("anonymous"),
  z
    .object({
      userId: z.string().min(1).max(256).optional().describe("User id (Better Auth user). Omit for the caller's own user (remote)."),
      roles: z
        .array(z.string().min(1).max(64))
        .max(32)
        .optional()
        .describe("Hypothetical role set. Omit to use the user's current roles from _castra_roles."),
    })
    .strict(),
]);

/** Parsed `as` argument. */
export type AsInput = z.infer<typeof asSchema>;

/** Raised when a remote token lacks the scope a call needs. Rendered as a tool error naming the scope. */
export class ToolDenied extends Error {
  readonly scope: McpScope;
  constructor(scope: McpScope) {
    super(`missing scope: ${scope}`);
    this.name = "ToolDenied";
    this.scope = scope;
  }
}

/**
 * Decides who a tool call runs as, and whether it may run at all. The local (stdio) server allows
 * any identity; the remote server enforces token scopes (ADR 0061).
 */
export interface ToolAccess {
  /** Throws {@link ToolDenied} or an `ApiError`; otherwise returns the context to evaluate policies with. */
  authorize(tool: ToolName, as: AsInput | undefined): Promise<CastraContext>;
}

/** An anonymous context outside any HTTP request. */
export function anonymous(via: ContextVia): CastraContext {
  return { user: null, roles: [], session: null, request: null, via };
}

/**
 * Context for `userId`: profile from the Better Auth `user` table when present, roles from
 * `_castra_roles` (filtered to configured roles, exactly like REST's `resolveContext`), or the
 * explicit `roles` when given (each must be a configured role).
 */
export async function contextFor(
  db: McpDb,
  config: CastraConfig,
  userId: string,
  roles: string[] | undefined,
  via: ContextVia,
): Promise<CastraContext> {
  if (roles) {
    for (const r of roles) {
      if (!config.roles.includes(r)) throw new ApiError(400, "unknown_role", `unknown role "${r}"`);
    }
  }
  let user: CastraContext["user"] = { id: userId };
  const row = await db.selectFrom("user").select(["id", "email", "name"]).where("id", "=", userId).executeTakeFirst();
  if (row) user = { id: row.id, email: row.email, name: row.name };
  const effective = roles ? [...new Set(roles)].sort() : await getRoles(db as unknown as AuthDbInput, userId, config.roles);
  return { user, roles: effective, session: null, request: null, via };
}

/**
 * Access for the local stdio server (a developer tool): every tool, any identity. `as` omitted or
 * `"anonymous"` is anonymous; `{ userId, roles? }` impersonates that user. Never exposed remotely.
 */
export function localAccess(db: McpDb, config: CastraConfig): ToolAccess {
  return {
    async authorize(_tool, as) {
      if (as === undefined || as === "anonymous") return anonymous("test");
      if (as.userId === undefined) {
        throw new ApiError(400, "invalid_identity", "as.userId is required on the local server (or use \"anonymous\")");
      }
      return contextFor(db, config, as.userId, as.roles, "test");
    },
  };
}

/** The verified token a remote call runs under. */
export interface TokenIdentity {
  tokenId: string;
  userId: string;
  scopes: readonly McpScope[];
}

/**
 * Access for the remote `/mcp` route. The tool's scope is required; `as` naming anything other
 * than the token's own user with their current roles also requires `data:read:any_user`.
 */
export function remoteAccess(db: McpDb, config: CastraConfig, token: TokenIdentity): ToolAccess {
  return {
    async authorize(tool, as) {
      const needed = TOOL_SCOPES[tool];
      if (!token.scopes.includes(needed)) throw new ToolDenied(needed);
      if (tool === "describe_schema") return anonymous("mcpToken");
      const self = as === undefined || (as !== "anonymous" && (as.userId === undefined || as.userId === token.userId) && as.roles === undefined);
      if (!self && !token.scopes.includes(ANY_USER_SCOPE)) throw new ToolDenied(ANY_USER_SCOPE);
      if (as === "anonymous") return anonymous("mcpToken");
      return contextFor(db, config, as?.userId ?? token.userId, as?.roles, "mcpToken");
    },
  };
}

/** A short, non-secret description of the evaluated identity, echoed in tool results. */
export function describeIdentity(ctx: CastraContext): { userId: string | null; roles: string[] } {
  return { userId: ctx.user?.id ?? null, roles: [...ctx.roles] };
}
