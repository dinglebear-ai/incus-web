import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { provisionerReadiness } from "./readiness";

let server: Server | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

async function provisionerReturning(status: number, contractResponse = false) {
  server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer readiness-token");
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      if (!contractResponse) {
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const probe = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.end(JSON.stringify({
        id: `host-${probe.requestId}`,
        requestId: probe.requestId,
        type: probe.type,
        workspaceId: probe.workspace.id,
        status: "failed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: { code: "invalid_input", message: "unsupported provisioner command", retryable: false },
      }));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  vi.stubEnv("INCUS_WEB_PROVISIONER_TOKEN", "readiness-token");
  vi.stubEnv("INCUS_WEB_PROVISIONER_URL", `http://127.0.0.1:${address.port}`);
}

describe("provisionerReadiness", () => {
  it("accepts an authenticated schema rejection as proof of readiness", async () => {
    await provisionerReturning(200, true);
    await expect(provisionerReadiness()).resolves.toMatchObject({ ok: true, configured: true });
  });

  it("rejects authentication failures", async () => {
    await provisionerReturning(401);
    await expect(provisionerReadiness()).resolves.toMatchObject({ ok: false, configured: true });
  });

  it.each([200, 400, 404])("rejects a non-contract %s response", async (status) => {
    await provisionerReturning(status);
    await expect(provisionerReadiness()).resolves.toMatchObject({ ok: false, configured: true });
  });
});
