#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { requireConfiguredToken, verifyBearerToken } from "./service-auth.mjs";

const token = requireConfiguredToken(
  process.env.INCUS_WEB_BUILD_WORKER_TOKEN,
  "INCUS_WEB_BUILD_WORKER_TOKEN",
);
const socketPath = process.env.INCUS_WEB_BUILD_WORKER_SOCKET || "/run/incus-web/build-worker.sock";
const socketMode = parseInt(process.env.INCUS_WEB_BUILD_WORKER_SOCKET_MODE || "0660", 8);
const stateDir = process.env.INCUS_WEB_BUILD_WORKER_STATE_DIR || "/var/lib/incus-web/build-worker";
const dbPath = process.env.INCUS_WEB_BUILD_WORKER_DB || join(stateDir, "builds.sqlite3");
const workDir = process.env.INCUS_WEB_BUILD_WORKER_WORK_DIR || join(stateDir, "work");
const lockPath = process.env.INCUS_WEB_BUILD_WORKER_LOCK || join(stateDir, "build.lock");
const distrobuilderBin = process.env.DISTROBUILDER_BIN || "distrobuilder";
const commandTimeoutMs = Number.parseInt(
  process.env.INCUS_WEB_BUILD_WORKER_COMMAND_TIMEOUT_MS || String(45 * 60 * 1000),
  10,
);
const maxBodyBytes = Number.parseInt(process.env.INCUS_WEB_BUILD_WORKER_MAX_BODY_BYTES || "262144", 10);
const maxLogChunkBytes = Number.parseInt(
  process.env.INCUS_WEB_BUILD_WORKER_MAX_LOG_CHUNK_BYTES || String(256 * 1024),
  10,
);
const maxLogBytesPerBuild = Number.parseInt(
  process.env.INCUS_WEB_BUILD_WORKER_MAX_LOG_BYTES_PER_BUILD || String(20 * 1024 * 1024),
  10,
);
const maxCompletedBuilds = Number.parseInt(
  process.env.INCUS_WEB_BUILD_WORKER_MAX_COMPLETED_BUILDS || "100",
  10,
);
const maxQueuedBuilds = Number.parseInt(
  process.env.INCUS_WEB_BUILD_WORKER_MAX_QUEUED_BUILDS || "100",
  10,
);
const maxStderrTailBytes = Number.parseInt(
  process.env.INCUS_WEB_BUILD_WORKER_MAX_STDERR_TAIL_BYTES || String(64 * 1024),
  10,
);
const commandTypes = [
  "DispatchBuildImage",
  "GetBuildStatus",
  "ListBuildImages",
  "SetBuildImageMaster",
  "ListBuildPresets",
  "SaveBuildPreset",
];
const dispatchPayloadKeys = [
  "distro",
  "release",
  "packages",
  "postInstallCommands",
  "definitionYaml",
  "imageAlias",
  "idempotencyKey",
  "basedOn",
];
const savePresetPayloadKeys = ["name", "distro", "release", "packages", "postInstallCommands"];
let buildRunnerActive = false;

await mkdir(dirname(socketPath), { recursive: true });
await mkdir(stateDir, { recursive: true });
await mkdir(workDir, { recursive: true });
await unlinkExistingSocket(socketPath);

