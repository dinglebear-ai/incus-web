import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));

// Integration test for the requireServiceAuth backport in
// scripts/provisioner-server.mjs. The module self-executes at import time
// (top-level server.listen), so it cannot be imported directly in-process
// without side effects -- this spawns it as a real subprocess and exercises
// the same Unix-socket path the manual smoke test (Phase 0 plan, Task 2
// Step 7) covered by hand, automating it so a future regression at this
// integration seam (not just inside the isolated service-auth.mjs module)
// is caught by CI.

const TOKEN = "integration-test-token";

function postOperations(
  socketPath: string,
  authorizationHeader: string | undefined,
): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const req = request(
      {
        socketPath,
        path: "/v1/operations",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(authorizationHeader ? { authorization: authorizationHeader } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let parsed: unknown = undefined;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            // non-JSON response body is fine for this test's assertions
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function waitForSocket(socketPath: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await access(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`provisioner socket did not appear at ${socketPath} within ${timeoutMs}ms`);
}

describe("provisioner-server requireServiceAuth (integration)", () => {
  let tempDir: string;
  let socketPath: string;
  let child: ChildProcess;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "incus-web-provisioner-auth-"));
    socketPath = join(tempDir, "provisioner.sock");

    child = spawn(
      process.execPath,
      [join(currentDir, "../../../../scripts/provisioner-server.mjs")],
      {
        env: {
          ...process.env,
          INCUS_WEB_PROVISIONER_TOKEN: TOKEN,
          INCUS_WEB_PROVISIONER_SOCKET: socketPath,
          INCUS_WEB_PROVISIONER_HOST: "",
          INCUS_WEB_PROVISIONER_PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForSocket(socketPath);
  }, 15000);

  afterAll(async () => {
    child?.kill();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("rejects a request with no authorization header", async () => {
    const response = await postOperations(socketPath, undefined);
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "unauthenticated_service" });
  });

  it("rejects a request with the wrong bearer token", async () => {
    const response = await postOperations(socketPath, "Bearer wrong-token");
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "unauthenticated_service" });
  });

  it("rejects a request with a malformed Bearer prefix", async () => {
    const response = await postOperations(socketPath, TOKEN);
    expect(response.status).toBe(401);
  });

  it("accepts a request with the correct bearer token and proceeds past auth", async () => {
    const response = await postOperations(socketPath, `Bearer ${TOKEN}`);
    // An empty command body fails downstream validation (400), but the
    // request must NOT be rejected as 401 -- proving verifyBearerToken
    // actually authorizes the real, correctly-formed token end-to-end
    // through the live socket, not just in unit isolation.
    expect(response.status).not.toBe(401);
  });
});
