import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { mkdir, mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const TOKEN = "integration-test-token-golden-config";

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

// A separate spawn pointed at a container name that cannot exist on any
// host, rather than reusing the default "incus-web" container: a payload
// that passes validateGoldenConfigPayload and hash verification must
// proceed to a real `incus file push` invocation, and this suite asserts
// that happens without ever risking a mutation against a real, possibly-
// in-use container.
const nonexistentContainer = "ws-integration-test-does-not-exist";

describe("provisioner-server ImportGoldenConfig (integration)", () => {
  let tempDir: string;
  let goldenConfigDir: string;
  let socketPath: string;
  let child: ChildProcess;

  const workspace = {
    id: "workspace-incus-web",
    ownerUserId: "user-1",
    incusProject: "default",
    incusContainer: nonexistentContainer,
  };

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "incus-web-provisioner-golden-config-"));
    goldenConfigDir = join(tempDir, "golden-config");
    await mkdir(goldenConfigDir, { recursive: true });
    socketPath = join(tempDir, "provisioner.sock");

    child = spawn(
      process.execPath,
      [join(currentDir, "../../../../scripts/provisioner-server.mjs")],
      {
        env: {
          ...process.env,
          INCUS_WEB_PROVISIONER_TOKEN: TOKEN,
          INCUS_WEB_PROVISIONER_SOCKET: socketPath,
          INCUS_WEB_AGENT_RUN_STORE_PATH: join(tempDir, "agent-runs.sqlite"),
          INCUS_WEB_PROVISIONER_STATE_DB: join(tempDir, "provisioner.sqlite"),
          INCUS_WEB_PROVISIONER_HOST: "",
          INCUS_WEB_PROVISIONER_PORT: "0",
          INCUS_WEB_INCUS_CONTAINER: nonexistentContainer,
          INCUS_WEB_GOLDEN_CONFIG_DIR: goldenConfigDir,
          INCUS_WEB_GOLDEN_CONFIG_MAX_ENTRIES: "3",
          INCUS_WEB_GOLDEN_CONFIG_MAX_EXPANDED_BYTES: "1024",
          INCUS_WEB_GOLDEN_CONFIG_MAX_COMPRESSION_RATIO: "10",
          INCUS_WEB_GOLDEN_CONFIG_MAX_DEPTH: "4",
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

  function baseCommand(requestId: string, payload: unknown) {
    return {
      version: "provisioner.v1",
      requestId,
      type: "ImportGoldenConfig",
      actor: {
        userId: "user-1",
        oidcSubject: "subject-1",
        email: "owner@example.com",
      },
      workspace,
      payload,
    };
  }

  it("rejects a malformed sha256Hex with invalid_input, proving the server re-validates independently of the web app's own validation", async () => {
    const response = await postOperations(
      socketPath,
      baseCommand("req-1", { sha256Hex: "not-a-hash" }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "failed",
      error: { code: "invalid_input" },
    });
  });

  it("rejects an import when no golden config has been staged for this workspace", async () => {
    const validButUnstagedHash = "0".repeat(64);
    const response = await postOperations(
      socketPath,
      baseCommand("req-2", { sha256Hex: validButUnstagedHash }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "failed",
      error: { code: "invalid_input" },
    });
  });

  it("rejects an import when the staged file's content does not match the declared hash", async () => {
    const stagedPath = join(goldenConfigDir, `${workspace.id}.zip`);
    await writeFile(stagedPath, Buffer.from("not actually a zip"));

    const wrongHash = "1".repeat(64);
    const response = await postOperations(
      socketPath,
      baseCommand("req-3", { sha256Hex: wrongHash }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "failed",
      error: { code: "invalid_input" },
    });
    await expect(access(stagedPath)).rejects.toThrow();
  });

  it("proceeds past hash verification and attempts a real `incus file push` for a correctly-hashed staged file, instead of silently no-op'ing", async () => {
    const stagedPath = join(goldenConfigDir, `${workspace.id}.zip`);
    const content = centralDirectoryZip([{ name: "claude/settings.json", compressed: 10, expanded: 10 }]);
    await writeFile(stagedPath, content);
    const sha256Hex = createHash("sha256").update(content).digest("hex");

    const response = await postOperations(socketPath, baseCommand("req-4", { sha256Hex }));

    expect(response.status).toBe(200);
    // A correctly-hashed staged file must fail because the container
    // doesn't exist (the real incus CLI call was attempted), not because
    // hash verification rejected it -- a code path that quietly stopped
    // calling incus at all would still return "failed", but with error.code
    // "invalid_input", not this.
    expect(response.body).toMatchObject({
      status: "failed",
      error: { code: "incus_unavailable" },
    });
    await expect(access(stagedPath)).rejects.toThrow();
  });

  it("rejects unsafe, secret-bearing, excessive, and zip-bomb metadata before Incus and cleans staging", async () => {
    const cases = [
      centralDirectoryZip([{ name: "../escape", compressed: 1, expanded: 1 }]),
      centralDirectoryZip([{ name: "codex/auth.json", compressed: 1, expanded: 1 }]),
      centralDirectoryZip([{ name: "claude/huge", compressed: 1, expanded: 100 }]),
      centralDirectoryZip([
        { name: "a", compressed: 1, expanded: 1 },
        { name: "b", compressed: 1, expanded: 1 },
        { name: "c", compressed: 1, expanded: 1 },
        { name: "d", compressed: 1, expanded: 1 },
      ]),
    ];
    for (const [index, content] of cases.entries()) {
      const stagedPath = join(goldenConfigDir, `${workspace.id}.zip`);
      await writeFile(stagedPath, content);
      const sha256Hex = createHash("sha256").update(content).digest("hex");
      const response = await postOperations(socketPath, baseCommand(`unsafe-${index}`, { sha256Hex }));
      expect(response.body).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
      await expect(access(stagedPath)).rejects.toThrow();
    }
  }, 15_000);
});

function centralDirectoryZip(
  entries: Array<{ name: string; compressed: number; expanded: number; externalAttributes?: number }>,
) {
  const records = entries.map((entry) => {
    const name = Buffer.from(entry.name, "utf8");
    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x031e, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(entry.compressed, 20);
    record.writeUInt32LE(entry.expanded, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    name.copy(record, 46);
    return record;
  });
  const central = Buffer.concat(records);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([central, eocd]);
}
