import type { Account } from "./cloudflare/api.js";

/** Where the minimum token permissions are documented. */
export const TOKEN_DOCS = "docs/cloudflare-token.md";

/**
 * A user-fixable failure, shaped like an RFC 9457 problem (`type`, `title`, `detail`) plus a `fix` hint.
 * `run` prints it without a stack and exits 1.
 */
export class ProblemError extends Error {
  constructor(
    /** Stable machine-readable slug, e.g. `missing-token`. */
    readonly type: string,
    readonly title: string,
    readonly detail: string,
    readonly fix: string,
  ) {
    super(`${title}: ${detail}`);
  }

  /** Lines printed to stderr. */
  format(): string[] {
    return [`error[${this.type}]: ${this.title}`, `  ${this.detail}`, `  fix: ${this.fix}`];
  }
}

export const problems = {
  missingToken: () =>
    new ProblemError(
      "missing-token",
      "Missing Cloudflare API token",
      "CLOUDFLARE_API_TOKEN is not set.",
      `Create an API token in the Cloudflare dashboard (My Profile > API Tokens) with the permissions in ${TOKEN_DOCS}, then \`export CLOUDFLARE_API_TOKEN=...\`.`,
    ),
  invalidToken: (reason: string) =>
    new ProblemError(
      "invalid-token",
      "Invalid Cloudflare API token",
      `Cloudflare rejected CLOUDFLARE_API_TOKEN (${reason}).`,
      `Check the token was copied completely, is not expired or disabled, and (for an account-owned token) set CLOUDFLARE_ACCOUNT_ID. See ${TOKEN_DOCS}.`,
    ),
  inactiveToken: (status: string) =>
    new ProblemError(
      "inactive-token",
      "Cloudflare API token is not active",
      `The token status is "${status}".`,
      "Re-enable the token or roll a new one in the Cloudflare dashboard (My Profile > API Tokens).",
    ),
  noAccount: () =>
    new ProblemError(
      "no-account",
      "No Cloudflare account visible to the token",
      "The token cannot list any account.",
      "Set CLOUDFLARE_ACCOUNT_ID (dashboard > Workers & Pages > Account ID) or pass --account-id.",
    ),
  multipleAccounts: (accounts: Account[]) =>
    new ProblemError(
      "multiple-accounts",
      "The token can access several Cloudflare accounts",
      `Pick one: ${accounts.map((a) => `${a.id} (${a.name})`).join(", ")}.`,
      "Set CLOUDFLARE_ACCOUNT_ID=<id> or pass --account-id <id>.",
    ),
  missingPermission: (permission: string, action: string) =>
    new ProblemError(
      "missing-permission",
      `Missing token permission "${permission}"`,
      `Cloudflare refused to ${action}.`,
      `Edit the token and add Account > ${permission}. Run \`castra doctor\` to list every missing permission (${TOKEN_DOCS}).`,
    ),
};
