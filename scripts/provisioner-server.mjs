#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, stat, statfs, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  agentRunConfigFromEnv,
  createAgentRunStore,
  dispatchAgentRun,
  getAgentRun,
  listAgentRuns,
  reconcileAgentRuns,
} from "./agent-runs.mjs";
import { requireConfiguredToken, verifyBearerToken } from "./service-auth.mjs";

let token = process.env.INCUS_WEB_PROVISIONER_TOKEN?.trim() || "";
const socketPath =
  process.env.INCUS_WEB_PROVISIONER_SOCKET || "/run/incus-web/provisioner.sock";
const socketMode = parseMode(
  process.env.INCUS_WEB_PROVISIONER_SOCKET_MODE || "0660",
);
const host = process.env.INCUS_WEB_PROVISIONER_HOST || "";
const port = Number.parseInt(process.env.INCUS_WEB_PROVISIONER_PORT || "0", 10);
const workspaceId =
  process.env.INCUS_WEB_WORKSPACE_ID || "workspace-incus-web";
const incusProject =
  process.env.INCUS_WEB_INCUS_PROJECT || "default";
const incusContainer =
  process.env.INCUS_WEB_INCUS_CONTAINER ||
  process.env.CONTAINER_NAME ||
  "incus-web";
const prototypeSetupPhase =
  process.env.INCUS_WEB_PROTOTYPE_SETUP_PHASE || "ready";
const timeoutBudgetMs = Number.parseInt(
  process.env.INCUS_WEB_PROVISIONER_TIMEOUT_MS || "30000",
  10,
);
const commandTimeoutMs = Number.parseInt(
  process.env.INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS || String(timeoutBudgetMs),
  10,
);
const requestTimeoutMs = Number.parseInt(
  process.env.INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS || String(commandTimeoutMs + 1000),
  10,
);
const maxProcessOutputBytes = Number.parseInt(
  process.env.INCUS_WEB_PROVISIONER_MAX_OUTPUT_BYTES || "1048576",
  10,
);
const statusCacheTtlMs = Number.parseInt(
  process.env.INCUS_WEB_PROVISIONER_STATUS_CACHE_TTL_MS || "2000",
  10,
);
const maxConcurrentIncusCommands = Number.parseInt(
  process.env.INCUS_WEB_PROVISIONER_MAX_INCUS_COMMANDS || "4",
  10,
);
const maxIdempotencyRecords = Number.parseInt(
  process.env.INCUS_WEB_PROVISIONER_MAX_IDEMPOTENCY_RECORDS || "10000",
  10,
);
const readOnlyCommandTypes = new Set([
  "GetWorkspaceStatus",
  "ListWorkspaceSnapshots",
  "ListAgentRuns",
  "GetAgentRun",
]);
// The web app API route (apps/web/app/api/workspaces/[workspaceId]/golden-config/route.ts)
// stages the uploaded zip here before sending ImportGoldenConfig -- both
// processes need write/read access to this directory (see
// ensure_golden_config_staging_dir in scripts/incus-web-lib.sh, which grants
// it via the same shared INCUS_WEB_PROVISIONER_GROUP the provisioner socket
// already uses). The command channel itself stays small: the payload only
// carries a content hash, never a path.
const goldenConfigDir =
  process.env.INCUS_WEB_GOLDEN_CONFIG_DIR || "/var/lib/incus-web/golden-config";
const goldenConfigUser =
  process.env.INCUS_WEB_WORKSPACE_USER || process.env.WEB_USER || "agent";
const maxGoldenConfigBytes = Number.parseInt(
  process.env.INCUS_WEB_GOLDEN_CONFIG_MAX_BYTES || String(150 * 1024 * 1024),
  10,
);
const maxGoldenConfigEntries = Number.parseInt(
  process.env.INCUS_WEB_GOLDEN_CONFIG_MAX_ENTRIES || "5000",
  10,
);
const maxGoldenConfigExpandedBytes = Number.parseInt(
  process.env.INCUS_WEB_GOLDEN_CONFIG_MAX_EXPANDED_BYTES || String(500 * 1024 * 1024),
  10,
);
const maxGoldenConfigCompressionRatio = Number.parseInt(
  process.env.INCUS_WEB_GOLDEN_CONFIG_MAX_COMPRESSION_RATIO || "100",
  10,
);
const maxGoldenConfigDepth = Number.parseInt(
  process.env.INCUS_WEB_GOLDEN_CONFIG_MAX_DEPTH || "20",
  10,
);
const maxGoldenConfigCentralDirectoryBytes = Number.parseInt(
  process.env.INCUS_WEB_GOLDEN_CONFIG_MAX_CENTRAL_DIRECTORY_BYTES || String(16 * 1024 * 1024),
  10,
);
const maxConcurrentGoldenConfigImports = Number.parseInt(
  process.env.INCUS_WEB_GOLDEN_CONFIG_MAX_CONCURRENT_IMPORTS || "2",
  10,
);
let activeIncusCommands = 0;
let activeGoldenConfigImports = 0;
const statusCache = new Map();
const statusInFlight = new Map();
const agentRunConfig = agentRunConfigFromEnv();
let agentRunStore;
function getAgentRunStore() {
  agentRunStore ||= createAgentRunStore(agentRunConfig.storePath, {
    historyLimit: agentRunConfig.historyLimit,
  });
  return agentRunStore;
}
let idempotencyDb;
function getIdempotencyDb() {
  if (idempotencyDb) return idempotencyDb;
  const path = process.env.INCUS_WEB_PROVISIONER_STATE_DB || "/var/lib/incus-web/provisioner.sqlite";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  idempotencyDb = new DatabaseSync(path);
  idempotencyDb.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  idempotencyDb.exec(`CREATE TABLE IF NOT EXISTS provisioner_requests (
    scope_key TEXT PRIMARY KEY, command_hash TEXT NOT NULL, response_json TEXT,
    created_at TEXT NOT NULL, completed_at TEXT
  ); CREATE INDEX IF NOT EXISTS provisioner_requests_created ON provisioner_requests(created_at);`);
  return idempotencyDb;
}
const setupPhases = new Set([
  "not_configured",
  "queued",
  "installing_mise",
  "applying_dotfiles",
  "checking_tools",
  "ready",
  "failed",
]);
const workspaceHostPathRoot =
  process.env.INCUS_WEB_WORKSPACE_HOST_PATH_ROOT || "/var/lib/incus-web/workspaces";

function parseMode(value) {
  if (!/^[0-7]{3,4}$/.test(value)) {
    console.error("INCUS_WEB_PROVISIONER_SOCKET_MODE must be an octal mode");
    process.exit(1);
  }
  return Number.parseInt(value, 8);
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function assertLoopbackHost(value) {
  if (!["127.0.0.1", "::1", "localhost"].includes(value)) {
    console.error("INCUS_WEB_PROVISIONER_HOST must be loopback-only");
    process.exit(1);
  }
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) {
      throw new Error("request too large");
    }
  }
  return JSON.parse(body || "{}");
}

