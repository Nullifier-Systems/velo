import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface ChatCapability {
  tradeId: string;
  participant: string;
  exp: number;
  nonce: string;
}

const DEFAULT_TTL_SECONDS = 60 * 60;

function secret(): string {
  const value = process.env.CHAT_CAPABILITY_SECRET;
  if (value && value.length >= 32) return value;
  if (process.env.NODE_ENV !== "production") return "velo-development-chat-secret-change-me";
  throw new Error("CHAT_CAPABILITY_SECRET must contain at least 32 characters");
}

function sign(encodedPayload: string): string {
  return createHmac("sha256", secret()).update(encodedPayload).digest("base64url");
}

export function issueChatCapability(
  tradeId: string,
  participant: string,
  ttlSeconds = Number(process.env.CHAT_CAPABILITY_TTL_SECONDS ?? DEFAULT_TTL_SECONDS),
): string {
  const payload: ChatCapability = {
    tradeId,
    participant,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: randomBytes(32).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifyChatCapability(token: string | undefined): ChatCapability | null {
  if (!token) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;

  const expected = Buffer.from(sign(encoded));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ChatCapability;
    if (
      typeof payload.tradeId !== "string" ||
      typeof payload.participant !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.nonce !== "string" ||
      payload.nonce.length < 32 ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) return null;
    return payload;
  } catch {
    return null;
  }
}
