/**
 * Distributed Multi-Node Webhook Event Delivery Engine & DLQ — store (#445).
 *
 * Backs `webhook_endpoints` and `webhook_delivery_logs` (migration 030).
 * Mirrors `SwapDisputeStore`'s shape: an optional `Pool` with an in-memory
 * fallback, so unit and route tests run with no database.
 *
 * DLQ replay is the one operation that needs real concurrency safety — an
 * operator and a retry sweep could both try to replay the same dead-lettered
 * delivery. `claimDeadLetterForReplay` takes `SELECT ... FOR UPDATE` and only
 * flips `DEAD_LETTER -> QUEUED` for the row it locked, so a delivery is ever
 * re-enqueued once per replay call no matter how many callers race.
 */
import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import type { WebhookDeliveryStatus } from "@velo/shared";

export interface WebhookEndpointRecord {
  endpointId: string;
  userId: string;
  targetUrl: string;
  secretKey: string;
  isActive: boolean;
  createdAt: string;
}

export interface WebhookDeliveryLogRecord {
  deliveryId: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signatureHeader: string;
  attemptCount: number;
  status: WebhookDeliveryStatus;
  lastResponseCode: number | null;
  createdAt: string;
}

interface EndpointRow {
  endpoint_id: string;
  user_id: string;
  target_url: string;
  secret_key: string;
  is_active: boolean;
  created_at: string;
}

interface DeliveryRow {
  delivery_id: string;
  endpoint_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  signature_header: string;
  attempt_count: number;
  status: WebhookDeliveryStatus;
  last_response_code: number | null;
  created_at: string;
}

