import { PolicyError } from "../policy/errors.js";

/** RFC 9457 problem details body. Every REST error is rendered as `application/problem+json`. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
}

/** HTTP statuses the API layer produces on its own. */
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 500;

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

/**
 * A client-facing error raised by `parseRequest`, `planRequest` or `executePlan`. The message is
 * safe to show: it never contains SQL, parameters of other users or stack traces.
 */
export class ApiError extends Error {
  readonly status: ApiErrorStatus;
  /** Short machine-readable code, also used as the problem `type` suffix. */
  readonly code: string;

  constructor(status: ApiErrorStatus, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** The single response used for unknown tables, closed tables and closed operations alike. */
export function notFound(): ApiError {
  return new ApiError(404, "not_found", "The requested resource does not exist.");
}

/** Builds a problem body. */
export function problemBody(status: number, detail: string, code?: string): ProblemDetails {
  return {
    type: code ? `https://castra.dev/problems/${code}` : "about:blank",
    title: TITLES[status] ?? "Error",
    status,
    detail,
  };
}

/** Returns an `application/problem+json` response. */
export function problemResponse(status: number, detail: string, code?: string): Response {
  return new Response(JSON.stringify(problemBody(status, detail, code)), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/**
 * Maps any thrown value to a problem body. {@link ApiError} and {@link PolicyError} keep their
 * status and message; anything else is a generic 500 (the original error is never exposed).
 *
 * `PolicyError`s about hidden columns are reported exactly like unknown columns, so a client cannot
 * learn that a hidden column exists.
 */
export function toProblem(err: unknown): ProblemDetails {
  if (err instanceof ApiError) return problemBody(err.status, err.message, err.code);
  if (err instanceof PolicyError) {
    if (err.status === 404) return problemBody(404, notFound().message, "not_found");
    if (err.code === "hidden_column" || err.code === "unknown_column") {
      const col = /"([^"]*)"/.exec(err.message)?.[1] ?? "";
      return problemBody(400, `unknown column "${col}"`, "unknown_column");
    }
    return problemBody(err.status, err.message, err.code);
  }
  return problemBody(500, "An unexpected error occurred.", "internal");
}
