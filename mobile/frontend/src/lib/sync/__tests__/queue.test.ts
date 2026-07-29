import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearAllData, enqueueOp, getPendingOps, updateOpStatus } from "../store";

// Mock global fetch for queue flush tests
const mockFetch = vi.fn();

describe("MutationQueue", () => {
  beforeEach(async () => {
    await clearAllData();
    vi.clearAllMocks();
  });

  it("enqueues operations in order", async () => {
    await enqueueOp({ endpoint: "/first", method: "GET", idempotencyKey: "k1", status: "pending" });
    await enqueueOp({ endpoint: "/second", method: "POST", idempotencyKey: "k2", status: "pending" });
    const pending = await getPendingOps();
    expect(pending).toHaveLength(2);
    expect(pending[0].endpoint).toBe("/first");
  });

  it("marks operations as done on success", async () => {
    const id = await enqueueOp({ endpoint: "/ok", method: "POST", idempotencyKey: "k3", status: "pending" });
    await updateOpStatus(id, "done");
    const pending = await getPendingOps();
    expect(pending).toHaveLength(0);
  });

  it("marks operations as failed after max retries", async () => {
    const id = await enqueueOp({ endpoint: "/fail", method: "POST", idempotencyKey: "k4", status: "pending" });
    await updateOpStatus(id, "failed", 3);
    const pending = await getPendingOps();
    expect(pending).toHaveLength(0);
  });

  it("keeps operation pending if retry count is under limit", async () => {
    const id = await enqueueOp({ endpoint: "/retry", method: "POST", idempotencyKey: "k5", status: "pending" });
    await updateOpStatus(id, "pending", 1);
    const pending = await getPendingOps();
    expect(pending).toHaveLength(1);
  });

  it("flush calls fetch with idempotency key header", async () => {
    // Simulate flush logic
    const { flushQueue } = await import("../queue");
    await enqueueOp({ endpoint: "/flush-test", method: "POST", body: '{"x":1}', idempotencyKey: "k6", status: "pending" });

    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await flushQueue(mockFetch, "http://localhost:3000");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/flush-test",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-idempotency-key": "k6" }),
      }),
    );
    expect(result.succeeded).toBe(1);
  });
});
