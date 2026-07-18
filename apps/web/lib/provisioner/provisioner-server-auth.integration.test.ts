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
  command: unknown = {},
): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(command);
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

async function waitForSocket(socketPath: string, timeoutMs = 15000) {
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
          INCUS_WEB_PROVISIONER_STATE_DB: join(tempDir, "provisioner.sqlite"),
          INCUS_WEB_AGENT_RUN_STORE_PATH: join(tempDir, "agent-runs.sqlite"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForSocket(socketPath);
  }, 30000);

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

  it("rejects malformed privileged commands and owner mismatches on the real socket", async () => {
    const base = validCommand("ListAgentRuns", { limit: 20 }, "negative-matrix");
    const cases = [
      { ...base, unexpected: true },
      { ...base, actor: { ...base.actor, unexpected: true } },
      { ...base, actor: { ...base.actor, userId: "other-user" } },
      { ...base, workspace: { ...base.workspace, ownerUserId: "other-user" } },
      { ...base, payload: { limit: 0 } },
      { ...base, payload: { limit: 20, unexpected: true } },
    ];
    for (const command of cases) {
      const response = await postOperations(socketPath, `Bearer ${TOKEN}`, command);
      expect(response.body).toMatchObject({
        status: "failed",
        error: { code: expect.stringMatching(/invalid_input|metadata_mismatch/) },
      });
    }
  });

  it("durably replays a request id and rejects changed-payload reuse", async () => {
    const command = validCommand("ListAgentRuns", { limit: 20 }, "durable-replay");
    const first = await postOperations(socketPath, `Bearer ${TOKEN}`, command);
    const replay = await postOperations(socketPath, `Bearer ${TOKEN}`, command);
    expect(replay.body).toEqual(first.body);

    const changed = await postOperations(socketPath, `Bearer ${TOKEN}`, {
      ...command,
      payload: { limit: 21 },
    });
    expect(changed.body).toMatchObject({
      status: "failed",
      error: { code: "invalid_input" },
    });
  });
});

function validCommand(type: string, payload: unknown, requestId: string) {
  return {
    version: "provisioner.v1",
    requestId,
    type,
    actor: {
      userId: "user-1",
      oidcSubject: "subject-1",
      email: "owner@example.com",
    },
    workspace: {
      id: "workspace-incus-web",
      ownerUserId: "user-1",
      incusProject: "default",
      incusContainer: "incus-web",
    },
    payload,
  };
}