function rowToEndpoint(row: EndpointRow): WebhookEndpointRecord {
  return {
    endpointId: row.endpoint_id,
    userId: row.user_id,
    targetUrl: row.target_url,
    secretKey: row.secret_key,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

function rowToDelivery(row: DeliveryRow): WebhookDeliveryLogRecord {
  return {
    deliveryId: row.delivery_id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    payload: row.payload,
    signatureHeader: row.signature_header,
    attemptCount: Number(row.attempt_count),
    status: row.status,
    lastResponseCode: row.last_response_code,
    createdAt: row.created_at,
  };
}

const ENDPOINT_COLUMNS = `endpoint_id, user_id, target_url, secret_key, is_active, created_at`;
const DELIVERY_COLUMNS = `delivery_id, endpoint_id, event_type, payload, signature_header, attempt_count, status, last_response_code, created_at`;

function generateSecretKey(): string {
  // 32 raw bytes, hex-encoded (64 chars) — matches secret_key VARCHAR(64).
  return randomBytes(32).toString("hex");
}

function generateUuid(): string {
  return randomBytes(16).toString("hex").replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    "$1-$2-$3-$4-$5",
  );
}

export class WebhookDeliveryStore {
  private readonly pool: Pool | null;
  private readonly endpoints = new Map<string, WebhookEndpointRecord>();
  private readonly deliveries = new Map<string, WebhookDeliveryLogRecord>();

  constructor(pool: Pool | null = null) {
    this.pool = pool;
  }

  async registerEndpoint(input: { userId: string; targetUrl: string }): Promise<WebhookEndpointRecord> {
    const secretKey = generateSecretKey();

    if (!this.pool) {
      const endpoint: WebhookEndpointRecord = {
        endpointId: generateUuid(),
        userId: input.userId,
        targetUrl: input.targetUrl,
        secretKey,
        isActive: true,
        createdAt: new Date().toISOString(),
      };
      this.endpoints.set(endpoint.endpointId, endpoint);
      return { ...endpoint };
    }

    const { rows } = await this.pool.query<EndpointRow>(
      `INSERT INTO webhook_endpoints (user_id, target_url, secret_key)
       VALUES ($1, $2, $3)
       RETURNING ${ENDPOINT_COLUMNS}`,
      [input.userId, input.targetUrl, secretKey],
    );
    return rowToEndpoint(rows[0]);
  }

  async listActiveEndpoints(userId: string): Promise<WebhookEndpointRecord[]> {
    if (!this.pool) {
      return [...this.endpoints.values()]
        .filter((endpoint) => endpoint.userId === userId && endpoint.isActive)
        .map((endpoint) => ({ ...endpoint }));
    }
    const { rows } = await this.pool.query<EndpointRow>(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE user_id = $1 AND is_active = TRUE`,
      [userId],
    );
    return rows.map(rowToEndpoint);
  }

  async getEndpoint(endpointId: string): Promise<WebhookEndpointRecord | null> {
    if (!this.pool) {
      const endpoint = this.endpoints.get(endpointId);
      return endpoint ? { ...endpoint } : null;
    }
    const { rows } = await this.pool.query<EndpointRow>(
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE endpoint_id = $1`,
      [endpointId],
    );
    return rows[0] ? rowToEndpoint(rows[0]) : null;
  }

  async createDeliveryLog(input: {
    endpointId: string;
    eventType: string;
    payload: Record<string, unknown>;
    signatureHeader: string;
  }): Promise<WebhookDeliveryLogRecord> {
    if (!this.pool) {
      const log: WebhookDeliveryLogRecord = {
        deliveryId: generateUuid(),
        endpointId: input.endpointId,
        eventType: input.eventType,
        payload: input.payload,
        signatureHeader: input.signatureHeader,
        attemptCount: 0,
        status: "QUEUED",
        lastResponseCode: null,
        createdAt: new Date().toISOString(),
      };
      this.deliveries.set(log.deliveryId, log);
      return { ...log };
    }

    const { rows } = await this.pool.query<DeliveryRow>(
      `INSERT INTO webhook_delivery_logs (endpoint_id, event_type, payload, signature_header)
       VALUES ($1, $2, $3, $4)
       RETURNING ${DELIVERY_COLUMNS}`,
      [input.endpointId, input.eventType, JSON.stringify(input.payload), input.signatureHeader],
    );
    return rowToDelivery(rows[0]);
  }

  async getDelivery(deliveryId: string): Promise<WebhookDeliveryLogRecord | null> {
    if (!this.pool) {
      const log = this.deliveries.get(deliveryId);
      return log ? { ...log } : null;
    }
    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_delivery_logs WHERE delivery_id = $1`,
      [deliveryId],
    );
    return rows[0] ? rowToDelivery(rows[0]) : null;
  }

  async listDeliveries(endpointId: string, limit = 50): Promise<WebhookDeliveryLogRecord[]> {
    if (!this.pool) {
      return [...this.deliveries.values()]
        .filter((log) => log.endpointId === endpointId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit)
        .map((log) => ({ ...log }));
    }
    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_delivery_logs
        WHERE endpoint_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [endpointId, limit],
    );
    return rows.map(rowToDelivery);
  }

  /** Records the outcome of one delivery attempt (worker-side). */
  async recordAttempt(
    deliveryId: string,
    outcome: { status: WebhookDeliveryStatus; lastResponseCode: number | null },
  ): Promise<void> {
    if (!this.pool) {
      const log = this.deliveries.get(deliveryId);
      if (!log) return;
      log.attemptCount += 1;
      log.status = outcome.status;
      log.lastResponseCode = outcome.lastResponseCode;
      return;
    }
    await this.pool.query(
      `UPDATE webhook_delivery_logs
          SET attempt_count = attempt_count + 1,
              status = $2,
              last_response_code = $3
        WHERE delivery_id = $1`,
      [deliveryId, outcome.status, outcome.lastResponseCode],
    );
  }

  /**
   * Atomically claims a dead-lettered delivery for replay, moving it back to
   * QUEUED. Returns null (no-op) if the delivery does not exist or is not
   * currently DEAD_LETTER — so a duplicate replay call, or one racing the
   * worker's own retry, only ever re-enqueues the delivery once.
   */
  async claimDeadLetterForReplay(deliveryId: string): Promise<WebhookDeliveryLogRecord | null> {
    if (!this.pool) {
      const log = this.deliveries.get(deliveryId);
      if (!log || log.status !== "DEAD_LETTER") return null;
      log.status = "QUEUED";
      return { ...log };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<DeliveryRow>(
        `SELECT ${DELIVERY_COLUMNS} FROM webhook_delivery_logs WHERE delivery_id = $1 FOR UPDATE`,
        [deliveryId],
      );
      const row = rows[0];
      if (!row || row.status !== "DEAD_LETTER") {
        await client.query("ROLLBACK");
        return null;
      }
      const { rows: updated } = await client.query<DeliveryRow>(
        `UPDATE webhook_delivery_logs SET status = 'QUEUED' WHERE delivery_id = $1
         RETURNING ${DELIVERY_COLUMNS}`,
        [deliveryId],
      );
      await client.query("COMMIT");
      return rowToDelivery(updated[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
