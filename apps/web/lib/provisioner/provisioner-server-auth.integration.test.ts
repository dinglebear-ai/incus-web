import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validateProvisionerCommand } from "./contracts";

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
          INCUS_WEB_CODEX_APP_SERVER_URL: "",
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

  it("executes read-only requests fresh even when a request id is reused", async () => {
    const command = validCommand("ListAgentRuns", { limit: 20 }, "fresh-read");
    const first = await postOperations(socketPath, `Bearer ${TOKEN}`, command);
    const changed = await postOperations(socketPath, `Bearer ${TOKEN}`, {
      ...command,
      payload: { limit: 21 },
    });
    expect(first.body).toMatchObject({ status: "succeeded" });
    expect(changed.body).toMatchObject({ status: "succeeded" });
  });

  it("durably replays mutation request ids and rejects changed reuse", async () => {
    const command = validCommand(
      "StopWorkspace",
      { force: false, timeoutSeconds: 1 },
      "durable-mutation",
    );
    const first = await postOperations(socketPath, `Bearer ${TOKEN}`, command);
    const replay = await postOperations(socketPath, `Bearer ${TOKEN}`, command);
    expect(replay.body).toEqual(first.body);

    const changed = await postOperations(socketPath, `Bearer ${TOKEN}`, {
      ...command,
      payload: { force: true, timeoutSeconds: 1 },
    });
    expect(changed.body).toMatchObject({
      status: "failed",
      error: { code: "invalid_input" },
    });
  });

  it("keeps host payload rejection rules aligned with the executable TypeScript contract", async () => {
    const cases = [
      validCommand("DispatchAgentRun", {
        agent: "codex",
        repoUrl: "https://github.com/example/repo",
        ref: "feature//nested",
        task: "test",
      }, "parity-ref-double-slash"),
      validCommand("DispatchAgentRun", {
        agent: "codex",
        repoUrl: "https://github.com/example/repo",
        ref: "feature/",
        task: "test",
      }, "parity-ref-trailing-slash"),
      validCommand("SetWorkspaceLimits", { cpu: "1.5" }, "parity-fractional-cpu"),
      validCommand("CreateWorkspaceSnapshot", { name: "bad..snapshot" }, "parity-snapshot-name"),
      validCommand("RunSetup", {
        dotfilesRepo: "https://example.com/not-github/repo",
        skipAptScripts: true,
      }, "parity-dotfiles-repo"),
      validCommand("RunSetup", {
        ageKey: { value: "not an age identity", persistEncrypted: false },
        skipAptScripts: true,
      }, "parity-age-identity"),
      validCommand("RunSetup", {
        ageKey: { value: "AGE-SECRET-KEY-TEST", persistEncrypted: true },
        skipAptScripts: true,
      }, "parity-age-persistence-policy"),
    ];

    for (const command of cases) {
      expect(validateProvisionerCommand(command).ok).toBe(false);
      const response = await postOperations(socketPath, `Bearer ${TOKEN}`, command);
      expect(response.body).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
    }
  });

  it("accepts the same safe repository and setup shapes as the TypeScript contract", async () => {
    const commands = [
      validCommand("DispatchAgentRun", {
        agent: "codex",
        repoUrl: "ssh://git@example.com/example/repo",
        ref: "feature/nested",
        task: "test",
      }, "parity-valid-ssh-repo"),
      validCommand("RunSetup", {
        dotfilesRepo: "https://github.com/example/repo.git",
        ageKey: { value: "AGE-SECRET-KEY-TEST", persistEncrypted: false },
        skipAptScripts: true,
      }, "parity-valid-setup"),
    ];

    for (const command of commands) {
      expect(validateProvisionerCommand(command).ok).toBe(true);
      const response = await postOperations(socketPath, `Bearer ${TOKEN}`, command);
      expect(response.body).not.toMatchObject({ error: { code: "invalid_input" } });
    }
  });
});

describe("provisioner-server email owner policy (integration)", () => {
  let tempDir: string;
  let socketPath: string;
  let child: ChildProcess;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "incus-web-provisioner-email-owner-"));
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
          INCUS_WEB_CODEX_APP_SERVER_URL: "",
          INCUS_WEB_WORKSPACE_OWNER_SUBJECT: "",
          INCUS_WEB_WORKSPACE_OWNER_EMAIL: "owner@example.com",
          INCUS_WEB_INCUS_CONTAINER: "ws-email-owner-integration-test-does-not-exist",
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

  function emailOwnerCommand(email = "owner@example.com") {
    return {
      ...validCommand(
        "GetWorkspaceStatus",
        {},
        email === "owner@example.com" ? "email-owner-valid" : "email-owner-mismatch",
      ),
      actor: {
        userId: "oidc:stable-provider-subject",
        oidcSubject: "stable-provider-subject",
        email,
      },
      workspace: {
        id: "workspace-incus-web",
        ownerUserId: "oidc:owner@example.com",
        incusProject: "default",
        incusContainer: "ws-email-owner-integration-test-does-not-exist",
      },
    };
  }

  it("authorizes an email-owned workspace when the actor uses a stable non-email subject", async () => {
    const response = await postOperations(
      socketPath,
      `Bearer ${TOKEN}`,
      emailOwnerCommand(),
    );
    expect(response.body).toMatchObject({
      status: "failed",
      error: { code: "incus_unavailable" },
    });
  });

  it("rejects an actor whose email does not match the configured owner", async () => {
    const response = await postOperations(
      socketPath,
      `Bearer ${TOKEN}`,
      emailOwnerCommand("attacker@example.com"),
    );
    expect(response.body).toMatchObject({
      status: "failed",
      error: { code: "metadata_mismatch" },
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
