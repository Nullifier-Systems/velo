import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDb, clearAllData, putMessage, getMessages, enqueueOp, getPendingOps, updateOpStatus, getOpCount } from "../store";
import { createMessage } from "../crdt";

describe("SyncStore", () => {
  beforeEach(async () => {
    await clearAllData();
  });

  describe("messages", () => {
    it("stores and retrieves messages", async () => {
      const msg = createMessage("t1", "m1", "alice", "enc", "nonce", "c1");
      await putMessage(msg);
      const result = await getMessages("t1");
      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe("m1");
    });

    it("retrieves by tradeId", async () => {
      const m1 = createMessage("t1", "m1", "a", "e1", "n1", "c1");
      const m2 = createMessage("t2", "m2", "b", "e2", "n2", "c2");
      await putMessage(m1);
      await putMessage(m2);
      const t1messages = await getMessages("t1");
      expect(t1messages).toHaveLength(1);
    });
  });

  describe("queue", () => {
    it("enqueues and lists pending ops", async () => {
      await enqueueOp({
        endpoint: "/release",
        method: "POST",
        body: '{"secret":"abc"}',
        idempotencyKey: "key-1",
        status: "pending",
      });
      const pending = await getPendingOps();
      expect(pending).toHaveLength(1);
      expect(pending[0].endpoint).toBe("/release");
    });

    it("marks op as done", async () => {
      const id = await enqueueOp({
        endpoint: "/test",
        method: "POST",
        idempotencyKey: "key-2",
        status: "pending",
      });
      await updateOpStatus(id, "done");
      const pending = await getPendingOps();
      expect(pending).toHaveLength(0);
    });

    it("getOpCount returns pending count", async () => {
      await enqueueOp({ endpoint: "/a", method: "POST", idempotencyKey: "k1", status: "pending" });
      await enqueueOp({ endpoint: "/b", method: "POST", idempotencyKey: "k2", status: "pending" });
      expect(await getOpCount()).toBe(2);
    });
  });
});
