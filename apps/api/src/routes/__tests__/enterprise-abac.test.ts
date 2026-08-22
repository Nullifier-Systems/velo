import { describe, it, expect } from "vitest";
import { evaluateExpression } from "../../lib/abac/policy-engine.js";
import { PolicyEvaluator } from "../../lib/abac/policy-evaluator.js";

describe("ABAC policy engine", () => {
  it("evaluates eq / and / or / not / gte correctly", () => {
    expect(evaluateExpression({ op: "eq", left: "role", right: "admin" }, { role: "admin" })).toBe(true);
    expect(evaluateExpression({ op: "eq", left: "role", right: "admin" }, { role: "viewer" })).toBe(false);
    expect(evaluateExpression({ op: "gte", left: "amount", right: 100 }, { amount: 150 })).toBe(true);
    expect(evaluateExpression({ op: "and", args: [{ op: "eq", left: "a", right: 1 }, { op: "gt", left: "b", right: 0 }] }, { a: 1, b: 2 })).toBe(true);
    expect(evaluateExpression({ op: "or", args: [{ op: "eq", left: "a", right: 1 }, { op: "eq", left: "b", right: 2 }] }, { a: 9, b: 2 })).toBe(true);
    expect(evaluateExpression({ op: "not", arg: { op: "eq", left: "x", right: 1 } }, { x: 1 })).toBe(false);
    expect(evaluateExpression({ op: "in", left: "role", right: ["admin", "ops"] }, { role: "ops" })).toBe(true);
  });

  it("evaluates nested context via dot path", () => {
    expect(evaluateExpression({ op: "eq", left: "user.role", right: "approver" }, { user: { role: "approver" } })).toBe(true);
  });

  it("PolicyEvaluator deny-by-default and allow when matching", async () => {
    const policies = [
      { id: "1", tenant_id: "t1", role: "approver", action: "approve", expression: { op: "eq", left: "level", right: "high" } as const },
    ];
    const ev = new PolicyEvaluator(PolicyEvaluator.memoryStore(policies as never));
    expect(await ev.isAllowed({ tenantId: "t1", role: "approver", action: "approve", context: { level: "high" } })).toBe(true);
    expect(await ev.isAllowed({ tenantId: "t1", role: "approver", action: "approve", context: { level: "low" } })).toBe(false);
    expect(await ev.isAllowed({ tenantId: "t1", role: "viewer", action: "approve", context: { level: "high" } })).toBe(false);
    expect(await ev.isAllowed({ tenantId: "t2", role: "approver", action: "approve", context: { level: "high" } })).toBe(false);
  });

  it("tenant isolation: different tenant cannot match", async () => {
    const policies = [{ id: "1", tenant_id: "t1", role: "admin", action: "release", expression: { op: "true" } as const }];
    const ev = new PolicyEvaluator(PolicyEvaluator.memoryStore(policies as never));
    expect(await ev.isAllowed({ tenantId: "t2", role: "admin", action: "release", context: {} })).toBe(false);
  });
});
