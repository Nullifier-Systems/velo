import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { openapiRoutes } from "./openapi.js";
import { openApiDocument } from "../openapi.js";

async function buildApp() {
  const app = Fastify();
  app.register(openapiRoutes, { prefix: "/api/v1" });
  await app.ready();
  return app;
}

describe("GET /api/v1/openapi.json", () => {
  it("serves the OpenAPI document", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe("Velo API");
  });

  it("documents every route of the API, including itself", async () => {
    const app = await buildApp();
    const doc = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();

    const expected = [
      "/health",
      "/api/v1/openapi.json",
      "/api/v1/services",
      "/api/v1/cash/agents",
      "/api/v1/cash/request",
      "/api/v1/cash/request/prepare",
      "/api/v1/cash/request/submit",
      "/api/v1/cash/request/{id}",
      "/api/v1/cash/request/{id}/release",
      "/api/v1/reputation/{address}",
    ];
    expect(Object.keys(doc.paths).sort()).toEqual([...expected].sort());
  });

  it("declares x402 pricing on paid routes and 402 challenge responses", async () => {
    const app = await buildApp();
    const doc = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();

    const paid: Array<[string, string, string]> = [
      ["/api/v1/cash/agents", "get", "0.001"],
      ["/api/v1/cash/request", "post", "0.01"],
      ["/api/v1/cash/request/prepare", "post", "0.01"],
      ["/api/v1/cash/request/submit", "post", "0.01"],
      ["/api/v1/reputation/{address}", "get", "0.0005"],
    ];

    for (const [path, method, price] of paid) {
      const op = doc.paths[path][method];
      expect(op["x-price-usdc"]).toBe(price);
      expect(op.security).toEqual([{ x402Payment: [] }]);
      expect(op.responses["402"]).toBeDefined();
    }

    // Free routes carry no price extension.
    expect(doc.paths["/health"].get["x-price-usdc"]).toBeUndefined();
    expect(doc.paths["/api/v1/services"].get["x-price-usdc"]).toBeUndefined();

    // The X-Payment security scheme is defined.
    expect(doc.components.securitySchemes.x402Payment).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "X-Payment",
    });
  });

  it("documents per-route rate limits and a shared 429 response", async () => {
    const app = await buildApp();
    const doc = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();

    expect(doc.paths["/health"].get["x-rate-limit"]).toEqual({ max: 100, timeWindow: "1 minute" });
    expect(doc.paths["/api/v1/cash/request"].post["x-rate-limit"]).toEqual({ max: 20, timeWindow: "1 minute" });

    for (const pathItem of Object.values<any>(doc.paths)) {
      for (const op of Object.values<any>(pathItem)) {
        expect(op.responses["429"]).toBeDefined();
      }
    }
  });

  it("matches the committed openapi.json snapshot (run `npm run openapi:generate` after spec changes)", () => {
    const snapshotPath = fileURLToPath(new URL("../../openapi.json", import.meta.url));
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(openApiDocument)));
  });
});