async function unlinkExistingSocket(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket()) {
      console.error(`${path} exists and is not a Unix socket`);
      process.exit(1);
    }
    if (await socketAcceptsConnections(path)) {
      console.error(`${path} is already accepting connections`);
      process.exit(1);
    }
    await unlink(path);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return;
    }
    throw err;
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
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(err);
    });
  });
}

function requireServiceAuth(req, res, expectedToken = token) {
  if (verifyBearerToken(req.headers.authorization, expectedToken)) {
    return true;
  }
  // Log presence/absence and length only -- never the raw header value,
  // since it may contain a partially-correct guessed token.
  console.error("provisioner auth failed", {
    remoteAddress: req.socket?.remoteAddress,
    hasAuthorizationHeader: typeof req.headers.authorization === "string",
    authorizationHeaderLength:
      typeof req.headers.authorization === "string"
        ? req.headers.authorization.length
        : 0,
  });
  send(res, 401, {
    code: "unauthenticated_service",
    message: "invalid provisioner service token",
    retryable: false,
  });
  return false;
}

function operation(command, status, resultOrError) {
  const now = new Date().toISOString();
  const base = {
    id: `host-${command.requestId || "unknown"}-${Date.now()}`,
    requestId: command.requestId || "unknown",
    type: command.type || "GetWorkspaceStatus",
    workspaceId: command.workspace?.id || "unknown",
    status,
    startedAt: now,
    completedAt: now,
  };
  if (status === "succeeded") {
    return { ...base, result: resultOrError };
  }
  return { ...base, error: resultOrError };
}

function error(code, message, retryable = false, details = undefined) {
  return { code, message, retryable, details };
}

function validateWorkspace(command) {
  if (
    command?.workspace?.id !== workspaceId ||
    command?.workspace?.incusProject !== incusProject ||
    command?.workspace?.incusContainer !== incusContainer
  ) {
    return error(
      "metadata_mismatch",
      "workspace tuple did not match host provisioner metadata",
      false,
    );
  }
  if (command.workspace.ownerUserId !== command.actor.userId) {
    return error(
      "metadata_mismatch",
      "workspace owner did not match the authenticated actor tuple",
      false,
    );
  }
  const configuredSubject = process.env.INCUS_WEB_WORKSPACE_OWNER_SUBJECT?.trim();
  const configuredEmail = process.env.INCUS_WEB_WORKSPACE_OWNER_EMAIL?.trim().toLowerCase();
  if (
    (configuredSubject && command.workspace.ownerUserId !== `oidc:${configuredSubject}`) ||
    (configuredEmail && command.actor.email.toLowerCase() !== configuredEmail)
  ) {
    return error("metadata_mismatch", "workspace owner did not match host owner policy", false);
  }
  return undefined;
}

const commandTypes = new Set([
  "CreateWorkspace", "StartWorkspace", "StopWorkspace", "RestartWorkspace",
  "GetWorkspaceStatus", "RunSetup", "DispatchAgentRun", "ListAgentRuns",
  "GetAgentRun", "SetWorkspaceLimits", "SetWorkspaceMount", "ClearWorkspaceMount",
  "CreateWorkspaceSnapshot", "ListWorkspaceSnapshots", "ImportGoldenConfig",
]);

function validateCommandEnvelope(command) {
  if (!isPlainObject(command) || !hasOnlyKeys(command, ["version", "requestId", "type", "actor", "workspace", "payload"])) {
    return error("invalid_input", "command envelope contains unsupported or missing fields");
  }
  if (command.version !== "provisioner.v1" || !commandTypes.has(command.type)) {
    return error("invalid_input", "unsupported provisioner command");
  }
  if (!boundedString(command.requestId, 1, 200)) {
    return error("invalid_input", "requestId is invalid");
  }
  if (!isPlainObject(command.actor) || !hasOnlyKeys(command.actor, ["userId", "oidcSubject", "email", "displayName"]) ||
      !boundedString(command.actor.userId, 1, 200) || !boundedString(command.actor.oidcSubject, 1, 500) ||
      !boundedString(command.actor.email, 1, 320) ||
      (command.actor.displayName !== undefined && !boundedString(command.actor.displayName, 0, 200))) {
    return error("invalid_input", "actor is invalid");
  }
  if (!isPlainObject(command.workspace) || !hasOnlyKeys(command.workspace, ["id", "ownerUserId", "incusProject", "incusContainer"]) ||
      !boundedString(command.workspace.id, 1, 200) || !boundedString(command.workspace.ownerUserId, 1, 200) ||
      !validProject(command.workspace.incusProject) || !validContainer(command.workspace.incusContainer)) {
    return error("invalid_input", "workspace ref is invalid");
  }
  return validatePayload(command.type, command.payload);
}

