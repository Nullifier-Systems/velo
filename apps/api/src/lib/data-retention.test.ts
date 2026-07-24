import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveCashRequest,
  clearStore,
  getCashRequest,
  type CashRequestRecord,
} from "./store.js";
import { saveMessage, getMessages, clearChatStore } from "./chat-store.js";
import { publishKey, getKey, clearKeyStore } from "./key-store.js";
import {
  saveDisputeEvidence,
  getDisputeEvidenceForTrade,
  clearDisputeEvidence,
} from "./dispute-evidence-store.js";
import {
  MemoryChatInfrastructure,
  resetChatInfrastructure,
} from "./chat-infrastructure.js";
import {
  runRetentionPurgeTick,
  startDataRetentionScheduler,
  stopDataRetentionScheduler,
  getTradeFinalizedTimestamp,
} from "./data-retention.js";

describe("Data Retention & Automated Deletion", () => {
  let memoryInfra: MemoryChatInfrastructure;

  beforeEach(() => {
    clearStore();
    clearChatStore();
    clearKeyStore();
    clearDisputeEvidence();
    resetChatInfrastructure();
    memoryInfra = new MemoryChatInfrastructure();
  });

  afterEach(() => {
    stopDataRetentionScheduler();
  });

  function createTestTrade(
    id: string,
    status: CashRequestRecord["status"],
    daysAgo: number
  ): CashRequestRecord {
    const pastTime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const trade: CashRequestRecord = {
      id,
      contractId: "C123456789",
      seller: "GSELLER123",
      buyer: "GBUYER123",
      amountStroops: "10000000",
      secretHex: "00".repeat(32),
      secretHashHex: "11".repeat(32),
      qrPayload: "velo:claim:123",
      status,
      createdAt: pastTime,
      resolvedAt: status === "released" || status === "refunded" ? pastTime : undefined,
    };
    saveCashRequest(trade);
    return trade;
  }

  it("calculates trade finalization timestamp correctly", () => {
    const nowISO = new Date().toISOString();
    const resolvedISO = new Date(Date.now() - 5000).toISOString();

    const tradeWithResolved: CashRequestRecord = {
      id: "t-1",
      contractId: "c1",
      seller: "s1",
      buyer: "b1",
      amountStroops: "100",
      secretHex: "sec",
      secretHashHex: "hash",
      qrPayload: "qr",
      status: "released",
      createdAt: nowISO,
      resolvedAt: resolvedISO,
    };

    expect(getTradeFinalizedTimestamp(tradeWithResolved)).toEqual(Date.parse(resolvedISO));
  });

  it("deletes chat history and peer keys older than 30 days for terminal trades", async () => {
    const expiredTrade = createTestTrade("trade-expired-chat", "released", 35);

    // Save chat messages in store & infrastructure
    saveMessage({
      tradeId: expiredTrade.id,
      sender: expiredTrade.buyer,
      ciphertext: "encrypted_chat_content_1",
      nonce: "nonce1",
    });
    await memoryInfra.saveMessage({
      tradeId: expiredTrade.id,
      sender: expiredTrade.seller,
      ciphertext: "encrypted_chat_content_2",
      nonce: "nonce2",
    });

    // Publish peer key
    publishKey(expiredTrade.id, expiredTrade.buyer, "pubkey_buyer_base64");
    await memoryInfra.setKey(expiredTrade.id, expiredTrade.buyer, "pubkey_buyer_base64");

    // Run purge tick
    const result = await runRetentionPurgeTick({
      chatRetentionMs: 30 * 24 * 60 * 60 * 1000,
      disputeEvidenceRetentionMs: 90 * 24 * 60 * 60 * 1000,
      infrastructure: memoryInfra,
    });

    expect(result.purgedChats).toBeGreaterThan(0);
    expect(result.purgedChatTrades).toBe(1);

    // Verify messages and keys are purged
    expect(getMessages(expiredTrade.id)).toHaveLength(0);
    expect(await memoryInfra.getMessages(expiredTrade.id)).toHaveLength(0);
    expect(getKey(expiredTrade.id, expiredTrade.buyer)).toBeNull();
    expect(await memoryInfra.getKey(expiredTrade.id, expiredTrade.buyer)).toBeNull();
  });

  it("preserves chat history and evidence for active or recent trades within the retention window", async () => {
    const activeTrade = createTestTrade("trade-active", "locked", 40); // 40d old but active
    const recentTrade = createTestTrade("trade-recent", "released", 10); // 10d old (within 30d window)

    // Populate active trade
    saveMessage({
      tradeId: activeTrade.id,
      sender: activeTrade.buyer,
      ciphertext: "active_chat",
      nonce: "nonceA",
    });
    saveDisputeEvidence({
      tradeId: activeTrade.id,
      uploadedBy: activeTrade.buyer,
      fileName: "active.png",
      contentType: "image/png",
      data: Buffer.from("fake_png_data"),
    });

    // Populate recent trade
    saveMessage({
      tradeId: recentTrade.id,
      sender: recentTrade.seller,
      ciphertext: "recent_chat",
      nonce: "nonceR",
    });
    saveDisputeEvidence({
      tradeId: recentTrade.id,
      uploadedBy: recentTrade.seller,
      fileName: "recent.png",
      contentType: "image/png",
      data: Buffer.from("fake_png_data_recent"),
    });

    const result = await runRetentionPurgeTick({
      chatRetentionMs: 30 * 24 * 60 * 60 * 1000,
      disputeEvidenceRetentionMs: 90 * 24 * 60 * 60 * 1000,
      infrastructure: memoryInfra,
    });

    expect(result.purgedChats).toBe(0);
    expect(result.purgedEvidence).toBe(0);

    // Verify records remain intact
    expect(getMessages(activeTrade.id)).toHaveLength(1);
    expect(getDisputeEvidenceForTrade(activeTrade.id)).toHaveLength(1);

    expect(getMessages(recentTrade.id)).toHaveLength(1);
    expect(getDisputeEvidenceForTrade(recentTrade.id)).toHaveLength(1);
  });

  it("deletes dispute evidence older than 90 days for refunded/released trades", async () => {
    const oldDisputedTrade = createTestTrade("trade-old-dispute", "refunded", 100);

    saveDisputeEvidence({
      tradeId: oldDisputedTrade.id,
      uploadedBy: oldDisputedTrade.buyer,
      fileName: "bank_receipt.jpg",
      contentType: "image/jpeg",
      data: Buffer.from("jpg_bytes"),
    });

    const mockPgQuery = vi.fn().mockResolvedValue({ rowCount: 1 });

    const result = await runRetentionPurgeTick({
      chatRetentionMs: 30 * 24 * 60 * 60 * 1000,
      disputeEvidenceRetentionMs: 90 * 24 * 60 * 60 * 1000,
      pg: { query: mockPgQuery },
      infrastructure: memoryInfra,
    });

    expect(result.purgedEvidence).toBeGreaterThan(0);
    expect(result.purgedEvidenceTrades).toBe(1);
    expect(getDisputeEvidenceForTrade(oldDisputedTrade.id)).toHaveLength(0);
    expect(mockPgQuery).toHaveBeenCalledWith(
      "DELETE FROM dispute_evidence WHERE trade_id = $1",
      [oldDisputedTrade.id]
    );
  });

  it("maintains trade record and account integrity after chat and evidence purge", async () => {
    const expiredTrade = createTestTrade("trade-integrity-check", "released", 120);

    saveMessage({
      tradeId: expiredTrade.id,
      sender: expiredTrade.buyer,
      ciphertext: "secret_chat_message",
      nonce: "n1",
    });
    saveDisputeEvidence({
      tradeId: expiredTrade.id,
      uploadedBy: expiredTrade.buyer,
      fileName: "evidence.jpg",
      contentType: "image/jpeg",
      data: Buffer.from("image_bytes"),
    });

    await runRetentionPurgeTick({
      chatRetentionMs: 30 * 24 * 60 * 60 * 1000,
      disputeEvidenceRetentionMs: 90 * 24 * 60 * 60 * 1000,
      infrastructure: memoryInfra,
    });

    // Chat and evidence are deleted
    expect(getMessages(expiredTrade.id)).toHaveLength(0);
    expect(getDisputeEvidenceForTrade(expiredTrade.id)).toHaveLength(0);

    // Trade record ITSELF remains 100% intact for audit and reputation scoring
    const persistedTrade = getCashRequest(expiredTrade.id);
    expect(persistedTrade).toBeDefined();
    expect(persistedTrade?.id).toBe(expiredTrade.id);
    expect(persistedTrade?.seller).toBe(expiredTrade.seller);
    expect(persistedTrade?.buyer).toBe(expiredTrade.buyer);
    expect(persistedTrade?.status).toBe("released");
    expect(persistedTrade?.amountStroops).toBe("10000000");
  });

  it("logs audit records without leaking sensitive message content or image data", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const expiredTrade = createTestTrade("trade-audit-log", "released", 40);

    const sensitiveMessage = "super secret meeting location 123 Main St";
    saveMessage({
      tradeId: expiredTrade.id,
      sender: expiredTrade.buyer,
      ciphertext: sensitiveMessage,
      nonce: "n1",
    });

    await runRetentionPurgeTick({
      chatRetentionMs: 30 * 24 * 60 * 60 * 1000,
      disputeEvidenceRetentionMs: 90 * 24 * 60 * 60 * 1000,
      infrastructure: memoryInfra,
    });

    const logs = consoleSpy.mock.calls.map((call) => call.join(" "));
    const auditLogs = logs.filter((l) => l.includes("[data-retention]"));

    expect(auditLogs.length).toBeGreaterThan(0);
    // Audit log contains count and trade ID
    expect(auditLogs.some((l) => l.includes("Purged chat history (1 message(s)) for trade trade-audit-log"))).toBe(true);

    // Audit log NEVER contains sensitive plaintext/ciphertext or file data
    for (const logLine of logs) {
      expect(logLine).not.includes(sensitiveMessage);
    }

    consoleSpy.mockRestore();
  });

  it("starts and stops the scheduler without throwing", () => {
    expect(() => startDataRetentionScheduler(10000)).not.toThrow();
    expect(() => stopDataRetentionScheduler()).not.toThrow();
  });
});
