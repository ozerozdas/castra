import { problems } from "../problems.js";
import { CloudflareApi, CloudflareApiError } from "./api.js";
import type { FetchFn, TokenVerification } from "./api.js";

/** Environment variables the CLI reads. A subset of `process.env`. */
export interface CloudflareEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

/** An authenticated API client bound to one account. */
export interface CloudflareSession {
  api: CloudflareApi;
  accountId: string;
  token: TokenVerification;
}

/**
 * Read `CLOUDFLARE_API_TOKEN`, verify it, and resolve the account: `--account-id`, then `CLOUDFLARE_ACCOUNT_ID`,
 * then the single account `GET /accounts` returns. Throws a {@link ProblemError} for every user-fixable case.
 */
export async function connect(options: { env: CloudflareEnv; fetch: FetchFn; accountId?: string }): Promise<CloudflareSession> {
  const token = options.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw problems.missingToken();
  const api = new CloudflareApi(token, options.fetch);

  const explicitAccount = options.accountId ?? (options.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);

  // ponytail: token prefixes per Cloudflare's token formats page; legacy unprefixed tokens skip these checks.
  if (token.startsWith("cfk_")) throw problems.globalApiKey();
  if (token.startsWith("cfat_") && explicitAccount === undefined) throw problems.accountTokenNeedsAccountId();

  let verification: TokenVerification;
  try {
    verification = await api.verifyToken(explicitAccount);
  } catch (e) {
    if (e instanceof CloudflareApiError) {
      throw problems.invalidToken(e.errors.map((x) => x.message).join("; ") || `HTTP ${e.status}`);
    }
    throw e;
  }
  if (verification.status !== "active") throw problems.inactiveToken(verification.status);

  return { api, accountId: explicitAccount ?? (await resolveSingleAccount(api)), token: verification };
}

async function resolveSingleAccount(api: CloudflareApi): Promise<string> {
  let accounts;
  try {
    accounts = await api.listAccounts();
  } catch (e) {
    if (e instanceof CloudflareApiError && e.isAuthError) throw problems.noAccount();
    throw e;
  }
  if (accounts.length === 0) throw problems.noAccount();
  if (accounts.length > 1) throw problems.multipleAccounts(accounts);
  return accounts[0]!.id;
}
