import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  CODEX_APP_SERVER_NOT_CONFIGURED,
  createAgentRun,
  createAgentRunStore,
  createCodexAppServerClient,
  dispatchAgentRun,
  executeAgentRun,
  listAgentRuns,
  reconcileAgentRuns,
  startAgentController,
} from "../../../../scripts/agent-runs.mjs";
import {
  PROVISIONER_CONTRACT_VERSION,
  type ProvisionerCommand,
} from "@/lib/provisioner/contracts";

const command: ProvisionerCommand<"DispatchAgentRun"> = {
  version: PROVISIONER_CONTRACT_VERSION,
  requestId: "req-agent",
  type: "DispatchAgentRun",
  actor: {
    userId: "user-1",
    oidcSubject: "subject-1",
    email: "owner@example.com",
  },
  workspace: {
    id: "workspace-1",
    ownerUserId: "user-1",
    incusProject: "default",
    incusContainer: "incus-web",
  },
  payload: {
    agent: "codex",
    repoUrl: "https://github.com/jmagar/incus-web.git",
    task: "Run tests",
  },
};

describe("agent run host store", () => {
  it("persists a failed Codex run when app-server config is missing", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const result = await dispatchAgentRun(command, {
      store,
      execute: false,
      config: {
        storePath,
        goldenContainer: "incus-web-agent-golden",
        goldenProject: "default",
        runProject: "default",
        codexAppServerUrl: "",
        codexAppServerToken: "",
        codexModel: "",
        codexAppServerTimeoutMs: 43200000,
        claudeCommandTemplate: "claude -p {{task}}",
      },
    });

    expect(result.run).toMatchObject({
      workspaceId: "workspace-1",
      ownerUserId: "user-1",
      agent: "codex",
      status: "failed",
      phase: "failed",
      controller: { kind: "codex-app-server" },
      error: CODEX_APP_SERVER_NOT_CONFIGURED,
      container: {
        name: expect.stringMatching(/^agent-run-/),
        sourceContainer: "incus-web-agent-golden",
        state: "planned",
      },
    });

    const stored = await store.get(result.run.id, "workspace-1", "user-1");
    expect(stored?.container.name).toBe(result.run.container.name);
  });

  it("lists runs by workspace with newest first", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    await dispatchAgentRun(command, {
      store,
      execute: false,
      config: config(storePath),
    });
    await dispatchAgentRun(
      {
        ...command,
        requestId: "req-agent-2",
        payload: { ...command.payload, task: "Second run" },
      },
      {
        store,
        execute: false,
        config: config(storePath),
      },
    );

    const result = await listAgentRuns(
      {
        ...command,
        type: "ListAgentRuns",
        payload: { limit: 1 },
      },
      { store, config: config(storePath) },
    );

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].task).toBe("Second run");
  });

  it("starts Codex through the app-server controller seam", async () => {
    const progress: string[] = [];
    const controller = await startAgentController(
      {
        id: "run_20260702000000_abcd1234",
        agent: "codex",
        task: "Run tests",
      },
      {
        ...config("/tmp/not-used.json"),
        codexAppServerUrl: "ws://127.0.0.1:4500",
        codexModel: "gpt-5.4",
        codexAppServerTimeoutMs: 1000,
      },
      async () => {
        throw new Error("codex app-server must not shell out through execInContainer");
      },
      {
        onProgress: async (message: string) => progress.push(message),
        codexAppServerClient: {
          async startTurn(params: {
            cwd: string;
            model?: string;
            task: string;
            onProgress?: (text: string) => Promise<void>;
          }) {
            expect(params).toMatchObject({
              cwd: "/workspace/repo",
              model: "gpt-5.4",
              task: "Run tests",
            });
            await params.onProgress?.("Codex app-server thread thr_123 running");
            return { threadId: "thr_123", turnId: "turn_456" };
          },
        },
      },
    );

    expect(controller).toEqual({
      kind: "codex-app-server",
      sessionId: "thr_123",
      turnId: "turn_456",
      url: "ws://127.0.0.1:4500",
    });
    expect(progress).toEqual(["Codex app-server thread thr_123 running"]);
  });

  it("connects to Codex app-server without Origin and with bearer auth", async () => {
    const server = await createFakeCodexAppServer();
    try {
      const client = createCodexAppServerClient({
        url: server.url,
        token: "secret-token",
        timeoutMs: 1000,
      });
      const result = await client.startTurn({
        cwd: "/workspace/repo",
        task: "Run tests",
        model: undefined,
        onProgress: undefined,
      });

      expect(result).toEqual({ threadId: "thr_test", turnId: "turn_test" });
      expect(server.headers.authorization).toBe("Bearer secret-token");
      expect(server.headers.origin).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("fails with an actionable error when the source credential is missing", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const run = createAgentRun(
      { ...command, payload: { ...command.payload, agent: "claude" } },
      config(storePath),
    );
    await store.insert(run);

    await expect(
      executeAgentRun(run, {
        config: config(storePath),
        store,
        incus: async () => "",
        execInContainer: async () => "",
        readHostCredential: async () => {
          throw new Error("not found");
        },
        injectCredential: async () => {
          throw new Error("must not be called");
        },
        deleteInjectedCredential: async () => {},
      }),
    ).rejects.toMatchObject({
      code: "credential_not_found",
      message: expect.stringContaining("claude login"),
    });
  });

  it("fails with an actionable error when the source credential is expired, without injecting it", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const run = createAgentRun(
      { ...command, payload: { ...command.payload, agent: "claude" } },
      config(storePath),
    );
    await store.insert(run);

    const expiredAt = Date.parse("2026-06-29T00:00:00.000Z");
    const expiredCredential = JSON.stringify({
      claudeAiOauth: { accessToken: "x", expiresAt: expiredAt },
    });

    await expect(
      executeAgentRun(run, {
        config: config(storePath),
        store,
        incus: async () => "",
        execInContainer: async () => "",
        readHostCredential: async () => expiredCredential,
        injectCredential: async () => {
          throw new Error("must not be called for an expired credential");
        },
        deleteInjectedCredential: async () => {},
      }),
    ).rejects.toMatchObject({
      code: "credential_expired",
      message: expect.stringContaining("expired"),
    });
  });

  it("injects the host-sourced credential and cleans it up on success", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const run = createAgentRun(
      { ...command, payload: { ...command.payload, agent: "claude" } },
      config(storePath),
    );
    await store.insert(run);

    const injectCalls: unknown[] = [];
    const deleteCalls: unknown[] = [];
    const credentialContent = JSON.stringify({ claudeAiOauth: { accessToken: "x" } });

    const result = await executeAgentRun(run, {
      config: { ...config(storePath), credentialSourceContainer: "incus-web" },
      store,
      incus: async () => "",
      execInContainer: async () => "",
      readHostCredential: async (container: string, project: string, path: string) => {
        expect(container).toBe("incus-web");
        expect(path).toBe("/home/agent/.claude/.credentials.json");
        return credentialContent;
      },
      injectCredential: async (...args: unknown[]) => {
        injectCalls.push(args);
      },
      deleteInjectedCredential: async (...args: unknown[]) => {
        deleteCalls.push(args);
      },
    });

    expect(result.status).toBe("succeeded");
    expect(injectCalls).toEqual([
      [run.container.name, run.container.project, "/root/.claude/.credentials.json", credentialContent],
    ]);
    expect(deleteCalls).toEqual([
      [run.container.name, run.container.project, "/root/.claude/.credentials.json"],
    ]);
  });

  it("still cleans up the injected credential when the agent controller fails", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const run = createAgentRun(
      { ...command, payload: { ...command.payload, agent: "claude" } },
      config(storePath),
    );
    await store.insert(run);

    const deleteCalls: unknown[] = [];
    let execCount = 0;

    await expect(
      executeAgentRun(run, {
        config: config(storePath),
        store,
        incus: async () => "",
        execInContainer: async () => {
          execCount += 1;
          // First call is the repo clone (must succeed); second call is
          // the claude -p invocation inside startAgentController, which
          // this test simulates as failing.
          if (execCount > 1) {
            throw new Error("claude -p failed inside container");
          }
          return "";
        },
        readHostCredential: async () => JSON.stringify({ claudeAiOauth: {} }),
        injectCredential: async () => {},
        deleteInjectedCredential: async (...args: unknown[]) => {
          deleteCalls.push(args);
        },
      }),
    ).rejects.toThrow("claude -p failed inside container");

    expect(deleteCalls).toHaveLength(1);
  });

  it("retries once on a torn/invalid JSON read before giving up", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const run = createAgentRun(
      { ...command, payload: { ...command.payload, agent: "claude" } },
      config(storePath),
    );
    await store.insert(run);

    let readCount = 0;
    const credentialContent = JSON.stringify({ claudeAiOauth: { accessToken: "x" } });

    const result = await executeAgentRun(run, {
      config: config(storePath),
      store,
      incus: async () => "",
      execInContainer: async () => "",
      readHostCredential: async () => {
        readCount += 1;
        return readCount === 1 ? "{not valid json" : credentialContent;
      },
      injectCredential: async () => {},
      deleteInjectedCredential: async () => {},
    });

    expect(readCount).toBe(2);
    expect(result.status).toBe("succeeded");
  });

  it("transactionally preserves concurrent appends across independent store handles", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const run = createAgentRun(command, config(storePath));
    await store.insert(run);

    const secondStore = createAgentRunStore(storePath);
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        (index % 2 === 0 ? store : secondStore).appendLog(run.id, `progress ${index}`),
      ),
    );

    const stored = await secondStore.get(run.id, "workspace-1", "user-1");
    expect(stored?.logs).toHaveLength(25);
    expect(new Set(stored?.logs?.map((entry) => entry.message))).toEqual(
      new Set(Array.from({ length: 25 }, (_, index) => `progress ${index}`)),
    );
  });

  it("records bounded run log entries alongside the latest excerpt", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const run = createAgentRun(command, config(storePath));
    await store.insert(run);

    await store.appendLog(run.id, "first progress line");
    await store.appendLog(run.id, "second progress line", "success");

    const stored = await store.get(run.id, "workspace-1", "user-1");
    expect(stored?.lastLogExcerpt).toBe("second progress line");
    expect(stored?.logs).toMatchObject([
      { level: "info", message: "first progress line" },
      { level: "success", message: "second progress line" },
    ]);
  });

  it("replays matching dispatch request ids and rejects changed reuse", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const first = await dispatchAgentRun(command, { store, execute: false, config: config(storePath) });
    const replay = await dispatchAgentRun(command, { store, execute: false, config: config(storePath) });
    expect(replay.run.id).toBe(first.run.id);
    await expect(dispatchAgentRun({
      ...command,
      payload: { ...command.payload, task: "different mutation" },
    }, { store, execute: false, config: config(storePath) })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("bounds durable admission and reconciles interrupted runs after restart", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath);
    const bounded = { ...config(storePath), maxQueuedRuns: 1, maxConcurrentRuns: 1 };
    const queuedCommand = { ...command, payload: { ...command.payload, agent: "claude" as const } };
    const first = await dispatchAgentRun(queuedCommand, { store, execute: false, config: bounded });
    await expect(dispatchAgentRun({ ...queuedCommand, requestId: "queue-overflow" }, {
      store,
      execute: false,
      config: bounded,
    })).rejects.toMatchObject({ code: "timeout" });

    await store.update(first.run.id, { status: "running", phase: "running" });
    await reconcileAgentRuns({ store, config: bounded, execute: false });
    const recovered = await store.get(first.run.id, "workspace-1", "user-1");
    expect(recovered).toMatchObject({ status: "failed", phase: "failed" });
    expect(recovered?.error).toContain("restarted");
  });

  it("prunes terminal history while retaining indexed active runs", async () => {
    const storePath = await tempStorePath();
    const store = createAgentRunStore(storePath, { historyLimit: 2 });
    for (let index = 0; index < 3; index += 1) {
      const run = createAgentRun({ ...command, requestId: `history-${index}` }, config(storePath));
      await store.insert(run);
      await store.update(run.id, { status: "failed", phase: "failed" });
    }
    const active = createAgentRun({ ...command, requestId: "history-active" }, config(storePath));
    await store.insert(active);
    const runs = await store.list("workspace-1", 100);
    expect(runs.filter((run) => run.status === "failed")).toHaveLength(2);
    expect(runs.some((run) => run.id === active.id)).toBe(true);
  });
});

