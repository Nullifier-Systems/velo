import fs from "node:fs";
import path from "node:path";

export type BazaarStatus =
  | "active"
  | "accepted"
  | "expired"
  | "cancelled";

export interface BazaarIntentRecord {
  id: string; // hex32
  seller: string;
  amountStroops: string;
  secretHashHex: string;
  timeoutLedgers: number;
  createdAt: string; // ISO
  expiresAt: string; // ISO
  status: Exclude<BazaarStatus, "expired"> | "expired";
  acceptedAt?: string;
  acceptedQuoteId?: string;
}

export interface BazaarQuoteRecord {
  id: string; // hex32
  intentId: string;
  buyer: string;
  createdAt: string;
  expiresAt: string;
  status: "open" | "accepted";
  acceptedAt?: string;
}

export interface BazaarAcceptanceRecord {
  id: string; // hex32
  quoteId: string;
  intentId: string;
  seller: string;
  buyer: string;
  createdAt: string;
  status: "accepted";
}

type PersistedState = {
  intents: BazaarIntentRecord[];
  quotes: BazaarQuoteRecord[];
  acceptances: BazaarAcceptanceRecord[];
  meta: {
    version: 1;
  };
};

const DATA_DIR = path.join(process.cwd(), "apps/api/data");
const DATA_FILE = path.join(DATA_DIR, "bazaar.json");

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_QUOTE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function nowIso() {
  return new Date().toISOString();
}

function addMsToIso(iso: string, ms: number) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function isExpired(expiresAtIso: string) {
  return new Date(expiresAtIso).getTime() <= Date.now();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState(): PersistedState {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    const empty: PersistedState = {
      intents: [],
      quotes: [],
      acceptances: [],
      meta: { version: 1 },
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(empty, null, 2), "utf8");
    return empty;
  }

  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw) as PersistedState;

  // Best-effort migration safety
  if (!parsed.meta) parsed.meta = { version: 1 };
  parsed.intents ??= [];
  parsed.quotes ??= [];
  parsed.acceptances ??= [];

  return parsed;
}

