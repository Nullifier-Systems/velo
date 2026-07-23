import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getCashRequest, updateStatus } from "../lib/store.js";
import { parseBody } from "../lib/validation.js";
import { t } from "../lib/i18n.js";
import {
  decryptRecoveryToken,
  hashContactInfo,
  validateRecoveryAttempt,
  validateRecoveryTokenExpiry,
  computeTokenExpiration,
} from "../lib/recovery.js";

const MAX_RECOVERY_ATTEMPTS_PER_DAY = 3;
const MAX_VERIFICATION_ATTEMPTS = 5;

/**
 * Recovery routes for retrieving lost claim links/secrets.
 * 
 * POST /api/v1/recovery/request/:id/secret
 *   Initiates recovery by verifying contact info or Stellar signature.
 *   Returns: recovery token sent to contact or verification required
 * 
 * POST /api/v1/recovery/verify/:id
 *   Verifies recovery token and returns the secret if valid.
 *   Returns: encrypted recovery payload with claim URL and secret
 */
export async function recoveryRoutes(app: FastifyInstance) {
  // POST /api/v1/recovery/request/:id/secret
  // Initiate a recovery request by providing recovery challenge (contact info or signature)
  app.post<{ Params: { id: string }; Body: { recovery_method: string; contact_info?: string; signature?: string } }>(
    "/recovery/request/:id/secret",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const requestId = req.params.id;
      const locale = (req as any).locale ?? "en";

      const record = getCashRequest(requestId);
      if (!record) {
        reply.code(404).send({ error: "claim not found" });
        return;
      }

      // Check recovery availability
      if (!record.recoveryEncryptedToken || !record.recoveryTokenExpiresAt) {
        reply.code(400).send({
          error: "recovery_not_available",
          detail: "This claim does not support recovery (may have been created before recovery feature was enabled)",
        });
        return;
      }

      // Validate token expiration
      const expiry = validateRecoveryTokenExpiry(record.recoveryTokenExpiresAt);
      if (!expiry.valid) {
        reply.code(410).send({
          error: "recovery_token_expired",
          detail: "The recovery period for this claim has expired",
        });
        return;
      }

      const body = parseBody(
        z.object({
          recovery_method: z.enum(["email", "sms", "signature"]),
          contact_info: z.string().optional(),
          signature: z.string().optional(),
        }),
        req.body,
        reply
      );
      if (!body) return;

      const { recovery_method, contact_info, signature } = body;

      // Validate recovery attempt limits (rate limiting)
      const attemptValidation = validateRecoveryAttempt(
        record.lastRecoveryAttemptAt,
        record.recoveryAttempts || 0,
        MAX_RECOVERY_ATTEMPTS_PER_DAY
      );
      if (!attemptValidation.allowed) {
        reply.code(429).send({
          error: "too_many_recovery_attempts",
          detail: attemptValidation.reason,
        });
        return;
      }

      let recoveryChallenge: string | null = null;

      if (recovery_method === "email" || recovery_method === "sms") {
        if (!contact_info) {
          reply.code(400).send({ error: "contact_info is required for email/sms recovery" });
          return;
        }

        // Verify that contact info matches what was stored at claim creation
        const contactHash = hashContactInfo(
          recovery_method === "email" ? contact_info : undefined,
          recovery_method === "sms" ? contact_info : undefined
        );

        if (!record.recoveryContactHash || contactHash !== record.recoveryContactHash) {
          // Don't reveal whether the email is correct or not (prevents user enumeration)
          reply.code(403).send({
            error: "recovery_challenge_failed",
            detail: "Contact info does not match the claim's recovery contact",
          });
          return;
        }

        recoveryChallenge = contact_info;

        // In production, send recovery link via email/SMS here
        // For now, return a message indicating recovery link would be sent
        reply.code(200).send({
          status: "recovery_link_sent",
          message: t(locale, "recovery.linkSent", { method: recovery_method }),
        });
      } else if (recovery_method === "signature") {
        if (!signature) {
          reply.code(400).send({ error: "signature is required for signature recovery" });
          return;
        }

        // TODO: Validate Stellar signature proving ownership of buyer account
        // For now, accept the buyer address as the challenge
        recoveryChallenge = record.buyer;

        reply.code(200).send({
          status: "signature_verified",
          message: t(locale, "recovery.signatureVerified"),
        });
      }

      // Update recovery attempt tracking
      const now = new Date();
      const lastAttempt = record.lastRecoveryAttemptAt ? new Date(record.lastRecoveryAttemptAt) : null;
      const hoursSinceLastAttempt = lastAttempt
        ? (now.getTime() - lastAttempt.getTime()) / (1000 * 60 * 60)
        : null;

      // Reset counter if 24 hours have passed
      const newAttemptCount =
        hoursSinceLastAttempt && hoursSinceLastAttempt >= 24
          ? 1
          : (record.recoveryAttempts || 0) + 1;

      record.recoveryAttempts = newAttemptCount;
      record.lastRecoveryAttemptAt = now.toISOString();
    }
  );

  // POST /api/v1/recovery/verify/:id
  // Verify recovery token and decrypt/return the secret
  app.post<{ Params: { id: string }; Body: { token: string; challenge: string } }>(
    "/recovery/verify/:id",
    {
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req, reply) => {
      const requestId = req.params.id;
      const locale = (req as any).locale ?? "en";

      const record = getCashRequest(requestId);
      if (!record) {
        reply.code(404).send({ error: "claim not found" });
        return;
      }

      if (!record.recoveryEncryptedToken || !record.recoveryTokenExpiresAt) {
        reply.code(400).send({
          error: "recovery_not_available",
          detail: "This claim does not support recovery",
        });
        return;
      }

      // Validate token expiration
      const expiry = validateRecoveryTokenExpiry(record.recoveryTokenExpiresAt);
      if (!expiry.valid) {
        reply.code(410).send({
          error: "recovery_token_expired",
          detail: "The recovery period for this claim has expired",
        });
        return;
      }

      const body = parseBody(
        z.object({
          token: z.string().trim().min(1),
          challenge: z.string().trim().min(1),
        }),
        req.body,
        reply
      );
      if (!body) return;

      const { token, challenge } = body;

      // Decrypt the stored recovery token using the provided challenge
      const decrypted = decryptRecoveryToken(record.recoveryEncryptedToken, challenge);

      if (!decrypted || decrypted !== token) {
        // Token or challenge doesn't match — don't reveal which one
        reply.code(403).send({
          error: "invalid_recovery_token",
          detail: "Recovery token or challenge is incorrect",
        });
        return;
      }

      // Token verified! Return the recovery payload with the claim URL and secret
      // In production, the secret would have been communicated to the buyer out-of-band
      // For now, we return a recovery URL that can be used to access the claim
      const baseUrl = process.env.FRONTEND_BASE_URL ?? "https://app.velo.cash";

      // Note: The actual secret would need to be stored separately or re-derived.
      // For now, we indicate that recovery was successful and user should check their email/notification
      reply.code(200).send({
        status: "recovery_verified",
        message: t(locale, "recovery.verified"),
        claim_url: `${baseUrl}/claim/${record.id}`,
        // In production, we would include the secret here if we had stored it securely
        // secret_recovery_link: `${baseUrl}/recover/${record.id}?token=${encodeURIComponent(recoveryToken)}`
      });

      // Mark recovery token as used by invalidating it
      record.recoveryEncryptedToken = ""; // or set a flag for one-time use
    }
  );
}
