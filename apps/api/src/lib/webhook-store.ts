/**
 * Webhook Storage Layer (Issue #445)
 *
 * Backs webhook endpoint registration, event delivery logs, and DLQ replay.
 * Uses PostgreSQL when pool is provided, with an in-memory fallback for local dev / tests.
 */
import type { Pool, PoolClient } from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import type {
  WebhookDeliveryLog,
  WebhookDeliveryStatus,
  WebhookEndpoint,
} from "@velo/shared";

export interface CreateEndpointInput {
  userId: string;
  targetUrl: string;
  secretKey?: string;
  isActive?: boolean;
}

export interface CreateDeliveryLogInput {
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signatureHeader: string;
  status?: WebhookDeliveryStatus;
  attemptCount?: number;
  lastResponseCode?: number | null;
}

export interface ReplayDlqInput {
  deliveryIds?: string[];
  endpointId?: string;
  all?: boolean;
}

export interface ReplayDlqResult {
  replayed: number;
  deliveryIds: string[];
  logs: WebhookDeliveryLog[];
}

interface WebhookEndpointRow {
  endpoint_id: string;
  user_id: string;
  target_url: string;
  secret_key: string;
  is_active: boolean;
  created_at: Date | string;
}

interface WebhookDeliveryLogRow {
  delivery_id: string;
  endpoint_id: string;
  event_type: string;
  payload: any;
  signature_header: string;
  attempt_count: number;
  status: WebhookDeliveryStatus;
  last_response_code: number | null;
  created_at: Date | string;
}

function rowToEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    endpointId: row.endpoint_id,
    userId: row.user_id,
    targetUrl: row.target_url,
    secretKey: row.secret_key,
    isActive: Boolean(row.is_active),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

