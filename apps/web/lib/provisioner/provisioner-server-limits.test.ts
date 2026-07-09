import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const TOKEN = "integration-test-token-limits";

function postOperations(
  socketPath: string,
  body: unknown,
): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path: "/v1/operations",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: `Bearer ${TOKEN}`,
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
            // non-JSON response is fine for these assertions
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
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

describe("provisioner-server SetWorkspaceLimits (integration)", () => {
  let tempDir: string;
  let socketPath: string;
  let child: ChildProcess;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "incus-web-provisioner-limits-"));
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

  // The workspace tuple below intentionally matches provisioner-server.mjs's
  // own defaults (workspaceId="workspace-incus-web", incusProject="default",
  // incusContainer="incus-web", used when INCUS_WEB_WORKSPACE_ID/
  // INCUS_WEB_INCUS_PROJECT/INCUS_WEB_INCUS_CONTAINER are unset, which they
  // are in this spawn's env) so validateWorkspace() passes and the request
  // actually reaches the SetWorkspaceLimits case being tested here.
  const matchingWorkspace = {
    id: "workspace-incus-web",
    ownerUserId: "user-1",
    incusProject: "default",
    incusContainer: "incus-web",
  };

  it("rejects a malformed SetWorkspaceLimits payload with invalid_input, proving the server re-validates independently of the web app's own validation", async () => {
    // This test posts directly to the provisioner's Unix socket, bypassing
    // apps/web/lib/provisioner/contracts.ts's validateSetWorkspaceLimitsPayload
    // entirely -- proving scripts/provisioner-server.mjs's own
    // validateLimitsPayload (the actual privileged-execution boundary) does
    // its own independent check rather than trusting the caller already did.
    const response = await postOperations(socketPath, {
      version: "provisioner.v1",
      requestId: "req-1",
      type: "SetWorkspaceLimits",
      actor: {
        userId: "user-1",
        oidcSubject: "subject-1",
        email: "owner@example.com",
      },
      workspace: matchingWorkspace,
      payload: { cpu: "not-a-number" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "failed",
      error: { code: "invalid_input" },
    });
  });

  it("rejects a zero cpu value at the server boundary, not just the client boundary", async () => {
    const response = await postOperations(socketPath, {
      version: "provisioner.v1",
      requestId: "req-2",
      type: "SetWorkspaceLimits",
      actor: {
        userId: "user-1",
        oidcSubject: "subject-1",
        email: "owner@example.com",
      },
      workspace: matchingWorkspace,
      payload: { cpu: "0" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "failed",
      error: { code: "invalid_input" },
    });
  });
});