function validatePayload(type, payload) {
  if (!isPlainObject(payload)) return error("invalid_input", `${type} payload must be an object`);
  const empty = ["StartWorkspace", "GetWorkspaceStatus", "ClearWorkspaceMount", "ListWorkspaceSnapshots"];
  if (empty.includes(type)) return hasOnlyKeys(payload, []) ? undefined : error("invalid_input", "payload contains unsupported fields");
  switch (type) {
    case "CreateWorkspace":
      return hasOnlyKeys(payload, ["templateVersion", "resourceProfileId", "autoStart"]) && boundedString(payload.templateVersion, 1, 200) && payload.resourceProfileId === "local-dev" && typeof payload.autoStart === "boolean" ? undefined : error("invalid_input", "CreateWorkspace payload is invalid");
    case "StopWorkspace":
      return hasOnlyKeys(payload, ["force", "timeoutSeconds"]) && typeof payload.force === "boolean" && integerBetween(payload.timeoutSeconds, 1, 300) ? undefined : error("invalid_input", "StopWorkspace payload is invalid");
    case "RestartWorkspace":
      return hasOnlyKeys(payload, ["timeoutSeconds"]) && integerBetween(payload.timeoutSeconds, 1, 300) ? undefined : error("invalid_input", "RestartWorkspace payload is invalid");
    case "SetWorkspaceLimits": {
      const valid = hasOnlyKeys(payload, ["cpu", "memory"]) &&
        (payload.cpu === undefined || (typeof payload.cpu === "string" && /^\d+$/.test(payload.cpu) && Number(payload.cpu) > 0)) &&
        (payload.memory === undefined || (typeof payload.memory === "string" && /^\d+(?:\.\d+)?[KMGT]?i?B$/i.test(payload.memory) && Number.parseFloat(payload.memory) > 0));
      return valid ? undefined : error("invalid_input", "SetWorkspaceLimits payload is invalid");
    }
    case "SetWorkspaceMount":
      return hasOnlyKeys(payload, ["hostPath"]) && boundedString(payload.hostPath, 1, 1024) && payload.hostPath.startsWith("/") && !payload.hostPath.includes("\0") ? undefined : error("invalid_input", "SetWorkspaceMount payload is invalid");
    case "CreateWorkspaceSnapshot":
      return hasOnlyKeys(payload, ["name"]) && (payload.name === undefined || (boundedString(payload.name, 1, 63) && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(payload.name) && !payload.name.includes(".."))) ? undefined : error("invalid_input", "CreateWorkspaceSnapshot payload is invalid");
    case "ImportGoldenConfig":
      return hasOnlyKeys(payload, ["sha256Hex"]) && typeof payload.sha256Hex === "string" && /^[a-f0-9]{64}$/i.test(payload.sha256Hex) ? undefined : error("invalid_input", "ImportGoldenConfig payload is invalid");
    case "ListAgentRuns":
      return hasOnlyKeys(payload, ["limit"]) && integerBetween(payload.limit, 1, 100) ? undefined : error("invalid_input", "ListAgentRuns payload is invalid");
    case "GetAgentRun":
      return hasOnlyKeys(payload, ["runId"]) && typeof payload.runId === "string" && /^run_\d{14}_[a-z0-9]+$/.test(payload.runId) ? undefined : error("invalid_input", "GetAgentRun payload is invalid");
    case "DispatchAgentRun": {
      const valid = hasOnlyKeys(payload, ["agent", "repoUrl", "ref", "task"]) && ["codex", "claude"].includes(payload.agent) &&
        isAllowedAgentRepo(payload.repoUrl) &&
        boundedString(payload.task, 1, 12000) && payload.task.trim().length > 0 &&
        (payload.ref === undefined || (boundedString(payload.ref, 1, 200) && /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(payload.ref) && !payload.ref.includes("..") && !payload.ref.includes("//") && !payload.ref.endsWith("/")));
      return valid ? undefined : error("invalid_input", "DispatchAgentRun payload is invalid");
    }
    case "RunSetup": {
      const age = payload.ageKey;
      const validAge = age === undefined || (isPlainObject(age) && hasOnlyKeys(age, ["value", "persistEncrypted"]) && boundedString(age.value, 1, 200000) && isAgeIdentity(age.value) && age.persistEncrypted === false);
      return hasOnlyKeys(payload, ["dotfilesRepo", "ageKey", "skipAptScripts"]) && typeof payload.skipAptScripts === "boolean" &&
        (payload.dotfilesRepo === undefined || (boundedString(payload.dotfilesRepo, 1, 512) && isAllowedGithubHttpsRepo(payload.dotfilesRepo))) && validAge ? undefined : error("invalid_input", "RunSetup payload is invalid");
    }
    default:
      return error("invalid_input", "unsupported provisioner command");
  }
}

function isPlainObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasOnlyKeys(value, keys) { return Object.keys(value).every((key) => keys.includes(key)); }
function boundedString(value, min, max) { return typeof value === "string" && value.length >= min && value.length <= max; }
function integerBetween(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function validProject(value) { return typeof value === "string" && (value === "default" || /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,61}[A-Za-z0-9])?$/.test(value)); }
function validContainer(value) { return typeof value === "string" && (value === "incus-web" || /^ws-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)); }
function isAllowedGithubHttpsRepo(value) {
  const match = value.match(/^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return Boolean(match && match[2].length <= 100 && /^[A-Za-z0-9_.-]*[A-Za-z0-9]$/.test(match[2]) && !match[2].includes(".."));
}
function isAllowedAgentRepo(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\s\r\n]/.test(value)) return false;
  if (value.startsWith("https://") || value.startsWith("ssh://")) {
    try {
      const url = new URL(value);
      return Boolean(url.hostname && url.pathname.length > 1);
    } catch {
      return false;
    }
  }
  return /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(value);
}
function isAgeIdentity(value) {
  return value.split(/\r?\n/).some((line) => /^AGE-SECRET-KEY-[A-Z0-9-]+$/i.test(line.trim()));
}

