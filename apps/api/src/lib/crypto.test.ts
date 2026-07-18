import { describe, it, expect } from 'vitest';
import { randomHex32, generateSecretPair } from './crypto.js';
import { createHash } from 'node:crypto';

describe('randomHex32', () => {
  it('should return a 64-character hex string', () => {
    const result = randomHex32();
    expect(result).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result)).toBe(true);
  });

  it('should generate unique values on each call', () => {
    const a = randomHex32();
    const b = randomHex32();
    expect(a).not.toBe(b);
  });

  it('should return a string type', () => {
    expect(typeof randomHex32()).toBe('string');
  });
});

describe('generateSecretPair', () => {
  it('should return secretHex and secretHashHex', () => {
    const pair = generateSecretPair();
    expect(pair).toHaveProperty('secretHex');
    expect(pair).toHaveProperty('secretHashHex');
  });

  it('secretHex should be 64-character hex', () => {
    const pair = generateSecretPair();
    expect(pair.secretHex).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(pair.secretHex)).toBe(true);
  });

  it('secretHashHex should be 64-character hex', () => {
    const pair = generateSecretPair();
    expect(pair.secretHashHex).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(pair.secretHashHex)).toBe(true);
  });

  it('secretHashHex should match SHA-256 of secretHex', () => {
    const pair = generateSecretPair();
    const expectedHash = createHash('sha256')
      .update(Buffer.from(pair.secretHex, 'hex'))
      .digest('hex');
    expect(pair.secretHashHex).toBe(expectedHash);
  });

  it('should generate unique pairs on each call', () => {
    const a = generateSecretPair();
    const b = generateSecretPair();
    expect(a.secretHex).not.toBe(b.secretHex);
    expect(a.secretHashHex).not.toBe(b.secretHashHex);
  });
});
