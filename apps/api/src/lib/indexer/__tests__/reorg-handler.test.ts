import { describe, it, expect, beforeEach, vi } from "vitest";
import { Pool } from "pg";
import { ReorgHandler } from "../reorg-handler.js";

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock Pool
const mockPool = {
  connect: vi.fn(),
  query: vi.fn(),
} as unknown as Pool;

describe("ReorgHandler", () => {
  let reorgHandler: ReorgHandler;
  let mockClient: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    reorgHandler = new ReorgHandler(mockPool, mockLogger);
    
    // Mock client with transaction methods
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    
    // Mock pool.connect to return mock client
    (mockPool.connect as any).mockResolvedValue(mockClient);
  });

  describe("recordUndoLog", () => {
    it("should record an undo log entry", async () => {
      mockClient.query.mockResolvedValue({ rows: [] });
      
      await reorgHandler.recordUndoLog(
        12345,
        "indexed_escrows",
        { contract_id: "test_contract", escrow_id: "test_escrow", status: "locked" }
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO indexer_undo_logs"),
        [12345, "indexed_escrows", expect.stringContaining("contract_id")]
      );
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("should handle errors when recording undo logs", async () => {
      mockClient.query.mockRejectedValue(new Error("Database error"));
      
      await expect(
        reorgHandler.recordUndoLog(12345, "indexed_escrows", {})
      ).rejects.toThrow("Database error");
      
      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe("getUndoLogs", () => {
    it("should retrieve undo logs for a specific ledger", async () => {
      const mockUndoLogs = [
        {
          id: "1",
          ledger_sequence: 12345,
          table_name: "indexed_escrows",
          previous_row_data: { contract_id: "test" },
          created_at: new Date().toISOString(),
        },
      ];
      
      mockPool.query = vi.fn().mockResolvedValue({ rows: mockUndoLogs });
      
      const result = await reorgHandler.getUndoLogs(12345);
      
      expect(result).toHaveLength(1);
      expect(result[0].ledger_sequence).toBe(12345);
      expect(result[0].table_name).toBe("indexed_escrows");
    });

    it("should return empty array when no undo logs exist", async () => {
      mockPool.query = vi.fn().mockResolvedValue({ rows: [] });
      
      const result = await reorgHandler.getUndoLogs(99999);
      
      expect(result).toEqual([]);
    });
  });

  describe("getUndoLogsInRange", () => {
    it("should retrieve undo logs for a range of ledgers", async () => {
      const mockUndoLogs = [
        {
          id: "1",
          ledger_sequence: 12345,
          table_name: "indexed_escrows",
          previous_row_data: { contract_id: "test" },
          created_at: new Date().toISOString(),
        },
        {
          id: "2",
          ledger_sequence: 12346,
          table_name: "indexed_escrows",
          previous_row_data: { contract_id: "test2" },
          created_at: new Date().toISOString(),
        },
      ];
      
      mockPool.query = vi.fn().mockResolvedValue({ rows: mockUndoLogs });
      
      const result = await reorgHandler.getUndoLogsInRange(12345, 12346);
      
      expect(result).toHaveLength(2);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("ledger_sequence >= $1 AND ledger_sequence <= $2"),
        [12345, 12346]
      );
    });
  });

  describe("executeRollback", () => {
    it("should execute rollback successfully", async () => {
      const mockUndoLogs = [
        {
          id: "1",
          ledger_sequence: 12346,
          table_name: "indexed_escrows",
          previous_row_data: {
            contract_id: "test_contract",
            escrow_id: "test_escrow",
            status: "locked",
          },
          created_at: new Date().toISOString(),
        },
      ];

      // Mock transaction
      mockClient.query.mockImplementation((query: string, params: any[]) => {
        if (query.includes("BEGIN")) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes("MAX(ledger_sequence)")) {
          return Promise.resolve({ rows: [{ max_ledger: 12346 }] });
        }
        if (query.includes("FROM indexer_undo_logs")) {
          return Promise.resolve({ rows: mockUndoLogs });
        }
        if (query.includes("UPDATE indexed_escrows")) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes("DELETE FROM indexer_undo_logs")) {
          return Promise.resolve({ rowCount: 1 });
        }
        if (query.includes("INSERT INTO indexer_reorg_events")) {
          return Promise.resolve({ rows: [{ id: "reorg-123" }] });
        }
        if (query.includes("COMMIT")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const reorgDetection = {
        detected: true,
        fork_ledger: 12345,
        expected_parent_hash: "abc123",
        actual_parent_hash: "def456",
        rollback_depth: 1,
      };

      const result = await reorgHandler.executeRollback(12345, reorgDetection);

      expect(result.id).toBe("reorg-123");
      expect(result.fork_ledger).toBe(12345);
      expect(result.rollback_depth).toBe(1);
      expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
      expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
    });

    it("should reject rollback if depth exceeds maximum", async () => {
      mockClient.query.mockImplementation((query: string) => {
        if (query.includes("BEGIN")) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes("MAX(ledger_sequence)")) {
          return Promise.resolve({ rows: [{ max_ledger: 100 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const reorgDetection = {
        detected: true,
        fork_ledger: 50,
        rollback_depth: 50, // Exceeds MAX_ROLLBACK_DEPTH of 10
      };

      await expect(
        reorgHandler.executeRollback(50, reorgDetection)
      ).rejects.toThrow("Rollback depth 50 exceeds maximum 10");
      
      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
    });

    it("should handle rollback errors and rollback transaction", async () => {
      mockClient.query.mockImplementation((query: string) => {
        if (query.includes("BEGIN")) {
          return Promise.resolve({ rows: [] });
        }
        if (query.includes("MAX(ledger_sequence)")) {
          return Promise.reject(new Error("Database connection failed"));
        }
        return Promise.resolve({ rows: [] });
      });

      const reorgDetection = {
        detected: true,
        fork_ledger: 12345,
        rollback_depth: 1,
      };

      await expect(
        reorgHandler.executeRollback(12345, reorgDetection)
      ).rejects.toThrow();
      
      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("getRecentReorgEvents", () => {
    it("should retrieve recent reorg events", async () => {
      const mockReorgs = [
        {
          id: "1",
          detected_at: new Date().toISOString(),
          fork_ledger: 12345,
          rollback_depth: 5,
          reason: "Parent hash mismatch",
          resolved_at: new Date().toISOString(),
          resolution_details: { restored_from_snapshot: true },
        },
      ];
      
      mockPool.query = vi.fn().mockResolvedValue({ rows: mockReorgs });
      
      const result = await reorgHandler.getRecentReorgEvents(10);
      
      expect(result).toHaveLength(1);
      expect(result[0].fork_ledger).toBe(12345);
      expect(result[0].rollback_depth).toBe(5);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY detected_at DESC"),
        [10]
      );
    });
  });

  describe("markReorgResolved", () => {
    it("should mark reorg event as resolved", async () => {
      mockPool.query = vi.fn().mockResolvedValue({ rows: [] });
      
      await reorgHandler.markReorgResolved("reorg-123", {
        restored_from_snapshot: true,
        new_current_ledger: 12345,
      });
      
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE indexer_reorg_events"),
        [expect.stringContaining("restored_from_snapshot"), "reorg-123"]
      );
      expect(mockLogger.info).toHaveBeenCalled();
    });
  });

  describe("cleanupOldUndoLogs", () => {
    it("should clean up old undo logs", async () => {
      mockPool.query = vi.fn().mockResolvedValue({ rowCount: 5 });
      
      await reorgHandler.cleanupOldUndoLogs(10000);
      
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM indexer_undo_logs"),
        [10000]
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ deletedCount: 5 }),
        expect.stringContaining("Old undo logs cleaned up")
      );
    });
  });
});
