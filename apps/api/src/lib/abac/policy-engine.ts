/**
 * ABAC Policy AST evaluation engine (#401).
 * Evaluates JSONB expression against a flat attribute context.
 * Mirrors the shape stored in abac_policies.expression.
 */

import type { AbacExpression } from "@velo/shared";

export type EvalContext = Record<string, unknown>;

function getPath(ctx: EvalContext, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function evaluateExpression(expr: AbacExpression, ctx: EvalContext): boolean {
  switch (expr.op) {
    case "true":
      return true;
    case "false":
      return false;
    case "eq":
      return getPath(ctx, expr.left) === expr.right;
    case "neq":
      return getPath(ctx, expr.left) !== expr.right;
    case "gt":
      return Number(getPath(ctx, expr.left)) > expr.right;
    case "gte":
      return Number(getPath(ctx, expr.left)) >= expr.right;
    case "lt":
      return Number(getPath(ctx, expr.left)) < expr.right;
    case "lte":
      return Number(getPath(ctx, expr.left)) <= expr.right;
    case "in": {
      const v = getPath(ctx, expr.left);
      return Array.isArray(expr.right) && expr.right.includes(v);
    }
    case "and":
      return expr.args.every((a: AbacExpression) => evaluateExpression(a, ctx));
    case "or":
      return expr.args.some((a: AbacExpression) => evaluateExpression(a, ctx));
    case "not":
      return !evaluateExpression(expr.arg, ctx);
    default: {
      const _exhaustive: never = expr as never;
      throw new Error(`Unknown ABAC op: ${(_exhaustive as { op: string }).op}`);
    }
  }
}

/**
 * Validate expression shape before persisting.
 * Throws on invalid structure.
 */
export function assertValidExpression(expr: unknown): asserts expr is AbacExpression {
  if (!expr || typeof expr !== "object" || !("op" in (expr as Record<string, unknown>))) {
    throw new Error("Invalid ABAC expression: missing op");
  }
  const op = (expr as { op: string }).op;
  const allowed = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "and", "or", "not", "true", "false"]);
  if (!allowed.has(op)) throw new Error(`Invalid ABAC op: ${op}`);
}
