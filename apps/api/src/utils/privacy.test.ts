import { describe, expect, it } from 'vitest';
import type { ProviderRecord } from '../lib/store.js';
import { toPublicProvider, withinRadius, applyKAnonymity, distanceBand } from './privacy.js';
import { encodeGeohash } from './geohash.js';

function provider(id: string, lat: number, lng: number): ProviderRecord {
  return {
    id,
    stellarAddress: `G_${id}`,
    name: `Provider ${id}`,
    lat,
    lng,
    tier: 'Standard',
    rate: '1.0',
    status: 'available',
    kycStatus: 'approved',
    createdAt: new Date().toISOString(),
  };
}

describe('privacy generalization', () => {
  const p = provider('a', 6.52447, 3.37921); // exact coords

  it('never exposes exact coordinates', () => {
    const pub = toPublicProvider(p, { lat: 6.53, lng: 3.38 });
    // The exact stored coordinates must not appear anywhere in the public view.
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain('6.52447');
    expect(serialized).not.toContain('3.37921');
    expect((pub as any).lat).toBeUndefined();
    expect((pub as any).lng).toBeUndefined();
    expect(pub.geohash).toBe(encodeGeohash(p.lat, p.lng, 6));
  });

  it('returns the cell centroid, not the real point', () => {
    const pub = toPublicProvider(p);
    // Centroid differs from the exact coordinate (it is the cell center).
    expect(pub.approx_lat).not.toBe(p.lat);
    expect(pub.approx_lng).not.toBe(p.lng);
  });

  describe('adversary: cannot localize below one cell', () => {
    it('two providers in the same cell are indistinguishable in public view', () => {
      const p1 = provider('x', 6.52447, 3.37921);
      const p2 = provider('y', 6.52501, 3.3798); // ~80 m away, same cell
      expect(encodeGeohash(p1.lat, p1.lng, 6)).toBe(encodeGeohash(p2.lat, p2.lng, 6));

      const q = { lat: 6.6, lng: 3.4 };
      const v1 = toPublicProvider(p1, q);
      const v2 = toPublicProvider(p2, q);
      expect(v1.geohash).toBe(v2.geohash);
      expect(v1.approx_lat).toBe(v2.approx_lat);
      expect(v1.approx_lng).toBe(v2.approx_lng);
      expect(v1.distance_band).toBe(v2.distance_band);
    });

    it('sweeping the query point yields a step function that changes only at cell boundaries', () => {
      // As the adversary moves their query across the provider's cell, the
      // reported band is constant while they stay within one query cell, so they
      // cannot binary-search the provider's exact position.
      const bandsWithinOneQueryCell = new Set<string>();
      for (let d = 0; d < 0.005; d += 0.001) {
        const v = toPublicProvider(p, { lat: 6.6 + d, lng: 3.4 });
        bandsWithinOneQueryCell.add(v.distance_band!);
      }
      // All these query points snap to the same query cell => identical band.
      expect(bandsWithinOneQueryCell.size).toBe(1);
    });
  });

  it('distanceBand is monotonic and coarse', () => {
    expect(distanceBand(0.4)).toBe('<1km');
    expect(distanceBand(1.5)).toBe('1-2km');
    expect(distanceBand(4)).toBe('2-5km');
    expect(distanceBand(9)).toBe('5-10km');
    expect(distanceBand(50)).toBe('>25km');
  });

  it('withinRadius filters at cell granularity', () => {
    const near = provider('near', 6.53, 3.38);
    const far = provider('far', 7.5, 4.5);
    const result = withinRadius([near, far], { lat: 6.52, lng: 3.37 }, 5);
    const ids = result.map((r) => r.id);
    expect(ids).toContain('near');
    expect(ids).not.toContain('far');
  });

  it('k-anonymity suppresses lone cells when k > 1', () => {
    const solo = toPublicProvider(provider('solo', 10, 10));
    const pair1 = toPublicProvider(provider('p1', 6.5244, 3.3792));
    const pair2 = toPublicProvider(provider('p2', 6.525, 3.3798)); // same cell as p1
    const filtered = applyKAnonymity([solo, pair1, pair2], 2);
    const ids = filtered.map((x) => x.id);
    expect(ids).not.toContain('solo');
    expect(ids).toEqual(expect.arrayContaining(['p1', 'p2']));
  });
});
