import { describe, expect, it, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { cashRoutes } from './cash.js';
import { lockEscrow, releaseEscrow, refundEscrow } from '../lib/stellar.js';
import { clearNotificationQueue, sentNotificationsQueue } from '../lib/notification.js';
import { sendRefundAlert } from '../lib/webhook.js';

// Mock the Stellar functions to avoid real ledger/simulation calls
vi.mock('../lib/stellar.js', () => ({
  lockEscrow: vi.fn().mockResolvedValue(undefined),
  releaseEscrow: vi.fn().mockResolvedValue(undefined),
  refundEscrow: vi.fn().mockResolvedValue(undefined),
  disputeEscrow: vi.fn().mockResolvedValue(undefined),
  resolveEscrow: vi.fn().mockResolvedValue(undefined),
  buildLockEscrowTransaction: vi.fn().mockResolvedValue("dummy_unsigned_xdr"),
  submitSignedTransaction: vi.fn().mockResolvedValue({ hash: "dummy_hash", status: "SUCCESS" }),
  CONTRACTS: { testnet: { escrow: "dummy_contract" } },
}));

// Mock the webhook/refund alert function
vi.mock('../lib/webhook.js', () => ({
  sendRefundAlert: vi.fn(),
}));

describe('cashRoutes', () => {
  let app: any;

  const registerApp = (app: any) => {
    app.decorate('requirePayment', async (req: any, reply: any, priceUsdc: string) => {
      // For testing, require x-payment to be present
      const payment = req.headers['x-payment'];
      if (!payment) {
        reply.code(402).send({
          challenge: {
            amount_usdc: priceUsdc,
            pay_to: 'GBMERCHANT',
            memo: 'velo:request',
          },
        });
        return false;
      }
      return true;
    });

    app.register(cashRoutes, { prefix: '/api/v1' });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearNotificationQueue();

    app = Fastify();
    registerApp(app);
  });

  it('returns a payment challenge when no payment header is present', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/cash/agents' });
    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      challenge: {
        amount_usdc: '0.001',
      },
    });
  });

  it('creates a cash request successfully without notification opt-in', async () => {
    const body = {
      seller: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      buyer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      amount_stroops: '10000000',
      secret_hash: 'a'.repeat(64),
    };

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/request',
      headers: { 'x-payment': 'valid-payment-tx' },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toHaveProperty('claim_url');
    expect(lockEscrow).toHaveBeenCalledTimes(1);
  });

  it('creates with email opt-in and triggers email notification on release', async () => {
    const body = {
      seller: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      buyer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      amount_stroops: '25000000',
      secret_hash: 'b'.repeat(64),
      notification_type: 'email',
      contact_info: 'user@example.com',
    };

    // 1. Create request
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/request',
      headers: { 'x-payment': 'valid-payment-tx' },
      payload: body,
    });
    expect(createRes.statusCode).toBe(201);

    // Extract trade id from QR payload or claim url
    const payload = createRes.json();
    const tradeId = payload.claim_url.split('/').pop();

    // 2. Release request
    const releaseRes = await app.inject({
      method: 'POST',
      url: `/api/v1/cash/request/${tradeId}/release`,
      payload: { secret: 'c'.repeat(64) },
    });

    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.json()).toMatchObject({ status: 'released' });
    expect(releaseEscrow).toHaveBeenCalledTimes(1);

    // 3. Verify notification was sent
    expect(sentNotificationsQueue.length).toBe(1);
    expect(sentNotificationsQueue[0]).toMatchObject({
      recipient: 'user@example.com',
      type: 'email',
      subject: 'Velo Claim Update: RELEASED',
    });
    expect(sentNotificationsQueue[0].message).toContain('released');
    expect(sentNotificationsQueue[0].message).toContain('2.5'); // stroops formatted correctly
  });

  it('creates with sms opt-in and triggers sms notification on refund', async () => {
    const body = {
      seller: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      buyer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      amount_stroops: '50000000',
      secret_hash: 'd'.repeat(64),
      notification_type: 'sms',
      contact_info: '+1234567890',
    };

    // 1. Create request
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/request',
      headers: { 'x-payment': 'valid-payment-tx' },
      payload: body,
    });
    expect(createRes.statusCode).toBe(201);

    const payload = createRes.json();
    const tradeId = payload.claim_url.split('/').pop();

    // 2. Refund request
    const refundRes = await app.inject({
      method: 'POST',
      url: `/api/v1/cash/request/${tradeId}/refund`,
    });

    expect(refundRes.statusCode).toBe(200);
    expect(refundRes.json()).toMatchObject({ status: 'refunded' });
    expect(refundEscrow).toHaveBeenCalledTimes(1);

    // 3. Verify notification was sent
    expect(sentNotificationsQueue.length).toBe(1);
    expect(sentNotificationsQueue[0]).toMatchObject({
      recipient: '+1234567890',
      type: 'sms',
    });
    expect(sentNotificationsQueue[0].message).toContain('refunded');
    expect(sentNotificationsQueue[0].message).toContain('5.0'); // stroops formatted correctly
    expect(sendRefundAlert).toHaveBeenCalledTimes(1);
  });

  it('returns 400 bad request for invalid notification inputs', async () => {
    const baseBody = {
      seller: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      buyer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      amount_stroops: '10000000',
      secret_hash: 'e'.repeat(64),
    };

    // Missing contact info when opt-in is requested
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/request',
      headers: { 'x-payment': 'valid-payment-tx' },
      payload: { ...baseBody, notification_type: 'email' },
    });
    expect(res1.statusCode).toBe(400);

    // Invalid email format
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/request',
      headers: { 'x-payment': 'valid-payment-tx' },
      payload: { ...baseBody, notification_type: 'email', contact_info: 'not-an-email' },
    });
    expect(res2.statusCode).toBe(400);

    // Invalid phone number format
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/request',
      headers: { 'x-payment': 'valid-payment-tx' },
      payload: { ...baseBody, notification_type: 'sms', contact_info: '123' },
    });
    expect(res3.statusCode).toBe(400);

    // Invalid notification type
    const res4 = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/request',
      headers: { 'x-payment': 'valid-payment-tx' },
      payload: { ...baseBody, notification_type: 'push', contact_info: 'someinfo' },
    });
    expect(res4.statusCode).toBe(400);
  });

  it('rejects malformed cash request bodies with a 400 response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/request',
      headers: { 'x-payment': 'test' },
      payload: {
        seller: 'not-a-stellar-address',
        buyer: 'G123',
        amount_stroops: 'not-a-number',
        secret_hash: 'abc',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid_request',
    });
  });

  it('POST /cash/request persists qrPayload and GET /cash/request/:id returns it matching the POST response', async () => {
    const secretHash = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const postResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/request',
      headers: { 'x-payment': 'test' },
      payload: {
        seller: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        buyer: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        amount_stroops: '10000000',
        secret_hash: secretHash,
      },
    });

    expect(postResponse.statusCode).toBe(201);
    const postBody = postResponse.json();
    expect(postBody).toHaveProperty('qr_payload');

    const qrPayload = postBody.qr_payload;
    const tradeId = qrPayload.match(/request_id=([^&]+)/)?.[1];
    expect(tradeId).toBeTruthy();

    expect(qrPayload).toContain(`request_id=${tradeId}`);
    expect(qrPayload).toMatch(/contract=/);
    expect(qrPayload).not.toContain(secretHash);
    expect(qrPayload).not.toMatch(/secret=/);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/cash/request/${tradeId}`,
    });

    expect(getResponse.statusCode).toBe(200);
    const getBody = getResponse.json();
    expect(getBody).toHaveProperty('qrPayload');
    expect(getBody.qrPayload).toBe(qrPayload);
    expect(getBody).not.toHaveProperty('secretHex');
  });

  it("POST /cash/request/:id/dispute transitions status to disputed, and resolving it via admin route works", async () => {
    const app: any = Fastify();
    registerApp(app);
    const { adminRoutes } = await import("./admin.js");
    app.register(adminRoutes);

    const postResponse = await app.inject({
      method: "POST",
      url: "/api/v1/cash/request",
      headers: { "x-payment": "test" },
      payload: {
        seller: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        buyer: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        amount_stroops: "10000000",
        secret_hash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      },
    });
    expect(postResponse.statusCode).toBe(201);
    const postBody = postResponse.json();
    const tradeId = postBody.qr_payload.match(/request_id=([^&]+)/)?.[1];
    expect(tradeId).toBeTruthy();

    const disputeResponse = await app.inject({
      method: "POST",
      url: `/api/v1/cash/request/${tradeId}/dispute`,
      payload: {
        caller: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        reason: "Seller never arrived with cash",
      },
    });
    expect(disputeResponse.statusCode).toBe(200);
    const disputeBody = disputeResponse.json();
    expect(disputeBody.status).toBe("disputed");
    expect(disputeBody.disputedBy).toBe("GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");

    process.env.ADMIN_API_KEY = "test-api-key";
    
    const resolveResponse = await app.inject({
      method: "POST",
      url: `/admin/trades/${tradeId}/resolve`,
      headers: {
        "x-admin-api-key": "test-api-key",
      },
      payload: {
        resolve_to_buyer: true,
        notes: "Buyer provided proof of no-show",
      },
    });
    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json().new_status).toBe("refunded");

    await app.close();
  });
});
});