async function tempStorePath() {
  return join(await mkdtemp(join(tmpdir(), "incus-web-agent-runs-")), "runs.sqlite");
}

function config(storePath: string) {
  return {
    storePath,
    goldenContainer: "incus-web-agent-golden",
    goldenProject: "default",
    runProject: "default",
    codexAppServerUrl: "",
    codexAppServerToken: "",
    codexModel: "",
    codexAppServerTimeoutMs: 43200000,
    claudeCommandTemplate: "claude -p {{task}}",
  };
}

async function createFakeCodexAppServer() {
  const state = {
    headers: {} as Record<string, string>,
  };
  const server = createServer((socket) => {
    let handshake: Buffer = Buffer.alloc(0);
    let frames: Buffer = Buffer.alloc(0);
    let didHandshake = false;

    socket.on("data", (chunk) => {
      if (!didHandshake) {
        handshake = Buffer.concat([handshake, chunk]);
        const split = handshake.indexOf("\r\n\r\n");
        if (split === -1) return;
        const rawHeaders = handshake.subarray(0, split).toString("latin1");
        const lines = rawHeaders.split("\r\n");
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const index = line.indexOf(":");
          if (index === -1) continue;
          headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
        }
        state.headers = headers;
        const accept = createHash("sha1")
          .update(`${headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
          ].join("\r\n"),
        );
        didHandshake = true;
        frames = Buffer.concat([frames, handshake.subarray(split + 4)]);
      } else {
        frames = Buffer.concat([frames, chunk]);
      }

      frames = drainClientFrames(frames, (message) => {
        const request = JSON.parse(message);
        if (request.method === "initialize") {
          sendServerFrame(socket, {
            id: request.id,
            result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake" } },
          });
        } else if (request.method === "thread/start") {
          sendServerFrame(socket, {
            id: request.id,
            result: { thread: { id: "thr_test" } },
          });
        } else if (request.method === "turn/start") {
          sendServerFrame(socket, {
            id: request.id,
            result: { turn: { id: "turn_test" } },
          });
          sendServerFrame(socket, {
            method: "turn/started",
            params: { turn: { id: "turn_test" } },
          });
          sendServerFrame(socket, {
            method: "turn/completed",
            params: { turn: { id: "turn_test", status: "completed" } },
          });
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return {
    get headers() {
      return state.headers;
    },
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function sendServerFrame(socket: { write(data: Buffer): void }, message: unknown) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const headerLength = payload.length < 126 ? 2 : 4;
  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = payload.length;
  } else {
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
  }
  payload.copy(frame, headerLength);
  socket.write(frame);
}

function drainClientFrames(buffer: Buffer, onMessage: (message: string) => void) {
  let offset = 0;
  while (buffer.length - offset >= 6) {
    const opcode = buffer[offset] & 0x0f;
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 8) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    }
    const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
    const payloadStart = offset + headerLength + 4;
    const frameLength = headerLength + 4 + length;
    if (buffer.length - offset < frameLength) break;
    const payload = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = buffer[payloadStart + index] ^ mask[index % 4];
    }
    if (opcode === 0x1) {
      onMessage(payload.toString("utf8"));
    }
    offset += frameLength;
  }
  return buffer.subarray(offset);
}
