import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveLocale, t, type Locale } from "../lib/i18n.js";
import { ApiError } from "../lib/errors.js";
import type { Pool } from "pg";

/** Supported currency codes for locale-aware cash formatting. */
const SUPPORTED_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "ARS", "BRL", "MXN", "SAR", "AED",
]);

/** BCP-47 tags we accept from the client. Must match Locale type in i18n.ts. */
const SUPPORTED_LOCALES: Locale[] = ["en", "es", "fr", "ar", "pt"];

interface PreferencesBody {
  locale: string;
  currency: string;
}

/**
 * POST /api/v1/user/preferences
 *
 * Persists a provider's preferred locale and display currency.
 * Responds with the saved values, localised into the requested locale.
 *
 * Body:  { locale: string, currency: string }
 * Query: ?stellarAddress=G...  (identifies the provider row)
 */
export async function userPreferencesRoutes(
  app: FastifyInstance,
  opts: { prefix?: string; db?: Pool | null }
) {
  const db = opts.db ?? null;

  app.post<{ Body: PreferencesBody; Querystring: { stellarAddress?: string } }>(
    "/user/preferences",
    {
      schema: {
        description:
          "Update the authenticated provider's preferred locale and display currency. " +
          "The response body is localised into the chosen locale.",
        tags: ["user"],
        querystring: {
          type: "object",
          properties: {
            stellarAddress: {
              type: "string",
              description: "Stellar public key (G…) identifying the provider.",
            },
          },
        },
        body: {
          type: "object",
          required: ["locale", "currency"],
          properties: {
            locale: {
              type: "string",
              enum: SUPPORTED_LOCALES,
              description: "BCP-47 language tag (e.g. en, es, fr, ar, pt).",
            },
            currency: {
              type: "string",
              description: "ISO 4217 currency code (e.g. USD, EUR, BRL).",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              locale: { type: "string" },
              currency: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: PreferencesBody;
        Querystring: { stellarAddress?: string };
      }>,
      reply: FastifyReply
    ) => {
      const { locale, currency } = request.body;
      const { stellarAddress } = request.query;

      // Validate locale
      if (!SUPPORTED_LOCALES.includes(locale as Locale)) {
        throw new ApiError(
          400,
          `Unsupported locale '${locale}'. Supported: ${SUPPORTED_LOCALES.join(", ")}`
        );
      }

      // Validate currency
      const upperCurrency = currency.toUpperCase();
      if (!SUPPORTED_CURRENCIES.has(upperCurrency)) {
        throw new ApiError(
          400,
          `Unsupported currency '${currency}'. Supported: ${[...SUPPORTED_CURRENCIES].join(", ")}`
        );
      }

      // Persist to DB when a stellarAddress and pool are available.
      if (stellarAddress && db) {
        await db.query(
          `UPDATE provider_profiles
              SET preferred_locale   = $1,
                  preferred_currency = $2
            WHERE stellar_address = $3`,
          [locale, upperCurrency, stellarAddress]
        );
      }

      // Respond in the newly chosen locale.
      const resolvedLocale = resolveLocale(locale);
      const message = t(resolvedLocale, "instructions.showQR");

      return reply.status(200).send({
        ok: true,
        locale,
        currency: upperCurrency,
        message,
      });
    }
  );
}
