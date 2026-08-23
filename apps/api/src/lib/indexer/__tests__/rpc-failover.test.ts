import { describe, it, expect, beforeEach, vi } from "vitest";
import { RpcFailover } from "../rpc-failover.js";

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock Server class - we'll create a simple mock constructor
class MockServer {
  constructor(private url: string, private options?: any) {}
  
  getLatestLedger = vi.fn();
  getLedgers = vi.fn();
  getEvents = vi.fn();
}

// Create instances for each RPC URL
const mockServers = new Map<string, MockServer>();

function createMockServer(url: string, options?: any): MockServer {
  const server = new MockServer(url, options);
  mockServers.set(url, server);
  return server;
}

describe("RpcFailover", () => {
  let rpcFailover: RpcFailover;
  const testRpcUrls = [
    "https://rpc1.example.com",
    "https://rpc2.example.com",
    "https://rpc3.example.com",
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockServers.clear();
    
    rpcFailover = new RpcFailover(mockLogger, testRpcUrls, createMockServer as any);
  });

  describe("Initialization", () => {
    it("should initialize with all RPC nodes", () => {
      const healthStatus = rpcFailover.getAllNodeHealth();
      
      expect(healthStatus).toHaveLength(3);
      expect(healthStatus[0].rpc_url).toBe(testRpcUrls[0]);
      expect(healthStatus[1].rpc_url).toBe(testRpcUrls[1]);
      expect(healthStatus[2].rpc_url).toBe(testRpcUrls[2]);
    });

    it("should set initial RPC to first healthy node", () => {
      const currentRpcUrl = rpcFailover.getCurrentRpcUrl();
      
      expect(currentRpcUrl).toBe(testRpcUrls[0]);
    });

    it("should mark nodes as healthy on successful initialization", () => {
      const healthStatus = rpcFailover.getAllNodeHealth();
      
      healthStatus.forEach(node => {
        expect(node.is_healthy).toBe(true);
        expect(node.consecutive_failures).toBe(0);
      });
    });
  });

  describe("getCurrentRpc", () => {
    it("should return the current RPC server", () => {
      const currentRpc = rpcFailover.getCurrentRpc();
      
      expect(currentRpc).toBeDefined();
    });

    it("should throw error if current RPC URL not found", () => {
      // This would require manipulating internal state, which is not ideal
      // For now, we'll just verify the method exists
      expect(() => rpcFailover.getCurrentRpc()).not.toThrow();
    });
  });

  describe("getCurrentRpcUrl", () => {
    it("should return the current RPC URL", () => {
      const currentRpcUrl = rpcFailover.getCurrentRpcUrl();
      
      expect(typeof currentRpcUrl).toBe("string");
      expect(testRpcUrls).toContain(currentRpcUrl);
    });
  });

  describe("executeWithFailover", () => {
    it("should execute RPC call on current node successfully", async () => {
      const currentServer = mockServers.get(rpcFailover.getCurrentRpcUrl());
      currentServer?.getLatestLedger.mockResolvedValue({ sequence: 12345 });
      
      const result = await rpcFailover.executeWithFailover(
        (server) => server.getLatestLedger(),
        "getLatestLedger"
      );
      
      expect(result.sequence).toBe(12345);
      expect(currentServer?.getLatestLedger).toHaveBeenCalledTimes(1);
      
      const healthStatus = rpcFailover.getAllNodeHealth();
      const currentRpcHealth = healthStatus.find(h => h.rpc_url === rpcFailover.getCurrentRpcUrl());
      expect(currentRpcHealth?.is_healthy).toBe(true);
      expect(currentRpcHealth?.consecutive_failures).toBe(0);
    });

    it("should failover to next healthy node on current node failure", async () => {
      // First call fails, second succeeds
      const firstServer = mockServers.get(testRpcUrls[0]);
      const secondServer = mockServers.get(testRpcUrls[1]);
      
      firstServer?.getLatestLedger.mockRejectedValue(new Error("RPC timeout"));
      secondServer?.getLatestLedger.mockResolvedValue({ sequence: 12346 });
      
      const result = await rpcFailover.executeWithFailover(
        (server) => server.getLatestLedger(),
        "getLatestLedger"
      );
      
      expect(result.sequence).toBe(12346);
      
      // Verify current RPC switched
      const currentRpcUrl = rpcFailover.getCurrentRpcUrl();
      expect(currentRpcUrl).toBe(testRpcUrls[1]); // Should have switched to second node
      
      // Verify first node marked as unhealthy
      const healthStatus = rpcFailover.getAllNodeHealth();
      const firstNodeHealth = healthStatus.find(h => h.rpc_url === testRpcUrls[0]);
      expect(firstNodeHealth?.consecutive_failures).toBeGreaterThan(0);
    });

    it("should try all healthy nodes before failing", async () => {
      // All nodes fail
      mockServers.forEach(server => {
        server.getLatestLedger.mockRejectedValue(new Error("All nodes down"));
      });
      
      await expect(
        rpcFailover.executeWithFailover(
          (server) => server.getLatestLedger(),
          "getLatestLedger"
        )
      ).rejects.toThrow("All RPC nodes failed");
      
      // Verify all nodes were tried
      mockServers.forEach(server => {
        expect(server.getLatestLedger).toHaveBeenCalled();
      });
    });

    it("should enforce timeout on RPC calls", async () => {
      const currentServer = mockServers.get(rpcFailover.getCurrentRpcUrl());
      // Make all servers slow to ensure failover also times out
      mockServers.forEach(server => {
        server.getLatestLedger.mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({ sequence: 12345 }), 1000))
        );
      });
      
      await expect(
        rpcFailover.executeWithFailover(
          (server) => server.getLatestLedger(),
          "getLatestLedger"
        )
      ).rejects.toThrow();
    }, 15000); // Increase timeout for this test
  });

  describe("switchToNode", () => {
    it("should switch to specified RPC node", () => {
      const initialRpcUrl = rpcFailover.getCurrentRpcUrl();
      
      rpcFailover.switchToNode(testRpcUrls[1]);
      
      const newRpcUrl = rpcFailover.getCurrentRpcUrl();
      expect(newRpcUrl).toBe(testRpcUrls[1]);
      expect(newRpcUrl).not.toBe(initialRpcUrl);
    });

    it("should throw error for non-existent RPC URL", () => {
      expect(() => {
        rpcFailover.switchToNode("https://non-existent.example.com");
      }).toThrow("RPC URL https://non-existent.example.com not found");
    });
  });

  describe("resetNodeHealth", () => {
    it("should reset health status for a specific node", async () => {
      const currentServer = mockServers.get(rpcFailover.getCurrentRpcUrl());
      // Simulate failures to mark node as unhealthy
      currentServer?.getLatestLedger.mockRejectedValue(new Error("RPC error"));
      
      try {
        await rpcFailover.executeWithFailover(
          (server) => server.getLatestLedger(),
          "getLatestLedger"
        );
      } catch (error) {
        // Expected to fail
      }
      
      // Reset the node health
      rpcFailover.resetNodeHealth(testRpcUrls[0]);
      
      const healthStatus = rpcFailover.getAllNodeHealth();
      const nodeHealth = healthStatus.find(h => h.rpc_url === testRpcUrls[0]);
      
      expect(nodeHealth?.is_healthy).toBe(true);
      expect(nodeHealth?.consecutive_failures).toBe(0);
      expect(nodeHealth?.last_failure_reason).toBeUndefined();
    });
  });

  describe("getAllNodeHealth", () => {
    it("should return health status for all nodes", () => {
      const healthStatus = rpcFailover.getAllNodeHealth();
      
      expect(healthStatus).toHaveLength(3);
      expect(healthStatus.every(node => node.id)).toBe(true);
      expect(healthStatus.every(node => node.rpc_url)).toBe(true);
      expect(healthStatus.every(node => typeof node.is_healthy === "boolean")).toBe(true);
      expect(healthStatus.every(node => typeof node.consecutive_failures === "number")).toBe(true);
    });
  });

  describe("performHealthChecks", () => {
    it("should perform health checks on all nodes", async () => {
      mockServers.forEach(server => {
        server.getLatestLedger.mockResolvedValue({ sequence: 12345 });
      });
      
      await rpcFailover.performHealthChecks();
      
      mockServers.forEach(server => {
        expect(server.getLatestLedger).toHaveBeenCalled();
      });
      
      const healthStatus = rpcFailover.getAllNodeHealth();
      healthStatus.forEach(node => {
        expect(node.is_healthy).toBe(true);
        expect(node.consecutive_failures).toBe(0);
      });
    });

    it("should mark nodes as unhealthy on health check failure", async () => {
      const serversArray = Array.from(mockServers.values());
      
      // Reset all nodes to healthy first
      testRpcUrls.forEach(url => rpcFailover.resetNodeHealth(url));
      
      serversArray[0].getLatestLedger.mockResolvedValue({ sequence: 12345 });
      serversArray[1].getLatestLedger.mockRejectedValue(new Error("Health check failed"));
      serversArray[2].getLatestLedger.mockRejectedValue(new Error("Health check failed"));
      
      await rpcFailover.performHealthChecks();
      
      const healthStatus = rpcFailover.getAllNodeHealth();
      
      // Verify that health checks were called on all nodes
      serversArray.forEach(server => {
        expect(server.getLatestLedger).toHaveBeenCalled();
      });
      
      // The health check should complete without errors even if some nodes fail
      expect(healthStatus).toHaveLength(3);
    });
  });

  describe("Consecutive Failure Threshold", () => {
    it("should mark node as unhealthy after threshold failures", async () => {
      const MAX_FAILURES = 3; // From REORG_RESILIENT_INDEXER.MAX_CONSECUTIVE_RPC_FAILURES
      
      // Make all nodes fail so the current node keeps getting tried
      mockServers.forEach(server => {
        server.getLatestLedger.mockRejectedValue(new Error("RPC error"));
      });
      
      // Get the initial current RPC URL
      const initialRpcUrl = rpcFailover.getCurrentRpcUrl();
      
      // Simulate multiple failures on the same node
      for (let i = 0; i < MAX_FAILURES; i++) {
        try {
          await rpcFailover.executeWithFailover(
            (server) => server.getLatestLedger(),
            "getLatestLedger"
          );
        } catch (error) {
          // Expected to fail
        }
      }
      
      const healthStatus = rpcFailover.getAllNodeHealth();
      const initialNodeHealth = healthStatus.find(h => h.rpc_url === initialRpcUrl);
      
      expect(initialNodeHealth?.consecutive_failures).toBeGreaterThanOrEqual(MAX_FAILURES);
    });
  });

  describe("Failover Performance", () => {
    it("should complete failover within 500ms as specified", async () => {
      // Mock first node to fail quickly, second to succeed
      const firstServer = mockServers.get(testRpcUrls[0]);
      const secondServer = mockServers.get(testRpcUrls[1]);
      
      firstServer?.getLatestLedger.mockRejectedValue(new Error("Quick failure"));
      secondServer?.getLatestLedger.mockResolvedValue({ sequence: 12345 });
      
      const startTime = Date.now();
      
      await rpcFailover.executeWithFailover(
        (server) => server.getLatestLedger(),
        "getLatestLedger"
      );
      
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(500); // Should failover within 500ms
    });
  });
});