function run(command, args, { signal, input, inputPath } = {}) {
  return new Promise((resolve, reject) => {
    let releaseSlot;
    try {
      releaseSlot = acquireIncusSlot();
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let outputBytes = 0;
    let timer;
    const child = spawn(command, args, {
      detached: true,
      stdio: [input !== undefined || inputPath ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let inputStream;
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    let stdout = "";
    let stderr = "";
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
      inputStream?.destroy();
      if (releaseSlot) releaseSlot();
      if (err) reject(err);
      else resolve(value);
    };
    const terminate = (reason) => {
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 1000).unref();
      finish(new Error(reason));
    };
    const abort = () => terminate(`${command} aborted`);
    if (inputPath) {
      inputStream = createReadStream(inputPath);
      inputStream.once("error", (error) => terminate(`${command} input failed: ${error.message}`));
      child.stdin.once("error", (error) => terminate(`${command} input pipe failed: ${error.message}`));
      inputStream.pipe(child.stdin);
    }
    const append = (target) => (data) => {
      outputBytes += data.length;
      if (outputBytes > maxProcessOutputBytes) {
        terminate(`${command} exceeded output limit`);
        return;
      }
      const value = data.toString();
      if (target === "stdout") stdout += value;
      else stderr += value;
    };
    child.stdout.on("data", append("stdout"));
    child.stderr.on("data", append("stderr"));
    timer = setTimeout(() => {
      terminate(`${command} timed out`);
    }, commandTimeoutMs);
    timer.unref();
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }
    child.on("error", (err) => {
      finish(err);
    });
    child.on("close", (code) => {
      if (code === 0) finish(undefined, stdout);
      else finish(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

function acquireIncusSlot() {
  if (activeIncusCommands >= maxConcurrentIncusCommands) {
    throw new Error("incus concurrency limit reached");
  }
  activeIncusCommands += 1;
  return () => {
    activeIncusCommands = Math.max(0, activeIncusCommands - 1);
  };
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function incusJson(args, options) {
  if (args[0] === "query" && typeof args[1] === "string") {
    const path = withIncusProject(args[1]);
    const output = await run("incus", ["query", path, ...args.slice(2)], options);
    return JSON.parse(output || "{}");
  }
  const output = await run("incus", ["--project", incusProject, ...args], options);
  return JSON.parse(output || "{}");
}

async function incusText(args, options) {
  return (await run("incus", ["--project", incusProject, ...args], options)).trim();
}

async function agentIncus(args, options) {
  return (await run("incus", args, options)).trim();
}

async function execInAgentContainer(agentRun, script, options) {
  return agentIncus(
    [
      "--project",
      agentRun.container.project,
      "exec",
      agentRun.container.name,
      "--",
      "sh",
      "-lc",
      script,
    ],
    options,
  );
}

async function readContainerFile(container, project, path, options) {
  return agentIncus(
    ["--project", project, "exec", container, "--", "cat", path],
    options,
  );
}

async function pushContainerFile(container, project, path, content, options) {
  return agentIncus(
    [
      "--project",
      project,
      "file",
      "push",
      "-",
      `${container}${path}`,
      "--mode",
      "0600",
      "--create-dirs",
    ],
    { ...options, input: content },
  );
}

async function pushContainerFileFromPath(container, project, path, sourcePath, options) {
  return agentIncus(
    [
      "--project",
      project,
      "file",
      "push",
      "-",
      `${container}${path}`,
      "--mode",
      "0600",
      "--create-dirs",
    ],
    { ...options, inputPath: sourcePath },
  );
}

async function deleteContainerFile(container, project, path, options) {
  try {
    await agentIncus(
      ["--project", project, "file", "delete", `${container}${path}`],
      options,
    );
  } catch {
    // best-effort cleanup; a failed delete shouldn't fail an otherwise
    // completed run, and the container is discarded/reused independently.
  }
}

function withIncusProject(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}project=${encodeURIComponent(incusProject)}`;
}

async function getWorkspaceStatus(command, options) {
  const state = await incusJson(
    ["query", `/1.0/instances/${incusContainer}/state`],
    options,
  );
  const instance = await incusJson(
    ["query", `/1.0/instances/${incusContainer}?recursion=1`],
    options,
  );
  const config = instance.expanded_config || instance.config || {};
  const devices = instance.expanded_devices || instance.devices || {};
  const cpuLimit = config["limits.cpu"] || "";
  const memoryLimit = config["limits.memory"] || "";
  const processesLimit = config["limits.processes"] || "";
  const rootDiskSize = devices.root?.size || "";
  const rootDiskPool = devices.root?.pool || "";
  const networkBridge = devices.eth0?.network || devices.eth0?.parent || "";
  const workspaceHostPath = devices.workspace?.source || "";
  const workspaceMountPath = devices.workspace?.path || "";

  return {
    workspaceId: command.workspace.id,
    state: mapIncusState(state.status, state.status_code),
    incusProject: command.workspace.incusProject,
    incusContainer: command.workspace.incusContainer,
    image:
      config["image.description"] ||
      config["volatile.base_image"] ||
      undefined,
    storagePool: rootDiskPool || undefined,
    networkBridge: networkBridge || undefined,
    workspaceHostPath: workspaceHostPath || undefined,
    workspaceMountPath: workspaceMountPath || undefined,
    effectiveLimits: {
      cpu: cpuLimit || undefined,
      memory: memoryLimit || undefined,
      processes: processesLimit || undefined,
    },
    cpuCount: parseCpuLimit(cpuLimit),
    memoryUsedBytes: numberValue(state.memory?.usage),
    memoryLimitBytes: parseByteLimit(memoryLimit),
    rootDiskUsedBytes: rootDiskUsage(state),
    rootDiskLimitBytes: parseByteLimit(rootDiskSize),
    setupPhase: setupPhase(
      config["user.incus-web.setup-phase"] || prototypeSetupPhase,
    ),
    lastCheckedAt: new Date().toISOString(),
  };
}

async function getCachedWorkspaceStatus(command, options) {
  const now = Date.now();
  const key = command.workspace.id;
  const cached = statusCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const inFlight = statusInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }
  const promise = getWorkspaceStatus(command, options)
    .then((status) => {
      statusCache.set(key, {
        value: status,
        expiresAt: Date.now() + statusCacheTtlMs,
      });
      return status;
    })
    .finally(() => {
      statusInFlight.delete(key);
    });
  statusInFlight.set(key, promise);
  return promise;
}

function invalidateWorkspaceStatus(command) {
  statusCache.delete(command.workspace.id);
  statusInFlight.delete(command.workspace.id);
}

async function optionalText(args, options) {
  try {
    return await incusText(args, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isUnsetIncusRead(message)) {
      return "";
    }
    console.error("optional Incus read failed", { args, message });
    throw err;
  }
}

function isUnsetIncusRead(message) {
  return [
    "not found",
    "No such object",
    "The requested key could not be found",
    "Config key not found",
    "Device from profile(s) cannot be retrieved for individual instance",
  ].some((needle) => message.includes(needle));
}

async function startWorkspace(command, options) {
  const current = await getWorkspaceStatus(command, options);
  if (current.state !== "running") {
    await incusText(["start", incusContainer], options);
  }
  invalidateWorkspaceStatus(command);
  const status = await getWorkspaceStatus(command, options);
  return {
    workspaceId: command.workspace.id,
    state: "running",
    status,
  };
}

async function stopWorkspace(command, options) {
  const timeout = String(command.payload?.timeoutSeconds ?? 30);
  const args = ["stop", incusContainer, "--timeout", timeout];
  if (command.payload?.force) {
    args.push("--force");
  }
  const current = await getWorkspaceStatus(command, options);
  if (current.state !== "stopped") {
    await incusText(args, options);
  }
  invalidateWorkspaceStatus(command);
  return {
    workspaceId: command.workspace.id,
    state: "stopped",
    status: await getWorkspaceStatus(command, options),
  };
}

async function restartWorkspace(command, options) {
  const timeout = String(command.payload?.timeoutSeconds ?? 30);
  const current = await getWorkspaceStatus(command, options);
  if (current.state === "running") {
    await incusText(["restart", incusContainer, "--timeout", timeout], options);
  } else {
    await incusText(["start", incusContainer], options);
  }
  invalidateWorkspaceStatus(command);
  return {
    workspaceId: command.workspace.id,
    state: "running",
    status: await getWorkspaceStatus(command, options),
  };
}

// Mirrors apps/web/lib/provisioner/contracts.ts's validateSetWorkspaceLimitsPayload
// exactly. The web app already validates before sending a command, but this
// process is a separate trust boundary reachable by anything holding the
// bearer token (INCUS_WEB_PROVISIONER_TOKEN) -- it must not assume the
// caller already validated, the same way validateWorkspace() below never
// assumes the caller sent a real workspace tuple.
// Incus limits.cpu is an integer CPU count (fractional allowances live under
// the separate limits.cpu.allowance key), so fractional values here are
// rejected instead of silently failing at the `incus config set` boundary.
const CPU_LIMIT_PATTERN = /^\d+$/;
const MEMORY_LIMIT_PATTERN = /^\d+(\.\d+)?[kmgt]?i?b$/i;
const LIMIT_PAYLOAD_KEYS = ["cpu", "memory"];
const MOUNT_PAYLOAD_KEYS = ["hostPath"];
const SNAPSHOT_PAYLOAD_KEYS = ["name"];
const GOLDEN_CONFIG_PAYLOAD_KEYS = ["sha256Hex"];

function isPositiveLimitValue(value) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) && numeric > 0;
}

function validatePayloadObject(payload, commandName, allowedKeys) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return `${commandName} payload must be an object`;
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      return `${commandName} payload contains unsupported fields`;
    }
  }
  return undefined;
}

function validateLimitsPayload(payload) {
  const invalidReason = validatePayloadObject(payload, "SetWorkspaceLimits", LIMIT_PAYLOAD_KEYS);
  if (invalidReason) return invalidReason;

  const cpu = payload.cpu;
  const memory = payload.memory;
  if (
    cpu !== undefined &&
    (typeof cpu !== "string" ||
      cpu.length === 0 ||
      !CPU_LIMIT_PATTERN.test(cpu) ||
      !isPositiveLimitValue(cpu))
  ) {
    return "cpu must be a positive number string";
  }
  if (
    memory !== undefined &&
    (typeof memory !== "string" ||
      memory.length === 0 ||
      !MEMORY_LIMIT_PATTERN.test(memory) ||
      !isPositiveLimitValue(memory))
  ) {
    return "memory must be a positive byte-size string with a unit, like 4GiB or 512MB";
  }
  return undefined;
}

function validateMountPayload(payload) {
  const invalidReason = validatePayloadObject(payload, "SetWorkspaceMount", MOUNT_PAYLOAD_KEYS);
  if (invalidReason) return invalidReason;

  if (
    typeof payload.hostPath !== "string" ||
    payload.hostPath.length === 0 ||
    payload.hostPath.length > 1024 ||
    !payload.hostPath.startsWith("/") ||
    payload.hostPath.includes("\0")
  ) {
    return "hostPath must be an absolute host path";
  }
  return undefined;
}

const SNAPSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;

function validateSnapshotPayload(payload) {
  const invalidReason = validatePayloadObject(payload, "CreateWorkspaceSnapshot", SNAPSHOT_PAYLOAD_KEYS);
  if (invalidReason) return invalidReason;

  if (
    payload.name !== undefined &&
    (typeof payload.name !== "string" ||
      !SNAPSHOT_NAME_PATTERN.test(payload.name) ||
      payload.name.includes(".."))
  ) {
    return "snapshot name must be 1-63 letters, numbers, dots, dashes, or underscores";
  }
  return undefined;
}

async function assertAllowedWorkspaceHostPath(command) {
  const invalidReason = validateMountPayload(command.payload);
  if (invalidReason) {
    throw Object.assign(new Error(invalidReason), { code: "invalid_input" });
  }

  const hostPath = command.payload.hostPath;
  const expectedRoot = await realpath(workspaceHostPathRoot);
  const allowedPrefix = `${expectedRoot.replace(/\/+$/, "")}/${command.workspace.id}/`;
  const finalStat = await lstat(hostPath);
  if (finalStat.isSymbolicLink()) {
    throw Object.assign(new Error("workspace mount path must not be a symlink"), {
      code: "invalid_input",
    });
  }
  if (!finalStat.isDirectory()) {
    throw Object.assign(new Error("workspace mount path must be an existing directory"), {
      code: "invalid_input",
    });
  }
  const resolved = `${await realpath(hostPath)}/`;
  if (!resolved.startsWith(allowedPrefix)) {
    throw Object.assign(
      new Error(`workspace mount path must stay under ${allowedPrefix}`),
      { code: "invalid_input" },
    );
  }
  return resolved.slice(0, -1);
}

// `incus config unset` exits non-zero when the key is already unset, so a
// bare optionalText()-wrapped unset would swallow every failure -- daemon
// down, permission denied, timeout -- as if it were that one idempotent
// case. Reading the current value first (config get is safe to no-op via
// optionalText, same as getWorkspaceStatus's reads) and only unsetting when
// something is actually set keeps the idempotency check separate from error
// handling: a real unset failure still throws and surfaces as a failed
// operation instead of a silent no-op success.
async function clearLimitIfSet(container, key, options) {
  const current = await optionalText(["config", "get", container, key], options);
  if (current !== "") {
    await incusText(["config", "unset", container, key], options);
  }
}

async function setWorkspaceLimits(command, options) {
  const invalidReason = validateLimitsPayload(command.payload);
  if (invalidReason) {
    throw Object.assign(new Error(invalidReason), { code: "invalid_input" });
  }

  const cpu = command.payload?.cpu;
  const memory = command.payload?.memory;

  if (cpu !== undefined) {
    await incusText(["config", "set", incusContainer, `limits.cpu=${cpu}`], options);
  } else {
    await clearLimitIfSet(incusContainer, "limits.cpu", options);
  }

  if (memory !== undefined) {
    await incusText(["config", "set", incusContainer, `limits.memory=${memory}`], options);
  } else {
    await clearLimitIfSet(incusContainer, "limits.memory", options);
  }

  invalidateWorkspaceStatus(command);
  return workspaceStatusResult(command, options);
}

async function setWorkspaceMount(command, options) {
  const hostPath = await assertAllowedWorkspaceHostPath(command);
  await incusText([
    "config",
    "device",
    "override",
    incusContainer,
    "workspace",
    `source=${hostPath}`,
    "path=/workspace",
    "shift=true",
  ], options);

  invalidateWorkspaceStatus(command);
  return workspaceStatusResult(command, options);
}

async function clearWorkspaceMount(command, options) {
  // Incus disk device overrides clear correctly by PATCHing the instance
  // device map with the `source` key omitted. Setting source="" leaves an
  // explicit empty override behind, which is the exact production footgun
  // this command is meant to avoid.
  const instance = await incusJson(["query", `/1.0/instances/${incusContainer}`], options);
  const devices = { ...(instance.devices || {}) };
  const workspace = { ...(devices.workspace || {}) };
  delete workspace.source;
  devices.workspace = workspace;
  await incusJson(
    ["query", `/1.0/instances/${incusContainer}`, "-X", "PATCH"],
    { ...options, input: JSON.stringify({ devices }) },
  );

  invalidateWorkspaceStatus(command);
  return workspaceStatusResult(command, options);
}

async function workspaceStatusResult(command, options) {
  const status = await getWorkspaceStatus(command, options);
  return {
    workspaceId: command.workspace.id,
    state: status.state === "running" ? "running" : "stopped",
    status,
  };
}

function generatedSnapshotName() {
  return `manual-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z")}`;
}

function normalizeSnapshot(snapshot) {
  const rawName =
    typeof snapshot?.name === "string"
      ? snapshot.name
      : typeof snapshot === "string"
        ? snapshot.split("/").pop()
        : "";
  const name = rawName.includes("/") ? rawName.split("/").pop() : rawName;
  return {
    name,
    createdAt:
      typeof snapshot?.created_at === "string" && snapshot.created_at.length > 0
        ? snapshot.created_at
        : undefined,
    stateful: Boolean(snapshot?.stateful),
  };
}

async function listWorkspaceSnapshots(command, options) {
  const snapshots = await incusJson(
    ["query", `/1.0/instances/${incusContainer}/snapshots?recursion=1`],
    options,
  );
  return {
    workspaceId: command.workspace.id,
    snapshots: (Array.isArray(snapshots) ? snapshots : [])
      .map(normalizeSnapshot)
      .filter((snapshot) => snapshot.name),
  };
}

async function createWorkspaceSnapshot(command, options) {
  const invalidReason = validateSnapshotPayload(command.payload);
  if (invalidReason) {
    throw Object.assign(new Error(invalidReason), { code: "invalid_input" });
  }
  const name = command.payload?.name || generatedSnapshotName();
  await incusText(["snapshot", incusContainer, name], options);
  return {
    workspaceId: command.workspace.id,
    snapshot: {
      name,
      createdAt: new Date().toISOString(),
      stateful: false,
    },
  };
}

// Mirrors apps/web/lib/provisioner/contracts.ts's
// validateImportGoldenConfigPayload -- same separate-trust-boundary
// reasoning as validateLimitsPayload above.
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

function validateGoldenConfigPayload(payload) {
  const invalidReason = validatePayloadObject(payload, "ImportGoldenConfig", GOLDEN_CONFIG_PAYLOAD_KEYS);
  if (invalidReason) return invalidReason;

  if (typeof payload.sha256Hex !== "string" || !SHA256_HEX_PATTERN.test(payload.sha256Hex)) {
    return "sha256Hex must be a 64-character hex sha256 digest";
  }
  return undefined;
}

function goldenConfigFailure(message) {
  return Object.assign(new Error(message), { code: "golden_config_failed" });
}

// The staged path is content-addressed by the validated workspace tuple and
// declared hash. Concurrent imports for one workspace therefore never replace
// or unlink each other's archive, while callers still cannot supply a path.
function stagedGoldenConfigPath(command) {
  return join(
    goldenConfigDir,
    `${command.workspace.id}-${command.payload.sha256Hex.toLowerCase()}.zip`,
  );
}

const GOLDEN_CONFIG_CONTAINER_ZIP_PATH = "/tmp/incus-web-golden-config.zip";
const GOLDEN_CONFIG_CONTAINER_EXTRACT_DIR = "/tmp/incus-web-golden-config-extract";
const GOLDEN_CONFIG_MANIFEST_MARKER = "___INCUS_WEB_GOLDEN_CONFIG_MANIFEST___";

// Extraction is a single exec script (rather than one exec call per step)
// to keep the number of `incus exec` process spawns down for what's
// already a heavier-than-usual operation. It merges claude/ and codex/
// from the zip into the workspace user's existing ~/.claude and ~/.codex
// (cp -a over the top, not a wipe-and-replace) so re-importing an updated
// golden config doesn't destroy container-local state the export never
// captured (session sockets, caches, etc. -- see scripts/export-onboarding.mjs
// for what it deliberately excludes).
function goldenConfigExtractScript(user) {
  const home = `/home/${user}`;
  return [
    "set -e",
    `trap 'rm -rf ${GOLDEN_CONFIG_CONTAINER_EXTRACT_DIR} ${GOLDEN_CONFIG_CONTAINER_ZIP_PATH}' EXIT`,
    `rm -rf ${GOLDEN_CONFIG_CONTAINER_EXTRACT_DIR}`,
    `mkdir -p ${GOLDEN_CONFIG_CONTAINER_EXTRACT_DIR}`,
    `cd ${GOLDEN_CONFIG_CONTAINER_EXTRACT_DIR}`,
    'command -v unzip >/dev/null 2>&1 || { echo "unzip is not installed in this container image" >&2; exit 42; }',
    `unzip -q -o ${GOLDEN_CONFIG_CONTAINER_ZIP_PATH} -d .`,
    `mkdir -p ${home}/.claude ${home}/.codex`,
    `[ -d claude ] && cp -a claude/. ${home}/.claude/ || true`,
    `[ -d codex ] && cp -a codex/. ${home}/.codex/ || true`,
    `chown -R ${user}:${user} ${home}/.claude ${home}/.codex`,
    'find claude codex -type f 2>/dev/null | wc -l',
    `printf '%s' "${GOLDEN_CONFIG_MANIFEST_MARKER}"`,
    "cat manifest.json 2>/dev/null || printf '{}'",
    `cd / && rm -rf ${GOLDEN_CONFIG_CONTAINER_EXTRACT_DIR} ${GOLDEN_CONFIG_CONTAINER_ZIP_PATH}`,
  ].join(" && ");
}

// Matches the manifest.json shape scripts/export-onboarding.mjs writes:
// `warnings` is already string[] (e.g. an expected top-level item was
// missing from the source), while `skipped` is an [{path, reason}] array
// that can run to hundreds of entries (excluded dirs, oversized files) --
// summarized as a single count here rather than enumerated, to stay well
// under contracts.ts's validateImportGoldenConfigResult caps (50 entries,
// 2000 chars each).
function parseGoldenConfigWarnings(manifestJson) {
  try {
    const manifest = JSON.parse(manifestJson);
    const warnings = Array.isArray(manifest.warnings)
      ? manifest.warnings.filter((entry) => typeof entry === "string")
      : [];
    if (Array.isArray(manifest.skipped) && manifest.skipped.length > 0) {
      warnings.push(
        `${manifest.skipped.length} item(s) were skipped during export (see the export's manifest.json for details)`,
      );
    }
    return warnings.slice(0, 50).map((entry) => entry.slice(0, 2000));
  } catch {
    return [];
  }
}

async function importGoldenConfig(command, options) {
  const invalidReason = validateGoldenConfigPayload(command.payload);
  if (invalidReason) {
    throw Object.assign(new Error(invalidReason), { code: "invalid_input" });
  }

  const stagedPath = stagedGoldenConfigPath(command);
  let stagedStat;
  try {
    stagedStat = await stat(stagedPath);
  } catch {
    throw Object.assign(
      new Error("no staged golden config upload was found for this workspace"),
      { code: "invalid_input" },
    );
  }
  if (stagedStat.size > maxGoldenConfigBytes) {
    await unlink(stagedPath).catch(() => {});
    throw Object.assign(new Error("staged golden config exceeds the size limit"), {
      code: "invalid_input",
    });
  }
  if (activeGoldenConfigImports >= maxConcurrentGoldenConfigImports) {
    throw Object.assign(new Error("too many golden config imports are active"), {
      code: "timeout",
    });
  }
  activeGoldenConfigImports += 1;

  try {
    const actualHash = await sha256File(stagedPath);
    if (actualHash !== command.payload.sha256Hex.toLowerCase()) {
      throw Object.assign(
        new Error("staged golden config content did not match the declared sha256Hex"),
        { code: "invalid_input" },
      );
    }
    await preflightGoldenConfigArchive(stagedPath, stagedStat.size);
    await pushContainerFileFromPath(
      incusContainer,
      incusProject,
      GOLDEN_CONFIG_CONTAINER_ZIP_PATH,
      stagedPath,
      options,
    );
    let stdout;
    try {
      stdout = await execInAgentContainer(
        { container: { name: incusContainer, project: incusProject } },
        goldenConfigExtractScript(goldenConfigUser),
        options,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw goldenConfigFailure(
        message.includes("exit status 42") || message.includes("unzip is not installed")
          ? "unzip is not installed in this container image"
          : `failed to extract golden config: ${message}`,
      );
    }

    const markerIndex = stdout.indexOf(GOLDEN_CONFIG_MANIFEST_MARKER);
    const fileCountText = (markerIndex === -1 ? stdout : stdout.slice(0, markerIndex)).trim();
    const manifestJson = markerIndex === -1 ? "{}" : stdout.slice(markerIndex + GOLDEN_CONFIG_MANIFEST_MARKER.length);
    const fileCount = Number.parseInt(fileCountText, 10);
    return {
      workspaceId: command.workspace.id,
      extractedAt: new Date().toISOString(),
      fileCount: Number.isFinite(fileCount) && fileCount >= 0 ? fileCount : 0,
      warnings: parseGoldenConfigWarnings(manifestJson),
    };
  } finally {
    activeGoldenConfigImports -= 1;
    await unlink(stagedPath).catch(() => {});
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function preflightGoldenConfigArchive(stagedPath, archiveSize) {
  const file = await open(stagedPath, "r");
  let content;
  let entryCount;
  try {
    const tailLength = Math.min(archiveSize, 65557);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, archiveSize - tailLength);
    const tailEocd = findZipEocd(tail);
    if (tailEocd < 0 || tail.readUInt32LE(tailEocd) !== 0x06054b50) {
      throw Object.assign(new Error("staged golden config is not a valid ZIP archive"), { code: "invalid_input" });
    }
    entryCount = tail.readUInt16LE(tailEocd + 10);
    const centralSize = tail.readUInt32LE(tailEocd + 12);
    const centralOffset = tail.readUInt32LE(tailEocd + 16);
    const absoluteEocd = archiveSize - tailLength + tailEocd;
    if (
      entryCount > maxGoldenConfigEntries ||
      centralSize > maxGoldenConfigCentralDirectoryBytes ||
      centralOffset + centralSize > absoluteEocd
    ) {
      throw Object.assign(new Error("golden config ZIP exceeds entry limits or has an invalid directory"), { code: "invalid_input" });
    }
    content = Buffer.alloc(centralSize);
    const { bytesRead } = await file.read(content, 0, centralSize, centralOffset);
    if (bytesRead !== centralSize) {
      throw Object.assign(new Error("golden config ZIP central directory is truncated"), { code: "invalid_input" });
    }
  } finally {
    await file.close();
  }
  let offset = 0;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > content.length || content.readUInt32LE(offset) !== 0x02014b50) {
      throw Object.assign(new Error("golden config ZIP central directory is invalid"), { code: "invalid_input" });
    }
    const compressed = content.readUInt32LE(offset + 20);
    const expanded = content.readUInt32LE(offset + 24);
    const nameLength = content.readUInt16LE(offset + 28);
    const extraLength = content.readUInt16LE(offset + 30);
    const commentLength = content.readUInt16LE(offset + 32);
    const externalAttributes = content.readUInt32LE(offset + 38);
    if (offset + 46 + nameLength + extraLength + commentLength > content.length) {
      throw Object.assign(new Error("golden config ZIP central directory is truncated"), { code: "invalid_input" });
    }
    const name = content.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const normalized = name.replaceAll("\\", "/");
    const segments = normalized.split("/").filter(Boolean);
    const unixMode = externalAttributes >>> 16;
    if (!name || name.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || segments.includes("..") || segments.length > maxGoldenConfigDepth) {
      throw Object.assign(new Error("golden config ZIP contains an unsafe path"), { code: "invalid_input" });
    }
    if ((unixMode & 0o170000) === 0o120000) {
      throw Object.assign(new Error("golden config ZIP may not contain symbolic links"), { code: "invalid_input" });
    }
    if (segments.some((part) => /^(?:auth\.json|credentials\.json|\.ssh|id_rsa|id_ed25519)$/i.test(part))) {
      throw Object.assign(new Error("golden config ZIP contains credential material; secrets must be excluded or supplied through the encrypted credential path"), { code: "invalid_input" });
    }
    expandedBytes += expanded;
    if (expandedBytes > maxGoldenConfigExpandedBytes || (expanded > 0 && expanded / Math.max(1, compressed) > maxGoldenConfigCompressionRatio)) {
      throw Object.assign(new Error("golden config ZIP exceeds expanded-size or compression-ratio limits"), { code: "invalid_input" });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const filesystem = await statfs(dirname(stagedPath));
  const available = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (expandedBytes > Math.max(0, available - 64 * 1024 * 1024)) {
    throw Object.assign(new Error("insufficient free space to safely extract golden config ZIP"), { code: "invalid_input" });
  }
}

function findZipEocd(content) {
  const minimum = Math.max(0, content.length - 65557);
  for (let offset = content.length - 22; offset >= minimum; offset -= 1) {
    if (content.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function mapIncusState(status, statusCode) {
  if (typeof status === "string") {
    switch (status.toLowerCase()) {
      case "running":
        return "running";
      case "stopped":
        return "stopped";
      default:
        return "degraded";
    }
  }
  switch (statusCode) {
    case 103:
      return "running";
    case 102:
      return "stopped";
    default:
      return "degraded";
  }
}

function parseCpuLimit(value) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function rootDiskUsage(state) {
  const disks = state.disk;
  if (!disks || typeof disks !== "object") return undefined;
  const root = disks.root;
  if (root && typeof root === "object") {
    return numberValue(root.usage);
  }
  for (const value of Object.values(disks)) {
    if (value && typeof value === "object") {
      const usage = numberValue(value.usage);
      if (usage !== undefined) return usage;
    }
  }
  return undefined;
}

function setupPhase(value) {
  return setupPhases.has(value) ? value : "not_configured";
}

function parseByteLimit(value) {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)([kmgt]?i?b?)?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const unit = (match[2] || "b").toLowerCase();
  const multipliers = {
    b: 1,
    k: 1000,
    kb: 1000,
    kib: 1024,
    m: 1000 ** 2,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    g: 1000 ** 3,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    t: 1000 ** 4,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
  };
  return Math.round(amount * (multipliers[unit] || 1));
}

export async function handleCommand(command, options = {}) {
  const invalid = validateCommandEnvelope(command);
  if (invalid) return operation(command, "failed", invalid);
  const mismatch = validateWorkspace(command);
  if (mismatch) {
    return operation(command, "failed", mismatch);
  }
  if (readOnlyCommandTypes.has(command.type)) {
    return executeCommand(command, options);
  }
  const db = options.idempotencyDb || getIdempotencyDb();
  const scopeKey = `${command.actor.userId}\0${command.workspace.id}\0${command.requestId}`;
  const commandHash = createHash("sha256").update(stableJson(command)).digest("hex");
  const prior = db.prepare("SELECT command_hash, response_json FROM provisioner_requests WHERE scope_key = ?").get(scopeKey);
  if (prior) {
    if (prior.command_hash !== commandHash) {
      return operation(command, "failed", error("invalid_input", "requestId was already used with a different command"));
    }
    if (prior.response_json) return JSON.parse(prior.response_json);
    return operation(command, "failed", error("operation_failed", "request outcome is still pending or was interrupted; the mutation will not be repeated", false));
  }
  db.prepare("INSERT INTO provisioner_requests (scope_key, command_hash, created_at) VALUES (?, ?, ?)")
    .run(scopeKey, commandHash, new Date().toISOString());
  db.prepare(`DELETE FROM provisioner_requests WHERE scope_key IN (
    SELECT scope_key FROM provisioner_requests WHERE response_json IS NOT NULL
    ORDER BY created_at DESC LIMIT -1 OFFSET ?
  )`).run(maxIdempotencyRecords);
  const response = await executeCommand(command, options);
  db.prepare("UPDATE provisioner_requests SET response_json = ?, completed_at = ? WHERE scope_key = ?")
    .run(JSON.stringify(response), new Date().toISOString(), scopeKey);
  return response;
}

async function executeCommand(command, options) {
  try {
    switch (command.type) {
      case "GetWorkspaceStatus":
        return operation(
          command,
          "succeeded",
          await getCachedWorkspaceStatus(command, options),
        );
      case "StartWorkspace":
        return operation(
          command,
          "succeeded",
          await startWorkspace(command, options),
        );
      case "StopWorkspace":
        return operation(
          command,
          "succeeded",
          await stopWorkspace(command, options),
        );
      case "RestartWorkspace":
        return operation(
          command,
          "succeeded",
          await restartWorkspace(command, options),
        );
      case "SetWorkspaceLimits":
        return operation(
          command,
          "succeeded",
          await setWorkspaceLimits(command, options),
        );
      case "SetWorkspaceMount":
        return operation(
          command,
          "succeeded",
          await setWorkspaceMount(command, options),
        );
      case "ClearWorkspaceMount":
        return operation(
          command,
          "succeeded",
          await clearWorkspaceMount(command, options),
        );
      case "CreateWorkspaceSnapshot":
        return operation(
          command,
          "succeeded",
          await createWorkspaceSnapshot(command, options),
        );
      case "ListWorkspaceSnapshots":
        return operation(
          command,
          "succeeded",
          await listWorkspaceSnapshots(command, options),
        );
      case "ImportGoldenConfig":
        return operation(
          command,
          "succeeded",
          await importGoldenConfig(command, options),
        );
      case "DispatchAgentRun":
        return operation(
          command,
          "succeeded",
          await dispatchAgentRun(command, {
            config: agentRunConfig,
            store: getAgentRunStore(),
            incus: (args) => agentIncus(args, options),
            execInContainer: (agentRun, script) =>
              execInAgentContainer(agentRun, script, options),
            readHostCredential: (container, project, path) =>
              readContainerFile(container, project, path, options),
            injectCredential: (container, project, path, content) =>
              pushContainerFile(container, project, path, content, options),
            deleteInjectedCredential: (container, project, path) =>
              deleteContainerFile(container, project, path, options),
          }),
        );
      case "ListAgentRuns":
        return operation(
          command,
          "succeeded",
          await listAgentRuns(command, {
            config: agentRunConfig,
            store: getAgentRunStore(),
          }),
        );
      case "GetAgentRun":
        return operation(
          command,
          "succeeded",
          await getAgentRun(command, {
            config: agentRunConfig,
            store: getAgentRunStore(),
          }),
        );
      default:
        return operation(
          command,
          "failed",
          error(
            "invalid_state",
            `${command.type} is not enabled in the host provisioner yet`,
          ),
        );
    }
  } catch (err) {
    if (err && ["invalid_input", "invalid_state", "timeout", "golden_config_failed"].includes(err.code)) {
      return operation(
        command,
        "failed",
        error(err.code, err.message, err.code === "timeout"),
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn("workspace operation failed", {
      type: command?.type,
      requestId: command?.requestId,
      workspaceId: command?.workspace?.id,
      message,
    });
    return operation(
      command,
      "failed",
      error(
        message.includes("concurrency limit") ? "timeout" : "incus_unavailable",
        message.includes("concurrency limit")
          ? "workspace operation is temporarily busy"
          : "failed to complete workspace operation through Incus",
        true,
      ),
    );
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createProvisionerServer({ authToken = token, commandHandler = handleCommand } = {}) {
  if (!authToken) throw new Error("INCUS_WEB_PROVISIONER_TOKEN is required");
  return createServer(async (req, res) => {
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), requestTimeoutMs);
    requestTimer.unref();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      if (req.method !== "POST" || req.url !== "/v1/operations") {
        send(res, 404, { error: "not found" });
        return;
      }
      if (!requireServiceAuth(req, res, authToken)) return;
      send(res, 200, await commandHandler(await readJson(req), {
        signal: controller.signal,
      }));
    } catch (err) {
      send(res, 400, {
        code: "invalid_input",
        message: err instanceof Error ? err.message : "invalid request",
        retryable: false,
      });
    } finally {
      clearTimeout(requestTimer);
    }
  });
}

export async function startProvisionerServer() {
  token = requireConfiguredToken(
    process.env.INCUS_WEB_PROVISIONER_TOKEN,
    "INCUS_WEB_PROVISIONER_TOKEN",
  );
  const store = getAgentRunStore();
  await reconcileAgentRuns({
    config: agentRunConfig,
    store,
    incus: (args) => agentIncus(args),
    execInContainer: (agentRun, script) => execInAgentContainer(agentRun, script),
    readHostCredential: (container, project, path) => readContainerFile(container, project, path),
    injectCredential: (container, project, path, content) => pushContainerFile(container, project, path, content),
    deleteInjectedCredential: (container, project, path) => deleteContainerFile(container, project, path),
  });
  const server = createProvisionerServer({ authToken: token });
  if (host && port > 0) {
    assertLoopbackHost(host);
    server.listen(port, host, () => {
      console.log(`incus-web provisioner listening on http://${host}:${port}`);
    });
  } else {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o755 });
    await unlinkExistingSocket(socketPath);
    server.listen(socketPath, async () => {
      await chmod(socketPath, socketMode);
      console.log(`incus-web provisioner listening on ${socketPath}`);
    });
  }
  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await startProvisionerServer();
}
