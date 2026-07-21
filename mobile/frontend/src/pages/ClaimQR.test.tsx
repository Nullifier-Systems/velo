import { describe, expect, it } from 'vitest';

function statusLabel(status: 'locked' | 'released' | 'refunded'): string {
  if (status === 'locked') return 'Ready to claim';
  if (status === 'released') return 'Released';
  return 'Refunded';
}

function buildQrPayload(id: string, secret: string | null, contractId: string): string | null {
  if (!secret) return null;
  return `velo://claim?request_id=${id}&secret=${secret}&contract=${contractId}`;
}

describe('ClaimQR logic and status formatting', () => {
  it('formats status labels correctly for physical counter display', () => {
    expect(statusLabel('locked')).toBe('Ready to claim');
    expect(statusLabel('released')).toBe('Released');
    expect(statusLabel('refunded')).toBe('Refunded');
  });

  it('constructs valid QR payload for provider scanning', () => {
    const payload = buildQrPayload('req_123', 'sec_456', 'C1234567890');
    expect(payload).toBe('velo://claim?request_id=req_123&secret=sec_456&contract=C1234567890');
  });

  it('returns null QR payload when secret is absent', () => {
    const payload = buildQrPayload('req_123', null, 'C1234567890');
    expect(payload).toBeNull();
  });
});
