#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname;
const temp = await mkdtemp(join(tmpdir(), "incus-web-build-worker-test-"));
const bin = join(temp, "bin");
const state = join(temp, "state");
const socketPath = join(temp, "build-worker.sock");
const token = "test-token";
let child;
let stderr = "";

try {
  await mkdir(bin);
  await mkdir(state);
  for (const name of ["ldd", "newuidmap", "newgidmap", "nft", "unsquashfs", "distrobuilder"]) {
    await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  child = spawn(process.execPath, [join(root, "scripts/build-worker.mjs")], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      INCUS_WEB_BUILD_WORKER_TOKEN: token,
      INCUS_WEB_BUILD_WORKER_SOCKET: socketPath,
      INCUS_WEB_BUILD_WORKER_STATE_DIR: state,
      INCUS_WEB_BUILD_WORKER_DB: join(state, "builds.sqlite3"),
      INCUS_WEB_BUILD_WORKER_WORK_DIR: join(state, "work"),
      DISTROBUILDER_BIN: join(bin, "distrobuilder"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  await waitFor(() => httpJson("GET", "/healthz"));
  assert.equal((await httpJson("GET", "/healthz")).status, 200);
  assert.equal((await httpJson("GET", "/readyz")).status, 200);

  const unauthorized = await httpJson("POST", "/v1/builds", { hello: "world" });
  assert.equal(unauthorized.status, 401);

  const presets = await httpJson(
    "POST",
    "/v1/builds",
    {
      version: "build-worker.v1",
      requestId: "req-smoke",
      type: "ListBuildPresets",
      actor: { userId: "oidc:test", email: "test@example.com" },
      payload: {},
    },
    { Authorization: `Bearer ${token}` },
  );
  assert.equal(presets.status, 200);
  assert.equal(presets.body.status, "succeeded");
  assert.deepEqual(presets.body.result.presets, []);

  child.kill("SIGTERM");
  await onceExit(child);
} catch (error) {
  if (child && !child.killed) child.kill("SIGTERM");
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${child ? "worker stderr:\n" + stderr : ""}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

function httpJson(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: text ? JSON.parse(text) : undefined,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function waitFor(fn) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 5000) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error("timed out waiting for worker");
}

function onceExit(proc) {
  return new Promise((resolve) => {
    proc.once("exit", resolve);
  });
}
