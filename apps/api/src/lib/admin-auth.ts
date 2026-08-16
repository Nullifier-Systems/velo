import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.js";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function requireAdminAuth(request: any, _reply: any): boolean {
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (!adminApiKey) {
    throw new ApiError(503, "CONFIG_ERROR", "Admin API key not configured. Set ADMIN_API_KEY environment variable.");
  }

  const authHeader = request.headers["authorization"];
  if (!authHeader || typeof authHeader !== "string") {
    throw new ApiError(401, "MISSING_API_KEY_CONFIG", "Missing Authorization header");
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new ApiError(401, "UNAUTHORIZED", "Authorization header must be: Bearer <admin-api-key>");
  }

  if (!safeCompare(token, adminApiKey)) {
    throw new ApiError(403, "INVALID_API_KEY", "Invalid admin API key");
  }

  return true;
}

/**
 * Validate the `x-admin-api-key` request header used by the ops dashboard and
 * the circuit-breaker override route (#374). Throws `ApiError` with the
 * standardized `UNAUTHORIZED_ADMIN` code on any failure.
 */
export function requireAdminApiKeyHeader(request: { headers: Record<string, string | string[] | undefined> }): boolean {
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (!adminApiKey) {
    throw new ApiError(
      503,
      "CONFIG_ERROR",
      "Admin API key not configured. Set ADMIN_API_KEY environment variable.",
    );
  }

  const raw = request.headers["x-admin-api-key"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token || typeof token !== "string") {
    throw new ApiError(
      401,
      "UNAUTHORIZED_ADMIN",
      "Invalid or missing admin authentication key.",
    );
  }

  if (!safeCompare(token, adminApiKey)) {
    throw new ApiError(
      401,
      "UNAUTHORIZED_ADMIN",
      "Invalid or missing admin authentication key.",
    );
  }

  return true;
}
