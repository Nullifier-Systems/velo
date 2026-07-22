/**
 * Typed error classes for Soroban RPC failures.
 * Kept in a separate module so callers (routes, tests) can import them
 * without pulling in the full @stellar/stellar-sdk dependency.
 */

/**
 * Thrown when an RPC operation or confirmation poll exceeds its allotted
 * time budget.  Use `instanceof RpcTimeoutError` to distinguish timeouts
 * from other Soroban failures and emit HTTP 504 rather than 502.
 */
export class RpcTimeoutError extends Error {
    /** Milliseconds waited before the deadline fired. */
    readonly elapsedMs: number;
    /** Human-readable label for the timed-out operation, e.g. "lock/poll". */
    readonly operation: string;

    constructor(operation: string, elapsedMs: number) {
        super(`RPC timeout: ${operation} did not complete within ${elapsedMs} ms`);
        this.name = "RpcTimeoutError";
        this.operation = operation;
        this.elapsedMs = elapsedMs;
    }
}
