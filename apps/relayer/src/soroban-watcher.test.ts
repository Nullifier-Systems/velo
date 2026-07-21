import { describe, expect, it } from 'vitest';
import { nativeToScVal } from '@stellar/stellar-sdk';
import type { Server } from '@stellar/stellar-sdk/rpc';
import { decodeReleasedEvent, SorobanWatcher } from './soroban-watcher.js';

const ID_HEX = '11'.repeat(32);
const SECRET_HEX = '22'.repeat(32);

function releasedEventScVals() {
  return {
    topic: [
      nativeToScVal('released', { type: 'symbol' }),
      nativeToScVal(Buffer.from(ID_HEX, 'hex'), { type: 'bytes' }),
    ],
    value: nativeToScVal(Buffer.from(SECRET_HEX, 'hex'), { type: 'bytes' }),
    ledger: 42,
  };
}

describe('decodeReleasedEvent', () => {
  it('decodes a released event into trade id and 0x-prefixed secret', () => {
    const decoded = decodeReleasedEvent(releasedEventScVals());
    expect(decoded).not.toBeNull();
    expect(decoded!.tradeId).toBe(ID_HEX);
    expect(decoded!.secret).toBe(`0x${SECRET_HEX}`);
    expect(decoded!.ledger).toBe(42);
  });

  it('accepts base64 XDR string topics/value (raw RPC shape)', () => {
    const scv = releasedEventScVals();
    const decoded = decodeReleasedEvent({
      topic: [scv.topic[0].toXDR('base64'), scv.topic[1].toXDR('base64')],
      value: scv.value.toXDR('base64'),
      ledger: 7,
    });
    expect(decoded!.tradeId).toBe(ID_HEX);
    expect(decoded!.secret).toBe(`0x${SECRET_HEX}`);
  });

  it('returns null for a non-released event', () => {
    const decoded = decodeReleasedEvent({
      topic: [
        nativeToScVal('locked', { type: 'symbol' }),
        nativeToScVal(Buffer.from(ID_HEX, 'hex'), { type: 'bytes' }),
      ],
      value: nativeToScVal(500, { type: 'i128' }),
    });
    expect(decoded).toBeNull();
  });

  it('returns null when topics or value are missing/malformed', () => {
    expect(decodeReleasedEvent({ topic: [], value: undefined })).toBeNull();
    expect(
      decodeReleasedEvent({ topic: [nativeToScVal('released', { type: 'symbol' })] })
    ).toBeNull();
  });
});

describe('SorobanWatcher.pollOnce', () => {
  it('fetches, decodes released events, and advances the ledger cursor', async () => {
    const scv = releasedEventScVals();
    let getEventsCalls = 0;
    const fakeServer = {
      getLatestLedger: async () => ({ sequence: 100 }),
      getEvents: async (args: { startLedger: number }) => {
        getEventsCalls += 1;
        expect(args.startLedger).toBe(100); // first poll starts from latest
        return { events: [scv], latestLedger: 105 };
      },
    } as unknown as Server;

    const watcher = new SorobanWatcher(fakeServer, { contractId: 'CTEST' });
    const first = await watcher.pollOnce();
    expect(first).toHaveLength(1);
    expect(first[0].secret).toBe(`0x${SECRET_HEX}`);

    // Second poll should resume from latestLedger + 1, not the latest again.
    const fakeServer2 = fakeServer as unknown as {
      getEvents: (a: { startLedger: number }) => Promise<unknown>;
    };
    fakeServer2.getEvents = async (args: { startLedger: number }) => {
      expect(args.startLedger).toBe(106);
      return { events: [], latestLedger: 106 };
    };
    const second = await watcher.pollOnce();
    expect(second).toHaveLength(0);
    expect(getEventsCalls).toBe(1);
  });
});
