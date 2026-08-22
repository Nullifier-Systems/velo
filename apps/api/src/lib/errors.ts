/**
 * Standardized error taxonomy (#242).
 *
 * Every API error must use ApiError instead of ad hoc
 * `reply.code(n).send({ error: "..." })` calls. This ensures AI agents
 * can programmatically distinguish "retry this" from "don't retry this".
 *
 * @example
 * ```typescript
 * throw new ApiError(404, ErrorCode.TRADE_NOT_FOUND, "Trade request not found");
 * // → { error: "Trade request not found", code: "TRADE_NOT_FOUND",
 * //    statusCode: 404, retryable: false, requestId: "..." }
 * ```
 */

/* ------------------------------------------------------------------ */
/*  Error codes                                                       */
/* ------------------------------------------------------------------ */

export const ErrorCode = {
  /* 400 — Validation */
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_PARAMETER: "INVALID_PARAMETER",
  INVALID_PRECISION: "INVALID_PRECISION",
  INVALID_COORDINATES: "INVALID_COORDINATES",
  INVALID_EMAIL: "INVALID_EMAIL",
  INVALID_PHONE: "INVALID_PHONE",
  INVALID_MODE: "INVALID_MODE",
  INVALID_PAYOUT_MODE: "INVALID_PAYOUT_MODE",
  INVALID_IMAGE_TYPE: "INVALID_IMAGE_TYPE",
  INVALID_IMAGE_CONTENT: "INVALID_IMAGE_CONTENT",
  MISSING_FIELD: "MISSING_FIELD",
  MISSING_HEADER: "MISSING_HEADER",
  MISSING_SIGNED_XDR: "MISSING_SIGNED_XDR",
  MISSING_SECRET_OR_XDR: "MISSING_SECRET_OR_XDR",

  /* 401 — Auth */
  UNAUTHORIZED: "UNAUTHORIZED",
  UNAUTHORIZED_ADMIN: "UNAUTHORIZED_ADMIN",
  INVALID_API_KEY: "INVALID_API_KEY",
  MISSING_API_KEY_CONFIG: "MISSING_API_KEY_CONFIG",
  INVALID_CHAT_CAPABILITY: "INVALID_CHAT_CAPABILITY",
  MISSING_PROVIDER_ADDRESS: "MISSING_PROVIDER_ADDRESS",
  INVALID_MULTISIG_SIGNATURE: "INVALID_MULTISIG_SIGNATURE",

  /* 402 — Payment required (x402) */
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  PAYMENT_ALREADY_USED: "PAYMENT_ALREADY_USED",
  PAYMENT_NOT_SUCCESSFUL: "PAYMENT_NOT_SUCCESSFUL",
  INVALID_PAYMENT_MEMO: "INVALID_PAYMENT_MEMO",
  INVALID_PAYMENT_TX: "INVALID_PAYMENT_TX",

  /* 403 — Forbidden */
  FORBIDDEN: "FORBIDDEN",
  REGISTRATION_LIMIT_EXCEEDED: "REGISTRATION_LIMIT_EXCEEDED",
  LOCATION_NOT_REVEALED: "LOCATION_NOT_REVEALED",
  NOT_TRADE_PARTICIPANT: "NOT_TRADE_PARTICIPANT",

  /* 404 — Not found */
  NOT_FOUND: "NOT_FOUND",
  TRADE_NOT_FOUND: "TRADE_NOT_FOUND",
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  EVIDENCE_NOT_FOUND: "EVIDENCE_NOT_FOUND",
  DOCUMENT_NOT_FOUND: "DOCUMENT_NOT_FOUND",

  /* 409 — Conflict */
  CONFLICT: "CONFLICT",
  WRONG_STATUS: "WRONG_STATUS",
  STATE_ALREADY_SET: "STATE_ALREADY_SET",
  DOCUMENT_REQUIRED: "DOCUMENT_REQUIRED",
  KEY_ALREADY_INACTIVE: "KEY_ALREADY_INACTIVE",

  /* 415 — Unsupported media */
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",

  /* 429 — Rate limit */
  RATE_LIMIT: "RATE_LIMIT",

  /* 500 — Internal */
  INTERNAL_ERROR: "INTERNAL_ERROR",
  DB_UPDATE_FAILED: "DB_UPDATE_FAILED",
  LOAD_FAILED: "LOAD_FAILED",

  /* 502 — Bad gateway */
  ESCROW_LOCK_FAILED: "ESCROW_LOCK_FAILED",
  ESCROW_RELEASE_FAILED: "ESCROW_RELEASE_FAILED",
  ESCROW_REFUND_FAILED: "ESCROW_REFUND_FAILED",
  ESCROW_DISPUTE_FAILED: "ESCROW_DISPUTE_FAILED",
  TX_BUILD_FAILED: "TX_BUILD_FAILED",
  TX_SUBMIT_FAILED: "TX_SUBMIT_FAILED",
  ONCHAIN_RESOLVE_FAILED: "ONCHAIN_RESOLVE_FAILED",

  /* 503 — Service unavailable */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  CONFIG_ERROR: "CONFIG_ERROR",

  /* 504 — Gateway timeout */
  RPC_TIMEOUT: "RPC_TIMEOUT",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/* ------------------------------------------------------------------ */
/*  Retryability defaults                                             */
/* ------------------------------------------------------------------ */

const RETRYABLE_CODES = new Set<string>([
  ErrorCode.RPC_TIMEOUT,
  ErrorCode.RATE_LIMIT,
  ErrorCode.ESCROW_LOCK_FAILED,
  ErrorCode.ESCROW_RELEASE_FAILED,
  ErrorCode.ESCROW_REFUND_FAILED,
  ErrorCode.ESCROW_DISPUTE_FAILED,
  ErrorCode.TX_BUILD_FAILED,
  ErrorCode.TX_SUBMIT_FAILED,
  ErrorCode.ONCHAIN_RESOLVE_FAILED,
  ErrorCode.SERVICE_UNAVAILABLE,
  ErrorCode.INTERNAL_ERROR,
  ErrorCode.DB_UPDATE_FAILED,
]);

/* ------------------------------------------------------------------ */
/*  ApiError class                                                    */
/* ------------------------------------------------------------------ */

export interface ApiErrorResponse {
  error: string;
  code: string;
  statusCode: number;
  retryable: boolean;
  detail?: string;
  requestId?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: string;
  readonly requestId?: string;
  readonly extra: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options?: {
      retryable?: boolean;
      detail?: string;
      requestId?: string;
      extra?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = options?.retryable ?? RETRYABLE_CODES.has(code);
    this.detail = options?.detail;
    this.requestId = options?.requestId;
    this.extra = options?.extra ?? {};
  }

  toJSON(requestId?: string): ApiErrorResponse {
    return {
      error: this.message,
      code: this.code,
      statusCode: this.statusCode,
      retryable: this.retryable,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(requestId || this.requestId ? { requestId: requestId ?? this.requestId } : {}),
      ...this.extra,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Helper factories                                                  */
/* ------------------------------------------------------------------ */

export function badRequest(code: string, message: string, detail?: string): ApiError {
  return new ApiError(400, code, message, { detail });
}

export function unauthorized(code: string, message: string): ApiError {
  return new ApiError(401, code, message);
}

export function notFound(code: string, message: string): ApiError {
  return new ApiError(404, code, message);
}

export function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

export function gatewayError(code: string, message: string, detail?: string): ApiError {
  return new ApiError(502, code, message, { detail, retryable: true });
}

export function serverError(message: string, detail?: string): ApiError {
  return new ApiError(500, ErrorCode.INTERNAL_ERROR, message, { detail, retryable: true });
}
