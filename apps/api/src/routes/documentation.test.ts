import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { openApiDocument } from "../openapi.js";

/**
 * Builds a minimal app with just the swagger + swagger-ui plugins, mirroring
 * how they're registered in app.ts, without pulling in the full app (Stellar
 * connections, Redis, etc.) that the other route tests need to mock.
 */
async function buildApp() {
  const app = Fastify();
  app.register(swagger, {
    mode: "static",
    // See the matching comment in app.ts for why this cast is needed
    // (openApiDocument's `as const` readonly types vs. @fastify/swagger's
    // mutable OpenAPI type definitions).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    specification: { document: openApiDocument as any },
  });
  app.register(swaggerUi, { routePrefix: "/documentation" });
  await app.ready();
  return app;
}

describe("GET /documentation", () => {
  it("redirects the bare path to the UI's static entry point", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/documentation" });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("./documentation/static/index.html");
  });

  it("renders the interactive Swagger UI", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/documentation/static/index.html" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("swagger-ui");
  });

  it("serves the spec consumed by the UI, matching the hand-maintained document", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/documentation/json" });

    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe("Velo API");
    // Static mode means this is the *same* document served at
    // /api/v1/openapi.json — not a second, independently-derived spec.
    expect(doc.paths["/api/v1/cash/agents"]).toBeDefined();
    expect(Object.keys(doc.paths).sort()).toEqual(
      Object.keys(openApiDocument.paths).sort()
    );
  });
});