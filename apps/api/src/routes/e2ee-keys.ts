import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../lib/validation.js";
import { ApiError } from "../lib/errors.js";
import { savePrekeyBundle, fetchPrekeyBundle } from "../lib/crypto/prekey-vault.js";

const base64Regex = /^[A-Za-z0-9+/=_-]{10,256}$/;

const prekeyUploadSchema = z.object({
  address: z.string().trim().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar address format"),
  identityPublicKey: z.string().trim().regex(base64Regex, "Invalid identity public key base64"),
  signedPrekey: z.object({
    id: z.number().int().positive(),
    publicKey: z.string().trim().regex(base64Regex, "Invalid signed prekey public key base64"),
    signature: z.string().trim().min(10, "Invalid signed prekey signature"),
  }),
  oneTimePrekeys: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      publicKey: z.string().trim().regex(base64Regex, "Invalid one-time prekey public key base64"),
    })
  ),
});

export async function e2eeKeysRoutes(app: FastifyInstance) {
  app.post("/e2ee/keys/upload", async (req, reply) => {
    const body = parseBody(prekeyUploadSchema, req.body, reply);
    if (!body) return;

    await savePrekeyBundle(body, (app as any).pg);

    return {
      success: true,
      address: body.address,
      uploadedOneTimePrekeysCount: body.oneTimePrekeys.length,
      updatedAt: new Date().toISOString(),
    };
  });

  app.get<{ Params: { address: string } }>("/e2ee/keys/bundle/:address", async (req) => {
    const { address } = req.params;
    if (!/^G[A-Z0-9]{55}$/.test(address)) {
      throw new ApiError(400, "INVALID_ADDRESS", "Invalid Stellar address format");
    }

    const bundle = await fetchPrekeyBundle(address, (app as any).pg);
    if (!bundle) {
      throw new ApiError(404, "PREKEY_BUNDLE_NOT_FOUND", `No prekey bundle found for address ${address}`);
    }

    return { bundle };
  });
}
