import "dotenv/config";
import { ApiError } from "./errors.js";

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

export function requireAdminAuth(request: any, _reply: any): boolean {
  if (!ADMIN_API_KEY) {
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

  if (token !== ADMIN_API_KEY) {
    throw new ApiError(403, "INVALID_API_KEY", "Invalid admin API key");
  }

  return true;
}