const { DatabaseSync } = await loadSQLite();
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL,
    image_alias TEXT NOT NULL,
    distro TEXT NOT NULL,
    release TEXT NOT NULL,
    based_on TEXT,
    definition_yaml TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(owner_user_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS build_logs (
    build_id TEXT NOT NULL,
    offset INTEGER NOT NULL,
    chunk TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS build_logs_build_id_offset_idx
    ON build_logs(build_id, offset);
  CREATE INDEX IF NOT EXISTS builds_status_created_at_idx
    ON builds(status, created_at);
  CREATE TABLE IF NOT EXISTS image_registry (
    image_alias TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    build_id TEXT NOT NULL,
    distro TEXT NOT NULL,
    release TEXT NOT NULL,
    based_on TEXT,
    is_master INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS build_presets (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    distro TEXT NOT NULL,
    release TEXT NOT NULL,
    packages_json TEXT NOT NULL,
    post_install_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_user_id, name)
  );
  CREATE INDEX IF NOT EXISTS image_registry_owner_created_idx
    ON image_registry(owner_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS build_presets_owner_updated_idx
    ON build_presets(owner_user_id, updated_at DESC);
`);
ensureColumn("builds", "log_bytes", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("builds", "log_next_offset", "INTEGER NOT NULL DEFAULT 0");
db.exec(`
  UPDATE builds SET
    log_bytes = COALESCE((SELECT SUM(length(CAST(chunk AS BLOB))) FROM build_logs WHERE build_id = builds.id), 0),
    log_next_offset = COALESCE((SELECT MAX(offset + length(CAST(chunk AS BLOB))) FROM build_logs WHERE build_id = builds.id), 0)
  WHERE log_bytes = 0 AND EXISTS (SELECT 1 FROM build_logs WHERE build_id = builds.id);
`);
recoverInterruptedBuilds();

const server = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    send(res, 200, { status: "ok" });
    return;
  }
  if (req.url === "/readyz") {
    try {
      await preflight();
      send(res, 200, { status: "ok" });
    } catch (error) {
      send(res, 503, {
        status: "failed",
        message: error instanceof Error ? error.message : "build worker preflight failed",
      });
    }
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/builds") {
    send(res, 404, { code: "not_found", message: "not found", retryable: false });
    return;
  }
  if (!verifyBearerToken(req.headers.authorization, token)) {
    send(res, 401, {
      code: "unauthenticated_service",
      message: "invalid build worker token",
      retryable: false,
    });
    return;
  }
  let command;
  try {
    command = await readJson(req);
    send(res, 200, await handleCommand(command));
  } catch (error) {
    send(res, 400, {
      id: `failed-${command?.requestId || "unknown"}`,
      requestId: command?.requestId || "unknown",
      type: command?.type || "GetBuildStatus",
      status: "failed",
      error: {
        code: "invalid_input",
        message: error instanceof Error ? error.message : "invalid request",
        retryable: false,
      },
      completedAt: new Date().toISOString(),
    });
  }
});

server.listen(socketPath, async () => {
  await chmod(socketPath, socketMode);
  processNextBuild();
  console.log(`incus-web build worker listening on ${socketPath}`);
});

async function handleCommand(command) {
  const invalid = validateCommand(command);
  if (invalid) return operation(command, "failed", invalid);
  try {
    switch (command.type) {
      case "DispatchBuildImage":
        return operation(command, "succeeded", await dispatchBuild(command));
      case "GetBuildStatus":
        return operation(command, "succeeded", getBuildStatus(command));
      case "ListBuildImages":
        return operation(command, "succeeded", listImages(command));
      case "SetBuildImageMaster":
        return operation(command, "succeeded", setMaster(command));
      case "ListBuildPresets":
        return operation(command, "succeeded", listPresets(command));
      case "SaveBuildPreset":
        return operation(command, "succeeded", savePreset(command));
      default:
        return operation(command, "failed", error("invalid_input", "unsupported command"));
    }
  } catch (err) {
    return operation(
      command,
      "failed",
      error(err?.code || "operation_failed", err instanceof Error ? err.message : "operation failed"),
    );
  }
}

async function dispatchBuild(command) {
  const existing = db
    .prepare("SELECT id FROM builds WHERE owner_user_id = ? AND idempotency_key = ?")
    .get(command.actor.userId, command.payload.idempotencyKey);
  if (existing) return { buildId: existing.id };

  const buildId = `build_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  runTransaction(() => {
    const queued = Number(db.prepare("SELECT COUNT(*) AS count FROM builds WHERE status = 'queued'").get().count);
    if (Number.isFinite(maxQueuedBuilds) && maxQueuedBuilds > 0 && queued >= maxQueuedBuilds) {
      throw Object.assign(new Error("build queue is full"), { code: "queue_full" });
    }
    db.prepare(
      `INSERT INTO builds
        (id, owner_user_id, idempotency_key, status, image_alias, distro, release, based_on, definition_yaml, created_at)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    ).run(
      buildId,
      command.actor.userId,
      command.payload.idempotencyKey,
      command.payload.imageAlias,
      command.payload.distro,
      command.payload.release,
      command.payload.basedOn || null,
      command.payload.definitionYaml,
      now,
    );
  });

  processNextBuild();

  return { buildId };
}

function getBuildStatus(command) {
  const row = db
    .prepare("SELECT * FROM builds WHERE id = ? AND owner_user_id = ?")
    .get(command.payload.buildId, command.actor.userId);
  if (!row) throw Object.assign(new Error("build not found"), { code: "not_found" });
  const log = readLogSince(row.id, command.payload.logOffset);
  return {
    buildId: row.id,
    status: row.status,
    imageAlias: row.image_alias,
    logOffset: log.offset,
    logChunk: log.chunk,
    error: row.error || undefined,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
  };
}

function listImages(command) {
  const rows = db
    .prepare("SELECT * FROM image_registry WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 200")
    .all(command.actor.userId);
  return {
    images: rows.map((row) => ({
      imageAlias: row.image_alias,
      ownerUserId: row.owner_user_id,
      buildId: row.build_id,
      distro: row.distro,
      release: row.release,
      basedOn: row.based_on || undefined,
      isMaster: row.is_master === 1,
      createdAt: row.created_at,
    })),
  };
}

function setMaster(command) {
  const image = db
    .prepare("SELECT image_alias FROM image_registry WHERE owner_user_id = ? AND image_alias = ?")
    .get(command.actor.userId, command.payload.imageAlias);
  if (!image) throw Object.assign(new Error("image not found"), { code: "not_found" });
  runTransaction(() => {
    db.prepare("UPDATE image_registry SET is_master = 0 WHERE owner_user_id = ?").run(command.actor.userId);
    db.prepare("UPDATE image_registry SET is_master = 1 WHERE owner_user_id = ? AND image_alias = ?").run(
      command.actor.userId,
      command.payload.imageAlias,
    );
  });
  return { imageAlias: command.payload.imageAlias };
}

function listPresets(command) {
  const rows = db
    .prepare("SELECT * FROM build_presets WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT 200")
    .all(command.actor.userId);
  return {
    presets: rows.map((row) => ({
      id: row.id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      distro: row.distro,
      release: row.release,
      packages: JSON.parse(row.packages_json),
      postInstallCommands: JSON.parse(row.post_install_json),
      updatedAt: row.updated_at,
    })),
  };
}

function savePreset(command) {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id FROM build_presets WHERE owner_user_id = ? AND name = ?")
    .get(command.actor.userId, command.payload.name);
  const id = existing?.id || `preset_${randomUUID()}`;
  db.prepare(
    `INSERT INTO build_presets
      (id, owner_user_id, name, distro, release, packages_json, post_install_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, name) DO UPDATE SET
        distro = excluded.distro,
        release = excluded.release,
        packages_json = excluded.packages_json,
        post_install_json = excluded.post_install_json,
        updated_at = excluded.updated_at`,
  ).run(
    id,
    command.actor.userId,
    command.payload.name,
    command.payload.distro,
    command.payload.release,
    JSON.stringify(command.payload.packages),
    JSON.stringify(command.payload.postInstallCommands),
    now,
  );
  return {
    preset: {
      id,
      ownerUserId: command.actor.userId,
      name: command.payload.name,
      distro: command.payload.distro,
      release: command.payload.release,
      packages: command.payload.packages,
      postInstallCommands: command.payload.postInstallCommands,
      updatedAt: now,
    },
  };
}

async function runBuild(buildId) {
  const row = db.prepare("SELECT * FROM builds WHERE id = ?").get(buildId);
  if (!row) return;
  await acquireLock();
  const dir = await mkdtemp(join(tmpdir(), "incus-web-build-"));
  try {
    updateBuild(buildId, "running", { startedAt: new Date().toISOString() });
    appendLog(buildId, "running preflight checks\n");
    await preflight();
    const definitionPath = join(dir, "definition.yaml");
    await writeFile(definitionPath, row.definition_yaml, { mode: 0o600 });
    appendLog(buildId, `starting distrobuilder for ${row.image_alias}\n`);
    await run(distrobuilderBin, [
      "build-incus",
      definitionPath,
      dir,
      "--type",
      "unified",
      `--import-into-incus=${row.image_alias}`,
    ], (text) => appendLog(buildId, text));
    const now = new Date().toISOString();
    runTransaction(() => {
      updateBuild(buildId, "succeeded", { completedAt: now });
      db.prepare(
        `INSERT OR REPLACE INTO image_registry
          (image_alias, owner_user_id, build_id, distro, release, based_on, is_master, created_at)
          VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT is_master FROM image_registry WHERE image_alias = ?), 0), ?)`,
      ).run(row.image_alias, row.owner_user_id, row.id, row.distro, row.release, row.based_on, row.image_alias, now);
    });
    appendLog(buildId, `build succeeded: ${row.image_alias}\n`);
    pruneCompletedBuilds();
  } finally {
    await releaseLock();
    await rm(dir, { recursive: true, force: true });
  }
}

function processNextBuild() {
  if (buildRunnerActive) return;
  buildRunnerActive = true;
  setImmediate(async () => {
    try {
      while (true) {
        const next = db
          .prepare("SELECT id FROM builds WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
          .get();
        if (!next) return;
        try {
          await runBuild(next.id);
        } catch (err) {
          failBuild(next.id, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      buildRunnerActive = false;
      const queued = db.prepare("SELECT id FROM builds WHERE status = 'queued' LIMIT 1").get();
      if (queued) processNextBuild();
    }
  });
}

async function preflight() {
  await run("sh", ["-lc", [
    "set -e",
    "ldd --version >/dev/null 2>&1",
    "test -f /sys/fs/cgroup/cgroup.controllers",
    "command -v newuidmap >/dev/null 2>&1",
    "command -v newgidmap >/dev/null 2>&1",
    "command -v nft >/dev/null 2>&1",
    "command -v unsquashfs >/dev/null 2>&1",
    `command -v ${shellWord(distrobuilderBin)} >/dev/null 2>&1`,
  ].join("\n")]);
}

function updateBuild(buildId, status, { startedAt, completedAt, error: errorText } = {}) {
  db.prepare(
    `UPDATE builds SET
      status = ?,
      started_at = COALESCE(?, started_at),
      completed_at = COALESCE(?, completed_at),
      error = COALESCE(?, error)
      WHERE id = ?`,
  ).run(status, startedAt || null, completedAt || null, errorText || null, buildId);
}

function failBuild(buildId, message) {
  updateBuild(buildId, "failed", { completedAt: new Date().toISOString(), error: message });
  appendLog(buildId, `build failed: ${message}\n`);
  pruneCompletedBuilds();
}

function appendLog(buildId, text) {
  if (!text) return;
  const build = db.prepare("SELECT log_bytes, log_next_offset FROM builds WHERE id = ?").get(buildId);
  if (!build) return;
  const offset = Number(build.log_next_offset);
  const addedBytes = byteLength(text);
  runTransaction(() => {
    db.prepare("INSERT INTO build_logs (build_id, offset, chunk, created_at) VALUES (?, ?, ?, ?)").run(
      buildId,
      offset,
      text,
      new Date().toISOString(),
    );
    db.prepare("UPDATE builds SET log_bytes = log_bytes + ?, log_next_offset = ? WHERE id = ?")
      .run(addedBytes, offset + addedBytes, buildId);
  });
  if (Number(build.log_bytes) + addedBytes > maxLogBytesPerBuild) pruneBuildLogs(buildId);
}

function readLogSince(buildId, since) {
  const rows = db
    .prepare(
      `SELECT offset, chunk FROM build_logs
       WHERE build_id = ? AND offset >= COALESCE(
         (SELECT MAX(offset) FROM build_logs WHERE build_id = ? AND offset <= ?),
         ?
       )
       ORDER BY offset ASC LIMIT 2048`,
    )
    .all(buildId, buildId, since, since);
  let chunk = "";
  let offset = since;
  for (const row of rows) {
    const rowOffset = Number(row.offset);
    const rowChunk = String(row.chunk);
    const rowSize = byteLength(rowChunk);
    if (rowOffset + rowSize <= since) continue;
    const start = Math.max(0, since - rowOffset);
    const part = sliceUtf8FromByte(rowChunk, start);
    const remaining = maxLogChunkBytes - Buffer.byteLength(chunk, "utf8");
    if (remaining <= 0) break;
    if (Buffer.byteLength(part, "utf8") > remaining) {
      const clipped = clipUtf8(part, remaining);
      chunk += clipped;
      offset = rowOffset + start + byteLength(clipped);
      break;
    }
    chunk += part;
    offset = rowOffset + rowSize;
  }
  return { chunk, offset };
}

function pruneBuildLogs(buildId) {
  const build = db.prepare("SELECT log_bytes, log_next_offset FROM builds WHERE id = ?").get(buildId);
  if (!build || Number(build.log_bytes) <= maxLogBytesPerBuild) return;
  const nextOffset = Number(build.log_next_offset);
  const targetOffset = Math.max(0, nextOffset - maxLogBytesPerBuild);
  const firstRetained = db.prepare(
    `SELECT offset FROM build_logs
     WHERE build_id = ? AND offset >= ? AND chunk NOT LIKE '[log truncated%'
     ORDER BY offset ASC LIMIT 1`,
  ).get(buildId, targetOffset);
  const cutoff = firstRetained ? Number(firstRetained.offset) : nextOffset;
  const total = Math.max(0, nextOffset - cutoff);
  runTransaction(() => {
    const removed = db.prepare("DELETE FROM build_logs WHERE build_id = ? AND offset < ?").run(buildId, cutoff);
    db.prepare("UPDATE builds SET log_bytes = ? WHERE id = ?").run(total, buildId);
    if (removed.changes > 0 && firstRetained) {
      const marker = `[log truncated to last ${maxLogBytesPerBuild} bytes]\n`;
      const markerOffset = Math.max(0, cutoff - byteLength(marker));
      db.prepare("INSERT INTO build_logs (build_id, offset, chunk, created_at) VALUES (?, ?, ?, ?)").run(
        buildId,
        markerOffset,
        marker,
        new Date().toISOString(),
      );
    }
  });
}

function recoverInterruptedBuilds() {
  const rows = db.prepare("SELECT id FROM builds WHERE status = 'running' ORDER BY started_at ASC").all();
  const now = new Date().toISOString();
  for (const row of rows) {
    updateBuild(row.id, "failed", {
      completedAt: now,
      error: "build worker restarted before completion",
    });
    appendLog(row.id, "build failed: build worker restarted before completion\n");
  }
}

function pruneCompletedBuilds() {
  if (!Number.isFinite(maxCompletedBuilds) || maxCompletedBuilds <= 0) return;
  const rows = db
    .prepare(
      `SELECT id FROM builds
       WHERE status IN ('succeeded', 'failed')
       ORDER BY completed_at DESC, created_at DESC
       LIMIT -1 OFFSET ?`,
    )
    .all(maxCompletedBuilds);
  runTransaction(() => {
    for (const row of rows) {
      db.prepare("DELETE FROM build_logs WHERE build_id = ?").run(row.id);
      db.prepare("DELETE FROM builds WHERE id = ?").run(row.id);
    }
  });
}

function clipUtf8(text, maxBytes) {
  if (maxBytes <= 0) return "";
  let clipped = text;
  while (Buffer.byteLength(clipped, "utf8") > maxBytes) {
    clipped = clipped.slice(0, -1);
  }
  return clipped;
}

function sliceUtf8FromByte(text, byteOffset) {
  if (byteOffset <= 0) return text;
  return Buffer.from(text, "utf8").subarray(byteOffset).toString("utf8");
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

function runTransaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function run(command, args, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child, "SIGTERM");
      killTimer = setTimeout(() => kill(child, "SIGKILL"), 1000);
      killTimer.unref();
    }, commandTimeoutMs);
    timer.unref();
    child.stdout.on("data", (data) => onOutput(data.toString()));
    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr = appendTail(stderr, text, maxStderrTailBytes);
      onOutput(text);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) reject(new Error(`${command} timed out`));
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

function appendTail(current, next, maxBytes) {
  let value = current + next;
  while (Buffer.byteLength(value, "utf8") > maxBytes) {
    value = value.slice(Math.max(1, Math.floor(value.length / 10)));
  }
  return value;
}

async function acquireLock() {
  try {
    await symlink(String(process.pid), lockPath);
  } catch {
    if (!(await removeStaleLock())) {
      throw new Error("another image build is already running");
    }
    await symlink(String(process.pid), lockPath);
  }
}

async function releaseLock() {
  await unlink(lockPath).catch(() => {});
}

async function removeStaleLock() {
  let pidText;
  try {
    pidText = await readlink(lockPath);
  } catch {
    return false;
  }
  const pid = Number.parseInt(pidText, 10);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      if (err?.code !== "ESRCH") return false;
    }
  }
  await unlink(lockPath).catch(() => {});
  return true;
}

function validateCommand(command) {
  if (!command || typeof command !== "object") return error("invalid_input", "command must be an object");
  if (command.version !== "build-worker.v1") return error("invalid_input", "unsupported build worker version");
  if (!string(command.requestId, 160)) return error("invalid_input", "requestId is required");
  if (!isCommandType(command.type)) return error("invalid_input", "unsupported command type");
  if (!command.actor || typeof command.actor.userId !== "string" || typeof command.actor.email !== "string") {
    return error("invalid_input", "actor is invalid");
  }
  if (!command.payload || typeof command.payload !== "object") return error("invalid_input", "payload is invalid");
  const payload = command.payload;

  switch (command.type) {
    case "DispatchBuildImage":
      return validateDispatchPayload(payload);
    case "GetBuildStatus":
      return validateGetStatusPayload(payload);
    case "ListBuildImages":
    case "ListBuildPresets":
      return hasOnlyKeys(payload, []) ? undefined : error("invalid_input", "payload contains unsupported fields");
    case "SetBuildImageMaster":
      return hasOnlyKeys(payload, ["imageAlias"]) && validAlias(payload.imageAlias)
        ? undefined
        : error("invalid_input", "SetBuildImageMaster payload is invalid");
    case "SaveBuildPreset":
      return validateSavePresetPayload(payload);
  }
  return undefined;
}

function validateDispatchPayload(payload) {
  if (!hasOnlyKeys(payload, dispatchPayloadKeys)) {
    return error("invalid_input", "DispatchBuildImage payload contains unsupported fields");
  }
  if (
    !string(payload.distro, 40) ||
    !string(payload.release, 80) ||
    !string(payload.definitionYaml, 200000) ||
    !validAlias(payload.imageAlias) ||
    !string(payload.idempotencyKey, 160) ||
    !arrayOfStrings(payload.packages, 200, 100) ||
    !arrayOfStrings(payload.postInstallCommands, 50, 20000) ||
    (payload.basedOn !== undefined && !validAlias(payload.basedOn))
  ) {
    return error("invalid_input", "DispatchBuildImage payload is invalid");
  }
  return undefined;
}

function validateGetStatusPayload(payload) {
  if (!hasOnlyKeys(payload, ["buildId", "logOffset"])) {
    return error("invalid_input", "GetBuildStatus payload contains unsupported fields");
  }
  if (!string(payload.buildId, 80) || !Number.isInteger(payload.logOffset) || payload.logOffset < 0) {
    return error("invalid_input", "GetBuildStatus payload is invalid");
  }
  return undefined;
}

function validateSavePresetPayload(payload) {
  if (
    !hasOnlyKeys(payload, savePresetPayloadKeys) ||
    !string(payload.name, 80) ||
    !string(payload.distro, 40) ||
    !string(payload.release, 80) ||
    !arrayOfStrings(payload.packages, 200, 100) ||
    !arrayOfStrings(payload.postInstallCommands, 50, 20000)
  ) {
    return error("invalid_input", "SaveBuildPreset payload is invalid");
  }
  return undefined;
}

function isCommandType(value) {
  return commandTypes.includes(value);
}

function validAlias(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,118}$/.test(value);
}

function string(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function arrayOfStrings(value, maxItems, maxLength) {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((entry) => typeof entry === "string" && entry.length <= maxLength)
  );
}

function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function operation(command, status, resultOrError) {
  const completedAt = new Date().toISOString();
  const base = {
    id: `build-worker-${command?.requestId || "unknown"}-${Date.now()}`,
    requestId: command?.requestId || "unknown",
    type: command?.type || "GetBuildStatus",
    status,
    completedAt,
  };
  return status === "succeeded"
    ? { ...base, result: resultOrError }
    : { ...base, error: resultOrError };
}

function error(code, message, retryable = false) {
  return { code, message, retryable };
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBodyBytes) throw new Error("request too large");
  }
  return JSON.parse(body || "{}");
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function unlinkExistingSocket(path) {
  try {
    if (await socketAcceptsConnections(path)) {
      console.error(`${path} is already accepting connections`);
      process.exit(1);
    }
    await unlink(path);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function socketAcceptsConnections(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", (err) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") resolve(false);
      else reject(err);
    });
  });
}

async function loadSQLite() {
  try {
    return await import("node:sqlite");
  } catch {
    console.error("incus-web build worker requires Node.js with node:sqlite support (Node.js 22.5+).");
    process.exit(1);
  }
}

function kill(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