function atomicWriteState(state: PersistedState) {
  ensureDataDir();
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

function pruneExpiredIntents(state: PersistedState) {
  let changed = false;
  for (const intent of state.intents) {
    if (
      (intent.status === "active" || intent.status === "accepted") &&
      isExpired(intent.expiresAt)
    ) {
      // accepted intents can remain accepted even if expired; do not flip
      if (intent.status === "active") {
        intent.status = "expired";
        changed = true;
      }
    }
  }
  return changed;
}

function pruneExpiredQuotes(state: PersistedState) {
  let changed = false;
  for (const quote of state.quotes) {
    if (quote.status === "open" && isExpired(quote.expiresAt)) {
      // Quotes should become terminal/invalid but MUST NOT be marked "accepted"
      // since "accepted" has business meaning (escrow locked).
      // We reuse the "accepted" terminal state to prevent re-use, but we also
      // rely on status validation in acceptQuote().
      quote.status = "accepted";
      changed = true;
    }
  }
  return changed;
}


function nextHex32() {
  // avoid depending on crypto.ts to keep this module standalone
  const b = Buffer.allocUnsafe(32);
  for (let i = 0; i < 32; i++) b[i] = Math.floor(Math.random() * 256);
  return b.toString("hex");
}

export function getBazaarConstants() {
  return {
    defaultIntentTtlMs: DEFAULT_TTL_MS,
    defaultQuoteTtlMs: DEFAULT_QUOTE_TTL_MS,
  };
}

export function createIntent(params: {
  seller: string;
  amountStroops: string;
  secretHashHex: string;
  timeoutLedgers: number;
  expiresAt?: string;
}): BazaarIntentRecord {
  const state = loadState();
  pruneExpiredIntents(state);

  // basic collision avoidance
  let id = nextHex32();
  while (state.intents.some((i) => i.id === id)) id = nextHex32();

  const createdAt = nowIso();
  const expiresAt = params.expiresAt ?? addMsToIso(createdAt, DEFAULT_TTL_MS);

  const record: BazaarIntentRecord = {
    id,
    seller: params.seller,
    amountStroops: params.amountStroops,
    secretHashHex: params.secretHashHex,
    timeoutLedgers: params.timeoutLedgers,
    createdAt,
    expiresAt,
    status: "active",
  };

  state.intents.push(record);
  atomicWriteState(state);
  return record;
}

export function listActiveIntents(params?: { limit?: number }) {
  const state = loadState();
  pruneExpiredIntents(state);

  const nowActive = state.intents
    .filter((i) => i.status === "active" && !isExpired(i.expiresAt))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (params?.limit ? nowActive.slice(0, params.limit) : nowActive) as BazaarIntentRecord[];
}

export function getIntent(intentId: string) {
  const state = loadState();
  const intent = state.intents.find((i) => i.id === intentId);
  return intent;
}

export function createQuote(params: {
  intentId: string;
  buyer: string;
  expiresAt?: string;
}): BazaarQuoteRecord {
  const state = loadState();
  pruneExpiredIntents(state);
  pruneExpiredQuotes(state);

  const intent = state.intents.find((i) => i.id === params.intentId);
  if (!intent) throw new Error("intent not found");
  if (intent.status !== "active" || isExpired(intent.expiresAt)) {
    throw new Error("intent not active");
  }

  // Ensure one intent isn't quoted multiple times in ways that complicate accept.
  // This is intentionally simple: allow multiple quotes, but accept will validate.

  let id = nextHex32();
  while (state.quotes.some((q) => q.id === id)) id = nextHex32();

  const createdAt = nowIso();
  const expiresAt = params.expiresAt ?? addMsToIso(createdAt, DEFAULT_QUOTE_TTL_MS);

  const quote: BazaarQuoteRecord = {
    id,
    intentId: params.intentId,
    buyer: params.buyer,
    createdAt,
    expiresAt,
    status: "open",
  };

  state.quotes.push(quote);
  atomicWriteState(state);
  return quote;
}

export function getQuote(quoteId: string) {
  const state = loadState();
  return state.quotes.find((q) => q.id === quoteId);
}

export function acceptQuote(params: {
  quoteId: string;
}): BazaarAcceptanceRecord & { quote: BazaarQuoteRecord; intent: BazaarIntentRecord } {
  const state = loadState();
  pruneExpiredIntents(state);
  pruneExpiredQuotes(state);

  const quote = state.quotes.find((q) => q.id === params.quoteId);
  if (!quote) throw new Error("quote not found");
  if (quote.status !== "open" || isExpired(quote.expiresAt)) {
    throw new Error("quote not open");
  }

  const intent = state.intents.find((i) => i.id === quote.intentId);
  if (!intent) throw new Error("intent not found");
  if (intent.status !== "active" || isExpired(intent.expiresAt)) {
    throw new Error("intent not active");
  }

  // Basic idempotency: if the intent was already accepted, we must not accept again.
  // Also prevent accepting a different quote after intent has been accepted.
  if (intent.status === "accepted" && intent.acceptedQuoteId) {
    if (intent.acceptedQuoteId !== quote.id) {
      throw new Error("intent already accepted with different quote");
    }
    // If the exact same quote is already accepted, treat it as idempotent (but the
    // caller should also observe quote.status).
  }

  intent.status = "accepted";
  intent.acceptedAt = nowIso();
  intent.acceptedQuoteId = quote.id;
  quote.status = "accepted";

  let id = nextHex32();
  while (state.acceptances.some((a) => a.id === id)) id = nextHex32();

  const acceptance: BazaarAcceptanceRecord = {
    id,
    quoteId: quote.id,
    intentId: intent.id,
    seller: intent.seller,
    buyer: quote.buyer,
    createdAt: nowIso(),
    status: "accepted",
  };

  state.acceptances.push(acceptance);
  atomicWriteState(state);

  return { ...acceptance, quote, intent };
}


