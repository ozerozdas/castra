import { createAuthDb, type AuthDbInput } from "./db.js";

/** Thrown when a role is not in the configured role list. */
export class UnknownRoleError extends Error {
  constructor(role: string) {
    super(`Unknown role "${role}". Add it to the configured roles list first.`);
    this.name = "UnknownRoleError";
  }
}

/** Throws {@link UnknownRoleError} unless every role is in `allowedRoles`. */
export function assertKnownRoles(roles: readonly string[], allowedRoles: readonly string[]): void {
  for (const role of roles) {
    if (!allowedRoles.includes(role)) throw new UnknownRoleError(role);
  }
}

/**
 * Grants `role` to `userId`. Idempotent. The role must be in `allowedRoles` (the configured role list).
 * The user must exist in the Better Auth `user` table (enforced by a foreign key).
 */
export async function assignRole(
  database: AuthDbInput,
  userId: string,
  role: string,
  allowedRoles: readonly string[],
): Promise<void> {
  assertKnownRoles([role], allowedRoles);
  await createAuthDb(database)
    .insertInto("_castra_roles")
    .values({ user_id: userId, role, created_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(["user_id", "role"]).doNothing())
    .execute();
}

/** Removes `role` from `userId`. Returns `true` when a grant was removed. */
export async function revokeRole(database: AuthDbInput, userId: string, role: string): Promise<boolean> {
  const result = await createAuthDb(database)
    .deleteFrom("_castra_roles")
    .where("user_id", "=", userId)
    .where("role", "=", role)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/**
 * Returns the roles granted to `userId`, sorted. When `allowedRoles` is given, grants for roles no
 * longer in the configured list are ignored (a removed role stops granting access).
 */
export async function getRoles(
  database: AuthDbInput,
  userId: string,
  allowedRoles?: readonly string[],
): Promise<string[]> {
  const rows = await createAuthDb(database)
    .selectFrom("_castra_roles")
    .select("role")
    .where("user_id", "=", userId)
    .orderBy("role")
    .execute();
  const roles = rows.map((r) => r.role);
  return allowedRoles ? roles.filter((r) => allowedRoles.includes(r)) : roles;
}