function rowToDeliveryLog(row: WebhookDeliveryLogRow): WebhookDeliveryLog {
  const payload =
    typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return {
    deliveryId: row.delivery_id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    payload,
    signatureHeader: row.signature_header,
    attemptCount: Number(row.attempt_count),
    status: row.status,
    lastResponseCode:
      row.last_response_code !== null && row.last_response_code !== undefined
        ? Number(row.last_response_code)
        : null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

export class WebhookStore {
  private memoryEndpoints: Map<string, WebhookEndpoint> = new Map();
  private memoryLogs: Map<string, WebhookDeliveryLog> = new Map();

  constructor(private readonly pool?: Pick<Pool, "connect" | "query">) {}

  /** Generates a 32-byte secret key in hex format (64 chars). */
  generateSecretKey(): string {
    return randomBytes(32).toString("hex");
  }

  async createEndpoint(input: CreateEndpointInput): Promise<WebhookEndpoint> {
    const secretKey = input.secretKey || this.generateSecretKey();
    const isActive = input.isActive ?? true;

    if (!this.pool) {
      const endpointId = randomUUID();
      const endpoint: WebhookEndpoint = {
        endpointId,
        userId: input.userId,
        targetUrl: input.targetUrl,
        secretKey,
        isActive,
        createdAt: new Date().toISOString(),
      };
      this.memoryEndpoints.set(endpointId, endpoint);
      return endpoint;
    }

    const { rows } = await this.pool.query<WebhookEndpointRow>(
      `INSERT INTO webhook_endpoints (user_id, target_url, secret_key, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING endpoint_id, user_id, target_url, secret_key, is_active, created_at`,
      [input.userId, input.targetUrl, secretKey, isActive],
    );

    return rowToEndpoint(rows[0]);
  }

  async getEndpoint(endpointId: string): Promise<WebhookEndpoint | null> {
    if (!this.pool) {
      return this.memoryEndpoints.get(endpointId) ?? null;
    }

    const { rows } = await this.pool.query<WebhookEndpointRow>(
      `SELECT endpoint_id, user_id, target_url, secret_key, is_active, created_at
       FROM webhook_endpoints WHERE endpoint_id = $1`,
      [endpointId],
    );

    return rows[0] ? rowToEndpoint(rows[0]) : null;
  }

  async listEndpoints(userId?: string): Promise<WebhookEndpoint[]> {
    if (!this.pool) {
      let list = Array.from(this.memoryEndpoints.values());
      if (userId) {
        list = list.filter((e) => e.userId === userId);
      }
      return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    const query = userId
      ? `SELECT endpoint_id, user_id, target_url, secret_key, is_active, created_at
         FROM webhook_endpoints WHERE user_id = $1 ORDER BY created_at DESC`
      : `SELECT endpoint_id, user_id, target_url, secret_key, is_active, created_at
         FROM webhook_endpoints ORDER BY created_at DESC`;
    const params = userId ? [userId] : [];

    const { rows } = await this.pool.query<WebhookEndpointRow>(query, params);
    return rows.map(rowToEndpoint);
  }

  async findActiveEndpointsForUser(userId?: string): Promise<WebhookEndpoint[]> {
    if (!this.pool) {
      let list = Array.from(this.memoryEndpoints.values()).filter(
        (e) => e.isActive,
      );
      if (userId) {
        list = list.filter((e) => e.userId === userId);
      }
      return list;
    }

    const query = userId
      ? `SELECT endpoint_id, user_id, target_url, secret_key, is_active, created_at
         FROM webhook_endpoints WHERE is_active = TRUE AND user_id = $1 ORDER BY created_at DESC`
      : `SELECT endpoint_id, user_id, target_url, secret_key, is_active, created_at
         FROM webhook_endpoints WHERE is_active = TRUE ORDER BY created_at DESC`;
    const params = userId ? [userId] : [];

    const { rows } = await this.pool.query<WebhookEndpointRow>(query, params);
    return rows.map(rowToEndpoint);
  }

  async createDeliveryLog(
    input: CreateDeliveryLogInput,
  ): Promise<WebhookDeliveryLog> {
    const status: WebhookDeliveryStatus = input.status ?? "QUEUED";
    const attemptCount = input.attemptCount ?? 0;
    const lastResponseCode = input.lastResponseCode ?? null;

    if (!this.pool) {
      const deliveryId = randomUUID();
      const log: WebhookDeliveryLog = {
        deliveryId,
        endpointId: input.endpointId,
        eventType: input.eventType,
        payload: input.payload,
        signatureHeader: input.signatureHeader,
        attemptCount,
        status,
        lastResponseCode,
        createdAt: new Date().toISOString(),
      };
      this.memoryLogs.set(deliveryId, log);
      return log;
    }

    const { rows } = await this.pool.query<WebhookDeliveryLogRow>(
      `INSERT INTO webhook_delivery_logs (
         endpoint_id, event_type, payload, signature_header, attempt_count, status, last_response_code
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING delivery_id, endpoint_id, event_type, payload, signature_header,
                 attempt_count, status, last_response_code, created_at`,
      [
        input.endpointId,
        input.eventType,
        JSON.stringify(input.payload),
        input.signatureHeader,
        attemptCount,
        status,
        lastResponseCode,
      ],
    );

    return rowToDeliveryLog(rows[0]);
  }

  async getDeliveryLog(deliveryId: string): Promise<WebhookDeliveryLog | null> {
    if (!this.pool) {
      return this.memoryLogs.get(deliveryId) ?? null;
    }

    const { rows } = await this.pool.query<WebhookDeliveryLogRow>(
      `SELECT delivery_id, endpoint_id, event_type, payload, signature_header,
              attempt_count, status, last_response_code, created_at
       FROM webhook_delivery_logs WHERE delivery_id = $1`,
      [deliveryId],
    );

    return rows[0] ? rowToDeliveryLog(rows[0]) : null;
  }

  async updateDeliveryStatus(
    deliveryId: string,
    status: WebhookDeliveryStatus,
    attemptCount: number,
    lastResponseCode: number | null,
  ): Promise<WebhookDeliveryLog | null> {
    if (!this.pool) {
      const log = this.memoryLogs.get(deliveryId);
      if (!log) return null;
      log.status = status;
      log.attemptCount = attemptCount;
      log.lastResponseCode = lastResponseCode;
      return { ...log };
    }

    const { rows } = await this.pool.query<WebhookDeliveryLogRow>(
      `UPDATE webhook_delivery_logs
       SET status = $2, attempt_count = $3, last_response_code = $4
       WHERE delivery_id = $1
       RETURNING delivery_id, endpoint_id, event_type, payload, signature_header,
                 attempt_count, status, last_response_code, created_at`,
      [deliveryId, status, attemptCount, lastResponseCode],
    );

    return rows[0] ? rowToDeliveryLog(rows[0]) : null;
  }

  async listDeliveryLogs(filter?: {
    endpointId?: string;
    userId?: string;
    status?: WebhookDeliveryStatus;
    limit?: number;
  }): Promise<WebhookDeliveryLog[]> {
    if (!this.pool) {
      let list = Array.from(this.memoryLogs.values());
      if (filter?.endpointId) {
        list = list.filter((l) => l.endpointId === filter.endpointId);
      }
      if (filter?.status) {
        list = list.filter((l) => l.status === filter.status);
      }
      if (filter?.userId) {
        const userEndpointIds = new Set(
          Array.from(this.memoryEndpoints.values())
            .filter((e) => e.userId === filter.userId)
            .map((e) => e.endpointId),
        );
        list = list.filter((l) => userEndpointIds.has(l.endpointId));
      }
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (filter?.limit && filter.limit > 0) {
        list = list.slice(0, filter.limit);
      }
      return list;
    }

    let query = `
      SELECT l.delivery_id, l.endpoint_id, l.event_type, l.payload, l.signature_header,
             l.attempt_count, l.status, l.last_response_code, l.created_at
      FROM webhook_delivery_logs l
      JOIN webhook_endpoints e ON l.endpoint_id = e.endpoint_id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (filter?.endpointId) {
      params.push(filter.endpointId);
      query += ` AND l.endpoint_id = $${params.length}`;
    }
    if (filter?.userId) {
      params.push(filter.userId);
      query += ` AND e.user_id = $${params.length}`;
    }
    if (filter?.status) {
      params.push(filter.status);
      query += ` AND l.status = $${params.length}`;
    }

    query += ` ORDER BY l.created_at DESC`;

    if (filter?.limit && filter.limit > 0) {
      params.push(filter.limit);
      query += ` LIMIT $${params.length}`;
    }

    const { rows } = await this.pool.query<WebhookDeliveryLogRow>(query, params);
    return rows.map(rowToDeliveryLog);
  }

  /**
   * Replays dead-letter deliveries with pessimistic DB lock (`SELECT FOR UPDATE`).
   * Atomically resets status to 'QUEUED' and attempt_count to 0.
   */
  async replayDlqDeliveries(input: ReplayDlqInput): Promise<ReplayDlqResult> {
    if (!this.pool) {
      const logsToReplay: WebhookDeliveryLog[] = [];
      const deliveryIdSet = input.deliveryIds ? new Set(input.deliveryIds) : null;

      for (const log of this.memoryLogs.values()) {
        if (log.status !== "DEAD_LETTER" && log.status !== "FAILED") continue;
        if (deliveryIdSet && !deliveryIdSet.has(log.deliveryId)) continue;
        if (input.endpointId && log.endpointId !== input.endpointId) continue;
        if (!deliveryIdSet && !input.endpointId && !input.all) continue;

        log.status = "QUEUED";
        log.attemptCount = 0;
        log.lastResponseCode = null;
        logsToReplay.push({ ...log });
      }

      return {
        replayed: logsToReplay.length,
        deliveryIds: logsToReplay.map((l) => l.deliveryId),
        logs: logsToReplay,
      };
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      let selectQuery = `
        SELECT delivery_id, endpoint_id, event_type, payload, signature_header,
               attempt_count, status, last_response_code, created_at
        FROM webhook_delivery_logs
        WHERE status IN ('DEAD_LETTER', 'FAILED')
      `;
      const selectParams: any[] = [];

      if (input.deliveryIds && input.deliveryIds.length > 0) {
        selectParams.push(input.deliveryIds);
        selectQuery += ` AND delivery_id = ANY($${selectParams.length}::uuid[])`;
      } else if (input.endpointId) {
        selectParams.push(input.endpointId);
        selectQuery += ` AND endpoint_id = $${selectParams.length}::uuid`;
      } else if (!input.all) {
        // If neither deliveryIds, endpointId, nor all is specified, nothing to replay
        await client.query("ROLLBACK");
        return { replayed: 0, deliveryIds: [], logs: [] };
      }

      selectQuery += ` FOR UPDATE`;

      const { rows: lockedRows } = await client.query<WebhookDeliveryLogRow>(
        selectQuery,
        selectParams,
      );

      if (lockedRows.length === 0) {
        await client.query("COMMIT");
        return { replayed: 0, deliveryIds: [], logs: [] };
      }

      const lockedIds = lockedRows.map((r) => r.delivery_id);

      const { rows: updatedRows } = await client.query<WebhookDeliveryLogRow>(
        `UPDATE webhook_delivery_logs
         SET status = 'QUEUED', attempt_count = 0, last_response_code = NULL
         WHERE delivery_id = ANY($1::uuid[])
         RETURNING delivery_id, endpoint_id, event_type, payload, signature_header,
                   attempt_count, status, last_response_code, created_at`,
        [lockedIds],
      );

      await client.query("COMMIT");

      const logs = updatedRows.map(rowToDeliveryLog);
      return {
        replayed: logs.length,
        deliveryIds: logs.map((l) => l.deliveryId),
        logs,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  clearMemory(): void {
    this.memoryEndpoints.clear();
    this.memoryLogs.clear();
  }
}
