import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDisputeEvidence } from "../lib/dispute-evidence-store.js";
import { saveCashRequest, updateStatus } from "../lib/store.js";
import { adminRoutes } from "./admin.js";
import { disputeEvidenceRoutes } from "./dispute-evidence.js";

describe("dispute evidence", () => {
  const buyer = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const provider = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const outsider = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const adminKey = "evidence-test-admin-key";
  let tradeId: string;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    clearDisputeEvidence();
    process.env.ADMIN_API_KEY = adminKey;
    tradeId = `evidence-${Date.now()}-${Math.random()}`;
    saveCashRequest({
      id: tradeId,
      contractId: "contract",
      seller: provider,
      buyer,
      amountStroops: "100",
      secretHex: "secret",
      secretHashHex: "hash",
      qrPayload: "qr",
      status: "disputed",
      createdAt: new Date().toISOString(),
    });
    app = Fastify();
    await app.register(disputeEvidenceRoutes, { prefix: "/api/v1" });
    await app.register(adminRoutes, { prefix: "/api/v1" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.ADMIN_API_KEY;
  });

  const imageBodies = {
    "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 1]),
    "image/webp": Buffer.from("RIFFxxxxWEBPdata"),
  };

  async function upload(address: string, contentType = "image/png", body?: Buffer) {
    return app.inject({
      method: "POST",
      url: `/api/v1/cash/request/${tradeId}/evidence`,
      headers: {
        "content-type": contentType,
        "x-file-name": "handoff.png",
        "x-stellar-address": address,
      },
      payload: body ?? imageBodies[contentType as keyof typeof imageBodies] ?? Buffer.from("file"),
    });
  }

  it.each([
    ["buyer", buyer],
    ["provider", provider],
  ])("accepts an image uploaded by the %s", async (_role, address) => {
    const response = await upload(address);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      tradeId,
      uploadedBy: address,
      fileName: "handoff.png",
      contentType: "image/png",
      sizeBytes: imageBodies["image/png"].byteLength,
    });
  });

  it("rejects uploads for a trade that is not disputed", async () => {
    updateStatus(tradeId, "locked");
    const response = await upload(buyer);
    expect(response.statusCode).toBe(409);
  });

  it("rejects uploads from unrelated parties", async () => {
    const response = await upload(outsider);
    expect(response.statusCode).toBe(403);
  });

  it("rejects unsupported files and images over 5 MiB", async () => {
    const wrongType = await upload(buyer, "application/pdf");
    expect(wrongType.statusCode).toBe(415);

    const spoofedType = await upload(buyer, "image/png", Buffer.from("not an image"));
    expect(spoofedType.statusCode).toBe(415);

    const tooLargeBody = Buffer.alloc(5 * 1024 * 1024 + 1);
    tooLargeBody.set(imageBodies["image/jpeg"]);
    const tooLarge = await upload(buyer, "image/jpeg", tooLargeBody);
    expect(tooLarge.statusCode).toBe(413);
  });

  it("allows only participants and admins to view evidence", async () => {
    const privateImage = imageBodies["image/webp"];
    const uploaded = await upload(provider, "image/webp", privateImage);
    const evidenceId = uploaded.json().id;

    const outsiderList = await app.inject({
      method: "GET",
      url: `/api/v1/cash/request/${tradeId}/evidence`,
      headers: { "x-stellar-address": outsider },
    });
    expect(outsiderList.statusCode).toBe(403);

    const noAdminKey = await app.inject({
      method: "GET",
      url: `/api/v1/admin/trades/${tradeId}/evidence`,
    });
    expect(noAdminKey.statusCode).toBe(401);

    const adminList = await app.inject({
      method: "GET",
      url: `/api/v1/admin/trades/${tradeId}/evidence`,
      headers: { "x-admin-api-key": adminKey },
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().data).toHaveLength(1);

    const adminImage = await app.inject({
      method: "GET",
      url: `/api/v1/admin/trades/${tradeId}/evidence/${evidenceId}`,
      headers: { "x-admin-api-key": adminKey },
    });
    expect(adminImage.statusCode).toBe(200);
    expect(adminImage.headers["content-type"]).toContain("image/webp");
    expect(adminImage.rawPayload).toEqual(privateImage);
  });
});
