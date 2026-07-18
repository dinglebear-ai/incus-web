import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { provisionerReadiness } from "./readiness";

let server: Server | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

async function provisionerReturning(status: number) {
  server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer readiness-token");
    response.statusCode = status;
    response.end();
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  vi.stubEnv("INCUS_WEB_PROVISIONER_TOKEN", "readiness-token");
  vi.stubEnv("INCUS_WEB_PROVISIONER_URL", `http://127.0.0.1:${address.port}`);
}

describe("provisionerReadiness", () => {
  it("accepts an authenticated schema rejection as proof of readiness", async () => {
    await provisionerReturning(400);
    await expect(provisionerReadiness()).resolves.toMatchObject({ ok: true, configured: true });
  });

  it("rejects authentication failures", async () => {
    await provisionerReturning(401);
    await expect(provisionerReadiness()).resolves.toMatchObject({ ok: false, configured: true });
  });
});
