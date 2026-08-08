import { describe, expect, it, vi } from "vitest";
import { PostgresEventStore } from "./stellar-event-store.js";

describe("PostgresEventStore append-only rollback", () => {
  it("changes canonical pointers without updating or deleting historical event rows", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("SELECT ledger_sequence, ledger_hash")) {
          return { rows: [{ ledger_sequence: 10, ledger_hash: "hash-10" }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const store = new PostgresEventStore({
      connect: async () => client,
      query: vi.fn(),
    } as any);

    await store.rollbackAfter(10);

    expect(statements.some((sql) =>
      sql.startsWith("DELETE FROM stellar_canonical_events"),
    )).toBe(true);
    expect(statements.some((sql) =>
      /(?:UPDATE|DELETE FROM|TRUNCATE) stellar_contract_events/i.test(sql),
    )).toBe(false);
    expect(statements.some((sql) =>
      sql.includes("JOIN stellar_canonical_events"),
    )).toBe(true);
    expect(client.query).toHaveBeenLastCalledWith("COMMIT");
  });
});
