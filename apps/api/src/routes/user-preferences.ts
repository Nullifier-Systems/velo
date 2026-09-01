import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveLocale, t, type Locale } from "../lib/i18n.js";
import { ApiError } from "../lib/errors.js";

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
 * Validates and returns a provider's preferred locale and display currency.
 * The response is localised into the requested locale.
 *
 * Body:  { locale: string, currency: string }
 */
export async function userPreferencesRoutes(app: FastifyInstance) {
  app.post<{ Body: PreferencesBody }>(
    "/user/preferences",
    {
      schema: {
        description:
          "Validate and return the provider's preferred locale and display currency. " +
          "The response body is localised into the chosen locale.",
        tags: ["user"],
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
      request: FastifyRequest<{ Body: PreferencesBody }>,
      reply: FastifyReply
    ) => {
      const { locale, currency } = request.body;

      // Validate locale
      if (!SUPPORTED_LOCALES.includes(locale as Locale)) {
        throw new ApiError(
          400,
          "INVALID_PARAMETER",
          `Unsupported locale '${locale}'. Supported: ${SUPPORTED_LOCALES.join(", ")}`
        );
      }

      // Validate currency
      const upperCurrency = currency.toUpperCase();
      if (!SUPPORTED_CURRENCIES.has(upperCurrency)) {
        throw new ApiError(
          400,
          "INVALID_PARAMETER",
          `Unsupported currency '${currency}'. Supported: ${[...SUPPORTED_CURRENCIES].join(", ")}`
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
