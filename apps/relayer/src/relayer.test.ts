import { describe, expect, it } from 'vitest';
import { Relayer, type RelayerLogger } from './relayer.js';
import type { EvmHtlcClient } from './evm-htlc.js';
import type { ReleasedEvent, SorobanWatcher } from './soroban-watcher.js';

const silent: RelayerLogger = { info: () => {}, error: () => {} };
const noopWatcher = {} as unknown as SorobanWatcher;

function evt(overrides: Partial<ReleasedEvent> = {}): ReleasedEvent {
  return { tradeId: 'aa'.repeat(32), secret: `0x${'bb'.repeat(32)}`, ledger: 1, ...overrides };
}

describe('Relayer.handleReleased', () => {
  it('claims the EVM leg by submitting withdraw(secret)', async () => {
    const calls: string[] = [];
    const evm: EvmHtlcClient = {
      withdraw: async (secret) => {
        calls.push(secret);
        return '0xtxhash';
      },
    };
    const relayer = new Relayer(noopWatcher, evm, silent);

    const result = await relayer.handleReleased(evt());
    expect(result.status).toBe('claimed');
    expect(result.txHash).toBe('0xtxhash');
    expect(calls).toEqual([`0x${'bb'.repeat(32)}`]);
  });

  it('is idempotent per secret — a re-delivered event does not double-claim', async () => {
    const calls: string[] = [];
    const evm: EvmHtlcClient = {
      withdraw: async (secret) => {
        calls.push(secret);
        return '0xtxhash';
      },
    };
    const relayer = new Relayer(noopWatcher, evm, silent);

    await relayer.handleReleased(evt());
    const second = await relayer.handleReleased(evt());
    expect(second.status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });

  it('reports failure and allows a retry on a later delivery', async () => {
    let shouldFail = true;
    const calls: string[] = [];
    const evm: EvmHtlcClient = {
      withdraw: async (secret) => {
        calls.push(secret);
        if (shouldFail) throw new Error('rpc down');
        return '0xok';
      },
    };
    const relayer = new Relayer(noopWatcher, evm, silent);

    const failed = await relayer.handleReleased(evt());
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('rpc down');

    shouldFail = false;
    const retried = await relayer.handleReleased(evt());
    expect(retried.status).toBe('claimed');
    expect(calls).toHaveLength(2);
  });
});
