import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer as createNetServer } from "node:net";
import { connect as createTlsConnection } from "node:tls";
import { DatabaseSync } from "node:sqlite";

export const CODEX_APP_SERVER_NOT_CONFIGURED =
  "Codex app-server controller is not configured for this host.";

const terminalPhases = new Set(["succeeded", "failed"]);
const defaultAgentRunLogLimit = 5000;
const defaultAgentRunHistoryLimit = 1000;
const websocketHandshakeLimitBytes = 1024 * 1024;
const websocketFrameLimitBytes = 1024 * 1024;
const websocketMessageLimitBytes = 1024 * 1024;
const websocketHandshakeDelimiter = Buffer.from("\r\n\r\n", "latin1");
const schedulerStates = new WeakMap();

export function agentRunConfigFromEnv(env = process.env) {
  const incusProject = env.INCUS_WEB_INCUS_PROJECT || "default";
  return {
    storePath:
      env.INCUS_WEB_AGENT_RUN_STORE_PATH || "/var/lib/incus-web/agent-runs.sqlite",
    goldenContainer:
      env.INCUS_WEB_AGENT_GOLDEN_CONTAINER || "incus-web-agent-golden",
    goldenProject: env.INCUS_WEB_AGENT_GOLDEN_PROJECT || incusProject,
    runProject: env.INCUS_WEB_AGENT_RUN_PROJECT || incusProject,
    credentialSourceContainer:
      env.INCUS_WEB_AGENT_CREDENTIAL_SOURCE_CONTAINER || "incus-web",
    credentialSourceProject:
      env.INCUS_WEB_AGENT_CREDENTIAL_SOURCE_PROJECT || incusProject,
    codexAppServerUrl: env.INCUS_WEB_CODEX_APP_SERVER_URL?.trim() || "",
    codexAppServerToken: env.INCUS_WEB_CODEX_APP_SERVER_TOKEN?.trim() || "",
    codexModel: env.INCUS_WEB_CODEX_MODEL?.trim() || "",
    codexAppServerTimeoutMs: Number.parseInt(
      env.INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS || "43200000",
      10,
    ),
    claudeCommandTemplate:
      env.INCUS_WEB_CLAUDE_COMMAND_TEMPLATE || "claude -p {{task}}",
    maxConcurrentRuns: positiveInteger(env.INCUS_WEB_AGENT_RUN_MAX_CONCURRENT, 2),
    maxQueuedRuns: positiveInteger(env.INCUS_WEB_AGENT_RUN_MAX_QUEUED, 100),
    historyLimit: positiveInteger(
      env.INCUS_WEB_AGENT_RUN_HISTORY_LIMIT,
      defaultAgentRunHistoryLimit,
    ),
  };
}

export function createAgentRunStore(path, options = {}) {
  mkdirSyncParent(path);
  const legacyMigration = stageLegacyJson(path);
  const legacyRuns = legacyMigration.runs;
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      run_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_runs_workspace_created
      ON agent_runs(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS agent_runs_status_created
      ON agent_runs(status, created_at ASC);
    CREATE TABLE IF NOT EXISTS agent_run_logs (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_run_logs_run_sequence
      ON agent_run_logs(run_id, sequence DESC);
    `);
    if (legacyRuns.length > 0) {
      const insertLegacy = db.prepare(`INSERT OR IGNORE INTO agent_runs
      (id, request_id, workspace_id, owner_user_id, status, phase, created_at, updated_at, run_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertLegacyLog = db.prepare(
        "INSERT INTO agent_run_logs (run_id, at, level, message) VALUES (?, ?, ?, ?)",
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const legacy of legacyRuns) {
          const migrated = {
            ...legacy,
            requestId: legacy.requestId || `legacy-${legacy.id}`,
            requestFingerprint: legacy.requestFingerprint || "legacy",
          };
          insertLegacy.run(migrated.id, migrated.requestId, migrated.workspaceId,
            migrated.ownerUserId, migrated.status, migrated.phase, migrated.createdAt,
            migrated.updatedAt || migrated.createdAt, JSON.stringify(migrated));
          for (const entry of Array.isArray(legacy.logs) ? legacy.logs.slice(-agentRunLogLimit()) : []) {
            insertLegacyLog.run(migrated.id, entry.at || migrated.createdAt,
              entry.level || "info", String(entry.message || ""));
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } catch (error) {
    db?.close();
    restoreStagedLegacyJson(legacyMigration);
    throw error;
  }
  const historyLimit = positiveInteger(options.historyLimit, agentRunHistoryLimit());
  const transaction = (fn) => (...args) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  function rowToRun(row, includeLogs = true) {
    if (!row) return undefined;
    const run = JSON.parse(row.run_json);
    if (includeLogs) {
      run.logs = db.prepare(`
        SELECT at, level, message FROM agent_run_logs
        WHERE run_id = ? ORDER BY sequence DESC LIMIT ?
      `).all(run.id, agentRunLogLimit()).reverse();
    }
    return run;
  }

  function updateRun(runId, patch, includeLogs = true) {
    const row = db.prepare("SELECT run_json FROM agent_runs WHERE id = ?").get(runId);
    if (!row) throw new Error(`agent run not found: ${runId}`);
    const current = JSON.parse(row.run_json);
    const next = {
      ...current,
      ...patch,
      container: { ...current.container, ...(patch.container || {}) },
      controller: patch.controller === undefined ? current.controller : patch.controller,
      updatedAt: patch.updatedAt || new Date().toISOString(),
    };
    db.prepare(`UPDATE agent_runs SET status = ?, phase = ?, updated_at = ?, run_json = ? WHERE id = ?`)
      .run(next.status, next.phase, next.updatedAt, JSON.stringify(next), runId);
    if (terminalPhases.has(next.phase)) {
      db.prepare(`DELETE FROM agent_runs WHERE id IN (
        SELECT id FROM agent_runs WHERE status IN ('succeeded', 'failed')
        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )`).run(historyLimit);
    }
    return rowToRun({ run_json: JSON.stringify(next) }, includeLogs);
  }

  return {
    async list(workspaceId, limit = 20) {
      return db.prepare(`SELECT run_json FROM agent_runs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(workspaceId, clampLimit(limit)).map((row) => rowToRun(row, false));
    },
    async get(runId, workspaceId, ownerUserId) {
      const row = db.prepare(`SELECT run_json FROM agent_runs WHERE id = ? AND workspace_id = ? AND owner_user_id = ?`)
        .get(runId, workspaceId, ownerUserId);
      return rowToRun(row);
    },
    async getByRequestId(requestId) {
      return rowToRun(db.prepare("SELECT run_json FROM agent_runs WHERE request_id = ?").get(requestId));
    },
    async listRecoverable() {
      return db.prepare(`SELECT run_json FROM agent_runs WHERE status IN ('queued', 'running') ORDER BY created_at ASC`)
        .all().map((row) => rowToRun(row, false));
    },
    async insert(run, { maxActive } = {}) {
      transaction(() => {
        if (Number.isFinite(maxActive)) {
          const active = Number(db.prepare(
            "SELECT COUNT(*) AS count FROM agent_runs WHERE status IN ('queued', 'running')",
          ).get().count);
          if (active >= maxActive) {
            const error = new Error("agent run admission queue is full");
            error.code = "timeout";
            throw error;
          }
        }
        db.prepare(`INSERT INTO agent_runs
          (id, request_id, workspace_id, owner_user_id, status, phase, created_at, updated_at, run_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(run.id, run.requestId, run.workspaceId, run.ownerUserId, run.status, run.phase,
            run.createdAt, run.updatedAt, JSON.stringify(run));
        db.prepare(`DELETE FROM agent_runs WHERE id IN (
          SELECT id FROM agent_runs WHERE status IN ('succeeded', 'failed')
          ORDER BY created_at DESC LIMIT -1 OFFSET ?
        )`).run(historyLimit);
      })();
      return rowToRun({ run_json: JSON.stringify(run) });
    },
    async update(runId, patch) {
      return transaction(() => updateRun(runId, patch))();
    },
    async appendLog(runId, message, level = "info") {
      const entry = {
        at: new Date().toISOString(),
        level,
        message: String(message),
      };
      return transaction(() => {
        if (!db.prepare("SELECT 1 FROM agent_runs WHERE id = ?").get(runId)) {
          throw new Error(`agent run not found: ${runId}`);
        }
        db.prepare("INSERT INTO agent_run_logs (run_id, at, level, message) VALUES (?, ?, ?, ?)")
          .run(runId, entry.at, entry.level, entry.message);
        db.prepare(`DELETE FROM agent_run_logs WHERE run_id = ? AND sequence <= COALESCE((
          SELECT sequence FROM agent_run_logs WHERE run_id = ?
          ORDER BY sequence DESC LIMIT 1 OFFSET ?
        ), -1)`).run(runId, runId, agentRunLogLimit());
        return updateRun(runId, { lastLogExcerpt: entry.message, updatedAt: entry.at }, false);
      })();
    },
    close() { db.close(); },
  };
}

export async function dispatchAgentRun(command, options) {
  const config = options.config || agentRunConfigFromEnv();
  const store = options.store || createAgentRunStore(config.storePath);
  const existing = await store.getByRequestId(command.requestId);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint(command)) {
      const error = new Error("requestId was already used with a different command");
      error.code = "invalid_input";
      throw error;
    }
    return { run: existing };
  }
  const run = createAgentRun(command, config);
  await store.insert(run, { maxActive: config.maxQueuedRuns });

  if (run.agent === "codex" && !config.codexAppServerUrl) {
    const failed = await store.update(run.id, {
      phase: "failed",
      status: "failed",
      completedAt: new Date().toISOString(),
      controller: { kind: "codex-app-server" },
      error: CODEX_APP_SERVER_NOT_CONFIGURED,
      lastLogExcerpt: CODEX_APP_SERVER_NOT_CONFIGURED,
    });
    return { run: failed };
  }

  if (options.execute !== false) {
    scheduleAgentRun(run, { ...options, config, store });
  }
  return { run };
}

export async function reconcileAgentRuns(options) {
  const config = options.config || agentRunConfigFromEnv();
  const store = options.store || createAgentRunStore(config.storePath);
  const recoverable = await store.listRecoverable();
  for (const run of recoverable) {
    if (run.status === "running") {
      let restartError = new Error("provisioner restarted while the agent run was active");
      try {
        await cleanupAgentRunResources(run, options, {
          credentialMayExist: true,
          containerMayExist: true,
        });
      } catch (cleanupError) {
        restartError = new AggregateError(
          [restartError, cleanupError],
          "provisioner restarted and orphan resource cleanup failed",
        );
      }
      await failRun(
        store,
        run.id,
        restartError,
      );
    } else if (options.execute !== false) {
      scheduleAgentRun(run, { ...options, config, store });
    }
  }
  return { reconciled: recoverable.length };
}

function scheduleAgentRun(run, options) {
  let state = schedulerStates.get(options.store);
  if (!state) {
    state = { active: 0, queue: [] };
    schedulerStates.set(options.store, state);
  }
  state.queue.push({ run, options });
  drainAgentRunQueue(state);
}

function drainAgentRunQueue(state) {
  while (
    state.queue.length > 0 &&
    state.active < positiveInteger(state.queue[0].options.config.maxConcurrentRuns, 2)
  ) {
    const item = state.queue.shift();
    state.active += 1;
    void executeAgentRun(item.run, item.options)
      .catch((err) => failRun(item.options.store, item.run.id, err))
      .finally(() => {
        state.active -= 1;
        drainAgentRunQueue(state);
      });
  }
}

export async function listAgentRuns(command, options) {
  const config = options.config || agentRunConfigFromEnv();
  const store = options.store || createAgentRunStore(config.storePath);
  return {
    runs: await store.list(command.workspace.id, command.payload?.limit ?? 20),
  };
}

export async function getAgentRun(command, options) {
  const config = options.config || agentRunConfigFromEnv();
  const store = options.store || createAgentRunStore(config.storePath);
  const run = await store.get(
    command.payload.runId,
    command.workspace.id,
    command.workspace.ownerUserId,
  );
  if (!run) {
    const error = new Error("agent run was not found");
    error.code = "invalid_state";
    throw error;
  }
  return { run };
}

export async function executeAgentRun(run, options) {
  const { config, store } = options;
  const execInContainer = options.execInContainer;
  const incus = options.incus;
  const readHostCredential = options.readHostCredential;
  const injectCredential = options.injectCredential;
  const deleteInjectedCredential = options.deleteInjectedCredential;
  if (
    typeof execInContainer !== "function" ||
    typeof incus !== "function" ||
    typeof readHostCredential !== "function" ||
    typeof injectCredential !== "function" ||
    typeof deleteInjectedCredential !== "function"
  ) {
    throw new Error("agent run executor is not configured");
  }

  let containerMayExist = false;
  let credentialMayExist = false;
  let controller;
  const targetPath = targetCredentialPathForAgent(run.agent);
  try {
    await store.update(run.id, {
      phase: "cloning_container",
      status: "running",
      container: { state: "cloning" },
      lastLogExcerpt: `Cloning ${run.container.sourceContainer} into ${run.container.name}`,
    });
    await store.appendLog(
      run.id,
      `Cloning ${run.container.sourceContainer} into ${run.container.name}`,
    );
    containerMayExist = true;
    await incus(copyArgsForRun(run));

    await store.update(run.id, {
      phase: "starting_container",
      container: { state: "starting" },
      lastLogExcerpt: `Starting ${run.container.name}`,
    });
    await store.appendLog(run.id, `Starting ${run.container.name}`);
    await incus(["--project", run.container.project, "start", run.container.name]);

    await store.update(run.id, {
      phase: "cloning_repo",
      container: { state: "running" },
      lastLogExcerpt: `Cloning ${run.repoUrl}`,
    });
    await store.appendLog(run.id, `Cloning ${run.repoUrl}`);
    await execInContainer(run, cloneRepoScript(run));

    await store.update(run.id, {
      phase: "injecting_credentials",
      lastLogExcerpt: `Injecting ${run.agent} credentials`,
    });
    await store.appendLog(run.id, `Injecting ${run.agent} credentials`);
    const sourcePath = sourceCredentialPathForAgent(run.agent);
    const credentialContent = await readHostCredentialWithRetry(
      readHostCredential,
      config.credentialSourceContainer,
      config.credentialSourceProject,
      sourcePath,
    );
    if (credentialContent === undefined) {
      const err = new Error(missingCredentialMessage(run.agent, config));
      err.code = "credential_not_found";
      throw err;
    }
    const expiry = credentialExpiryInfo(run.agent, credentialContent);
    if (expiry && expiry.expired) {
      const err = new Error(staleCredentialMessage(run.agent, config, expiry));
      err.code = "credential_expired";
      throw err;
    }
    credentialMayExist = true;
    await injectCredential(
      run.container.name,
      run.container.project,
      targetPath,
      credentialContent,
    );

    await store.update(run.id, {
      phase: "attaching_agent",
      lastLogExcerpt:
        run.agent === "codex"
          ? "Attaching Codex app-server controller"
          : "Launching Claude CLI controller",
    });
    await store.appendLog(
      run.id,
      run.agent === "codex"
        ? "Attaching Codex app-server controller"
        : "Launching Claude CLI controller",
    );
    controller = await startAgentController(run, config, execInContainer, {
      incus,
      onProgress: async (message) => {
        await store.appendLog(run.id, message);
        await store.update(run.id, {
          phase: "running",
          status: "running",
          lastLogExcerpt: message,
        });
      },
    });

    await store.appendLog(
      run.id,
      run.agent === "codex"
        ? "Codex app-server controller attached"
        : "Claude CLI controller completed",
      "success",
    );
  } finally {
    await cleanupAgentRunResources(run, options, {
      credentialMayExist,
      containerMayExist,
    });
  }
  return store.update(run.id, {
    phase: "succeeded",
    status: "succeeded",
    completedAt: new Date().toISOString(),
    container: { state: "deleted" },
    controller,
    lastLogExcerpt:
      run.agent === "codex"
        ? "Codex app-server controller attached"
        : "Claude CLI controller completed",
  });
}

async function cleanupAgentRunResources(
  run,
  options,
  { credentialMayExist, containerMayExist },
) {
  const failures = [];
  if (credentialMayExist && typeof options.deleteInjectedCredential === "function") {
    try {
      await options.deleteInjectedCredential(
        run.container.name,
        run.container.project,
        targetCredentialPathForAgent(run.agent),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (containerMayExist && typeof options.incus === "function") {
    try {
      await options.incus([
        "--project",
        run.container.project,
        "delete",
        run.container.name,
        "--force",
      ]);
      await options.store.update(run.id, { container: { state: "deleted" } });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "agent run resource cleanup failed");
  }
}

// Where the real, working credential lives on the credential-source
// container (incus-web), under its `agent` user's home.
function sourceCredentialPathForAgent(agent) {
  return agent === "codex"
    ? "/home/agent/.codex/auth.json"
    : "/home/agent/.claude/.credentials.json";
}

// Where the credential must be written inside a freshly-cloned run
// container. `incus exec`/`execInContainer` run as root by default (no
// --user is passed anywhere in this codebase's exec plumbing), so $HOME
// there is /root, not /home/agent -- this must match execution context,
// not the source container's user layout.
function targetCredentialPathForAgent(agent) {
  return agent === "codex"
    ? "/root/.codex/auth.json"
    : "/root/.claude/.credentials.json";
}

function missingCredentialMessage(agent, config) {
  const label = agent === "codex" ? "Codex" : "Claude";
  const cli = agent === "codex" ? "codex login" : "claude login";
  return `${label} credential not found in ${config.credentialSourceContainer} workspace -- run '${cli}' there.`;
}

// Only Claude Code's credential format (claudeAiOauth.expiresAt, ms epoch)
// is understood well enough to check proactively -- Codex's auth.json
// expiry field is unconfirmed, so codex runs skip this check and surface
// whatever error the CLI itself produces (same as before this fix).
function credentialExpiryInfo(agent, rawContent) {
  if (agent === "codex") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return undefined;
  }
  const expiresAt = parsed?.claudeAiOauth?.expiresAt;
  if (typeof expiresAt !== "number") return undefined;
  return { expiresAt, expired: Date.now() > expiresAt };
}

function staleCredentialMessage(agent, config, expiry) {
  const label = agent === "codex" ? "Codex" : "Claude";
  const cli = agent === "codex" ? "codex" : "claude";
  const ageMs = Date.now() - expiry.expiresAt;
  const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
  return (
    `${label} credential in ${config.credentialSourceContainer} expired ${ageDays} day(s) ago ` +
    `(${new Date(expiry.expiresAt).toISOString()}) -- run '${cli}' interactively there to refresh it.`
  );
}

async function readHostCredentialWithRetry(
  readHostCredential,
  container,
  project,
  path,
) {
  let raw;
  try {
    raw = await readHostCredential(container, project, path);
  } catch {
    return undefined;
  }
  if (isValidJson(raw)) return raw;

  // Neither Claude Code nor Codex CLI guarantee atomic writes to their
  // credential files, so a read caught mid-write can be truncated/invalid
  // JSON. Retry once after a short delay before giving up.
  await sleep(75);
  try {
    raw = await readHostCredential(container, project, path);
  } catch {
    return undefined;
  }
  return isValidJson(raw) ? raw : undefined;
}

function isValidJson(value) {
  if (!value) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startAgentController(
  run,
  config,
  execInContainer,
  options = {},
) {
  if (run.agent === "codex") {
    if (
      !options.codexAppServerClient &&
      typeof options.incus !== "function" &&
      !config.codexAppServerUrl
    ) {
      const error = new Error(CODEX_APP_SERVER_NOT_CONFIGURED);
      error.code = "missing_controller_config";
      throw error;
    }
    return startCodexAppServerController(run, config, execInContainer, options);
  }

  await execInContainer(run, renderClaudeCommand(config.claudeCommandTemplate, run));
  return { kind: "claude-cli" };
}

export async function startCodexAppServerController(
  run,
  config,
  execInContainer,
  options = {},
) {
  let controllerRuntime;
  let client = options.codexAppServerClient;
  if (!client) {
    controllerRuntime =
      typeof options.incus === "function" && typeof execInContainer === "function"
        ? await startContainerCodexAppServer(run, execInContainer, options.incus)
        : {
            url: config.codexAppServerUrl,
            token: config.codexAppServerToken,
            cleanup: async () => {},
          };
    client = createCodexAppServerClient({
      url: controllerRuntime.url,
      token: controllerRuntime.token || "",
      timeoutMs: config.codexAppServerTimeoutMs,
    });
  }
  const cwd = "/workspace/repo";
  const model = config.codexModel || undefined;
  try {
    const { threadId, turnId } = await client.startTurn({
      cwd,
      model,
      task: run.task,
      onProgress: options.onProgress,
    });

    return {
      kind: "codex-app-server",
      sessionId: threadId,
      url: controllerRuntime?.url || config.codexAppServerUrl,
      ...(turnId ? { turnId } : {}),
    };
  } finally {
    await controllerRuntime?.cleanup?.();
  }
}

export function createCodexAppServerClient({ url, token, timeoutMs }) {
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    const error = new Error(
      "Codex app-server controller requires a ws:// or wss:// endpoint.",
    );
    error.code = "invalid_input";
    error.controller = { kind: "codex-app-server", url };
    throw error;
  }

  return {
    async startTurn({ cwd, model, task, onProgress }) {
      const rpc = await createJsonRpcWebSocket({ url, token, timeoutMs });
      try {
        await rpc.request("initialize", {
          clientInfo: {
            name: "incus_web",
            title: "incus-web",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        });
        rpc.notify("initialized", {});

        const threadParams = {
          cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          serviceName: "incus-web",
          threadSource: "subagent",
          ephemeral: false,
          ...(model ? { model } : {}),
        };
        const threadResponse = await rpc.request("thread/start", threadParams);
        const threadId = threadResponse?.thread?.id;
        if (!threadId) {
          throw new Error("Codex app-server did not return a thread id.");
        }

        let completed = false;
        let turnId = null;
        let agentMessageBuffer = "";
        async function flushAgentMessageBuffer() {
          const text = normalizeProgressText(agentMessageBuffer);
          agentMessageBuffer = "";
          if (text && onProgress) await onProgress(text);
        }
        const completion = new Promise((resolve, reject) => {
          rpc.onNotification = async (message) => {
            if (message.method === "item/agentMessage/delta") {
              const text = extractNotificationText(message.params);
              if (text) {
                agentMessageBuffer += text;
                if (shouldFlushProgressBuffer(agentMessageBuffer)) {
                  await flushAgentMessageBuffer();
                }
              }
            }
            if (message.method === "turn/started") {
              await flushAgentMessageBuffer();
              turnId = message.params?.turn?.id || turnId;
              if (turnId && onProgress) await onProgress(`Codex turn started: ${turnId}`);
            }
            if (message.method === "turn/completed") {
              await flushAgentMessageBuffer();
              completed = true;
              const status = message.params?.turn?.status || "completed";
              if (status && status !== "completed" && status !== "succeeded") {
                reject(new Error(`Codex app-server turn completed with status ${status}.`));
                return;
              }
              resolve({ turnId });
            }
            if (message.method === "error") {
              await flushAgentMessageBuffer();
              reject(new Error(message.params?.message || "Codex app-server error."));
            }
          };
        });

        const turnResponse = await rpc.request("turn/start", {
          threadId,
          cwd,
          input: [{ type: "text", text: task, text_elements: [] }],
          approvalPolicy: "never",
          ...(model ? { model } : {}),
        });
        turnId = turnResponse?.turn?.id || turnId;
        if (onProgress) await onProgress(`Codex app-server thread ${threadId} running`);
        await completion;
        if (!completed) {
          throw new Error("Codex app-server turn ended without completion.");
        }
        return { threadId, turnId };
      } finally {
        rpc.close();
      }
    },
  };
}

async function startContainerCodexAppServer(run, execInContainer, incus) {
  const containerPort = 4510;
  const hostPort = await reserveLoopbackPort();
  const proxyDevice = "codex-app-server-proxy";
  const url = `ws://127.0.0.1:${hostPort}`;

  await removeIncusDevice(incus, run, proxyDevice);
  await execInContainer(run, startCodexAppServerScript(containerPort));
  await incus([
    "--project",
    run.container.project,
    "config",
    "device",
    "add",
    run.container.name,
    proxyDevice,
    "proxy",
    `listen=tcp:127.0.0.1:${hostPort}`,
    `connect=tcp:127.0.0.1:${containerPort}`,
  ]);
  try {
    await waitForHttpReady(`http://127.0.0.1:${hostPort}/readyz`);
  } catch (err) {
    await cleanupContainerCodexAppServer(run, execInContainer, incus, proxyDevice);
    throw err;
  }

  return {
    url,
    token: "",
    cleanup: () =>
      cleanupContainerCodexAppServer(run, execInContainer, incus, proxyDevice),
  };
}

function startCodexAppServerScript(port) {
  const listen = shellQuote(`ws://127.0.0.1:${port}`);
  return [
    "set -e",
    "log=/tmp/incus-web-codex-app-server.log",
    "pidfile=/tmp/incus-web-codex-app-server.pid",
    "if [ -s \"$pidfile\" ] && kill -0 \"$(cat \"$pidfile\")\" 2>/dev/null; then",
    "  kill \"$(cat \"$pidfile\")\" 2>/dev/null || true",
    "fi",
    "rm -f \"$log\"",
    `nohup codex app-server --listen ${listen} >"$log" 2>&1 &`,
    "echo $! >\"$pidfile\"",
  ].join("\n");
}

async function cleanupContainerCodexAppServer(run, execInContainer, incus, proxyDevice) {
  await removeIncusDevice(incus, run, proxyDevice);
  try {
    await execInContainer(
      run,
      [
        "pidfile=/tmp/incus-web-codex-app-server.pid",
        "if [ -s \"$pidfile\" ]; then",
        "  kill \"$(cat \"$pidfile\")\" 2>/dev/null || true",
        "fi",
      ].join("\n"),
    );
  } catch {
    // best-effort cleanup; the run container remains the ownership boundary.
  }
}

async function removeIncusDevice(incus, run, deviceName) {
  try {
    await incus([
      "--project",
      run.container.project,
      "config",
      "device",
      "remove",
      run.container.name,
      deviceName,
    ]);
  } catch {
    // The proxy may not exist yet; cleanup should stay idempotent.
  }
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("could not reserve a Codex app-server proxy port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForHttpReady(url) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Codex app-server ready check returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  throw new Error(
    `Codex app-server did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function failRun(store, runId, err) {
  const message = err instanceof Error ? err.message : String(err);
  const controller =
    err && typeof err === "object" && "controller" in err
      ? err.controller
      : undefined;
  if (typeof store.appendLog === "function") {
    await store.appendLog(runId, message, "error");
  }
  return store.update(runId, {
    phase: "failed",
    status: "failed",
    completedAt: new Date().toISOString(),
    controller,
    error: message,
    lastLogExcerpt: message,
  });
}

export function createAgentRun(command, config, now = new Date()) {
  const suffix = randomBytes(4).toString("hex");
  const stamp = timestampId(now);
  return {
    id: `run_${stamp}_${suffix}`,
    requestId: command.requestId,
    requestFingerprint: requestFingerprint(command),
    workspaceId: command.workspace.id,
    ownerUserId: command.workspace.ownerUserId,
    container: {
      name: `agent-run-${suffix}`,
      project: config.runProject,
      sourceContainer: config.goldenContainer,
      sourceProject: config.goldenProject,
      createdFrom: "golden",
      state: "planned",
    },
    agent: command.payload.agent,
    repoUrl: command.payload.repoUrl,
    ...(command.payload.ref ? { ref: command.payload.ref } : {}),
    task: command.payload.task,
    phase: "queued",
    status: "queued",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function requestFingerprint(command) {
  return createHash("sha256")
    .update(JSON.stringify({
      type: command.type,
      actorUserId: command.actor?.userId,
      workspace: command.workspace,
      payload: command.payload,
    }))
    .digest("hex");
}

export function clampLimit(value) {
  if (!Number.isInteger(value)) return 20;
  return Math.min(100, Math.max(1, value));
}

async function createJsonRpcWebSocket({ url, token, timeoutMs }) {
  const socket = await openJsonTextWebSocket({ url, token, timeoutMs });
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 43200000;

  const rpc = {
    onNotification: undefined,
    async request(method, params) {
      if (closed) {
        throw new Error("Codex app-server connection is not open.");
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        const pendingRequest = pending.get(id);
        if (!pendingRequest) return;
        pending.delete(id);
        pendingRequest.reject(
          new Error(`Timed out waiting for Codex app-server method ${method}.`),
        );
      }, timeout);
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, timer });
      });
      socket.send(JSON.stringify({ method, id, params }));
      return response;
    },
    notify(method, params) {
      if (!closed) socket.send(JSON.stringify({ method, params }));
    },
    close() {
      if (!closed) socket.close();
    },
  };

  socket.onMessage = (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (err) {
      return;
    }

    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message || "Codex app-server request failed."));
      } else {
        resolve(message.result);
      }
      return;
    }

    void rpc.onNotification?.(message);
  };

  socket.onClose = () => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("Codex app-server connection closed."));
    }
    pending.clear();
  };

  return rpc;
}

function openJsonTextWebSocket({ url, token, timeoutMs }) {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    const error = new Error(
      "Codex app-server controller requires a ws:// or wss:// endpoint.",
    );
    error.code = "invalid_input";
    error.controller = { kind: "codex-app-server", url };
    throw error;
  }

  const timeout = Math.min(
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 43200000,
    30000,
  );
  const key = randomBytes(16).toString("base64");
  const expectedAccept = websocketAccept(key);
  const path = `${parsed.pathname || "/"}${parsed.search || ""}`;
  const port =
    parsed.port ||
    (parsed.protocol === "wss:" ? "443" : "80");
  const headers = [
    `GET ${path} HTTP/1.1`,
    `Host: ${hostHeader(parsed)}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${key}`,
  ];
  if (token) headers.push(`Authorization: Bearer ${token}`);
  headers.push("", "");

  return new Promise((resolve, reject) => {
    let settled = false;
    let handshakeChunks = [];
    let handshakeBytes = 0;
    let handshakeDelimiterBytes = 0;
    let socket;
    let connection;
    let frameParser;
    const timer = setTimeout(() => {
      fail(new Error("Timed out connecting to Codex app-server."));
    }, timeout);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      reject(err);
    };

    const connectOptions = {
      host: parsed.hostname,
      port: Number.parseInt(port, 10),
    };
    socket =
      parsed.protocol === "wss:"
        ? createTlsConnection({
            ...connectOptions,
            servername: parsed.hostname,
          })
        : createConnection(connectOptions);

    socket.once("connect", () => {
      socket.write(headers.join("\r\n"));
    });
    socket.once("error", () => {
      fail(new Error("Could not connect to Codex app-server."));
    });
    socket.once("close", () => {
      if (!settled) fail(new Error("Codex app-server connection closed."));
    });
    socket.on("data", (chunk) => {
      if (settled) {
        frameParser?.push(chunk);
        return;
      }

      handshakeChunks.push(chunk);
      const previousBytes = handshakeBytes;
      handshakeBytes += chunk.length;
      let headerEnd = -1;
      for (let index = 0; index < chunk.length; index += 1) {
        const expected = websocketHandshakeDelimiter[handshakeDelimiterBytes];
        if (chunk[index] === expected) {
          handshakeDelimiterBytes += 1;
          if (handshakeDelimiterBytes === 4) {
            headerEnd = previousBytes + index + 1;
            break;
          }
        } else {
          handshakeDelimiterBytes = chunk[index] === 13 ? 1 : 0;
        }
      }
      if (headerEnd === -1) {
        if (handshakeBytes > websocketHandshakeLimitBytes) {
          fail(new Error("Codex app-server WebSocket handshake exceeded 1 MiB."));
        }
        return;
      }
      if (headerEnd > websocketHandshakeLimitBytes) {
        fail(new Error("Codex app-server WebSocket handshake exceeded 1 MiB."));
        return;
      }
      const handshake = Buffer.concat(handshakeChunks, handshakeBytes);
      handshakeChunks = [];
      const rawHeaders = handshake.subarray(0, headerEnd - 4).toString("latin1");
      const remainder = handshake.subarray(headerEnd);
      const result = validateWebSocketHandshake(rawHeaders, expectedAccept);
      if (result) {
        fail(result);
        return;
      }

      settled = true;
      clearTimeout(timer);
      connection = createTextWebSocketConnection(socket);
      frameParser = createWebSocketFrameParser(connection);
      frameParser.push(remainder);
      resolve(connection);
    });
  });
}

function createTextWebSocketConnection(socket) {
  const connection = {
    onMessage: undefined,
    onClose: undefined,
    send(data) {
      this.sendFrame(0x1, Buffer.from(String(data), "utf8"));
    },
    sendFrame(opcode, payload) {
      socket.write(encodeWebSocketFrame(opcode, payload));
    },
    close() {
      socket.end(encodeWebSocketFrame(0x8, Buffer.alloc(0)));
    },
  };
  socket.on("close", () => connection.onClose?.());
  socket.on("error", () => connection.onClose?.());
  return connection;
}

function createWebSocketFrameParser(connection) {
  const queue = new BufferQueue();
  let fragments = [];
  let fragmentedOpcode;
  let fragmentedBytes = 0;

  const rejectOversized = () => {
    fragments = [];
    fragmentedOpcode = undefined;
    fragmentedBytes = 0;
    queue.clear();
    connection.close();
  };

  const deliver = (opcode, payload) => {
    if (opcode === 0x1) connection.onMessage?.(payload.toString("utf8"));
  };

  const push = (chunk) => {
    if (chunk.length === 0) return;
    queue.push(chunk);
    while (queue.length >= 2) {
      const first = queue.peekUInt8(0);
      const second = queue.peekUInt8(1);
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (queue.length < 4) break;
        length = queue.peekUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (queue.length < 10) break;
        const high = queue.peekUInt32BE(2);
        const low = queue.peekUInt32BE(6);
        if (high !== 0) {
          rejectOversized();
          return;
        }
        length = low;
        headerLength = 10;
      }
      if (
        length > websocketFrameLimitBytes ||
        ((opcode & 0x08) !== 0 && (!final || length > 125))
      ) {
        rejectOversized();
        return;
      }
      const maskLength = masked ? 4 : 0;
      const frameLength = headerLength + maskLength + length;
      if (queue.length < frameLength) break;

      queue.discard(headerLength);
      const mask = masked ? queue.read(4) : undefined;
      let payload = queue.read(length);
      if (masked) {
        const unmasked = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ mask[index % 4];
        }
        payload = unmasked;
      }

      if (opcode === 0x0) {
        if (
          fragmentedOpcode === undefined ||
          fragmentedBytes + payload.length > websocketMessageLimitBytes
        ) {
          rejectOversized();
          return;
        }
        fragments.push(payload);
        fragmentedBytes += payload.length;
        if (final) {
          deliver(fragmentedOpcode, Buffer.concat(fragments, fragmentedBytes));
          fragments = [];
          fragmentedOpcode = undefined;
          fragmentedBytes = 0;
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fragmentedOpcode !== undefined) {
          rejectOversized();
          return;
        }
        if (final) {
          deliver(opcode, payload);
        } else {
          fragments = [payload];
          fragmentedOpcode = opcode;
          fragmentedBytes = payload.length;
        }
      } else if (opcode === 0x8) {
        connection.onClose?.();
        connection.close();
        queue.clear();
        return;
      } else if (opcode === 0x9) {
        connection.sendFrame(0xA, payload);
      }
    }
  };

  return { push };
}

class BufferQueue {
  constructor() {
    this.chunks = [];
    this.headIndex = 0;
    this.headOffset = 0;
    this.length = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  clear() {
    this.chunks = [];
    this.headIndex = 0;
    this.headOffset = 0;
    this.length = 0;
  }

  peekUInt8(index) {
    let remaining = index + this.headOffset;
    for (let chunkIndex = this.headIndex; chunkIndex < this.chunks.length; chunkIndex += 1) {
      const chunk = this.chunks[chunkIndex];
      if (remaining < chunk.length) return chunk[remaining];
      remaining -= chunk.length;
    }
    throw new RangeError("WebSocket buffer underflow");
  }

  peekUInt16BE(index) {
    return this.peekUInt8(index) * 0x100 + this.peekUInt8(index + 1);
  }

  peekUInt32BE(index) {
    return (
      this.peekUInt8(index) * 0x1000000 +
      this.peekUInt8(index + 1) * 0x10000 +
      this.peekUInt8(index + 2) * 0x100 +
      this.peekUInt8(index + 3)
    );
  }

  discard(length) {
    let remaining = length;
    while (remaining > 0) {
      const available = this.chunks[this.headIndex].length - this.headOffset;
      const consumed = Math.min(remaining, available);
      this.headOffset += consumed;
      this.length -= consumed;
      remaining -= consumed;
      if (this.headOffset === this.chunks[this.headIndex].length) {
        this.headIndex += 1;
        this.headOffset = 0;
        if (this.headIndex === this.chunks.length) {
          this.chunks = [];
          this.headIndex = 0;
        } else if (this.headIndex > 64 && this.headIndex * 2 > this.chunks.length) {
          this.chunks = this.chunks.slice(this.headIndex);
          this.headIndex = 0;
        }
      }
    }
  }

  read(length) {
    const output = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[this.headIndex];
      const available = chunk.length - this.headOffset;
      const copied = Math.min(length - written, available);
      chunk.copy(output, written, this.headOffset, this.headOffset + copied);
      written += copied;
      this.discard(copied);
    }
    return output;
  }
}

function encodeWebSocketFrame(opcode, payload) {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const mask = randomBytes(4);
  const frame = Buffer.alloc(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(length, 6);
  }
  mask.copy(frame, headerLength);
  for (let index = 0; index < length; index += 1) {
    frame[headerLength + 4 + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function validateWebSocketHandshake(rawHeaders, expectedAccept) {
  const lines = rawHeaders.split("\r\n");
  const status = lines.shift() || "";
  if (!status.includes(" 101 ")) {
    return new Error("Could not connect to Codex app-server.");
  }
  const headers = new Map();
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers.set(line.slice(0, index).toLowerCase(), line.slice(index + 1).trim());
  }
  if (headers.get("sec-websocket-accept") !== expectedAccept) {
    return new Error("Codex app-server returned an invalid WebSocket handshake.");
  }
  return undefined;
}

function websocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function hostHeader(url) {
  if (!url.port) return url.host;
  return url.host;
}

function extractNotificationText(params) {
  if (!params || typeof params !== "object") return "";
  for (const key of ["text", "delta", "message", "content"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function normalizeProgressText(value) {
  return String(value)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function shouldFlushProgressBuffer(value) {
  if (value.includes("\n")) return true;
  if (value.length >= 240) return true;
  return /[.!?]\s*$/.test(value);
}

function agentRunLogLimit() {
  const parsed = Number.parseInt(process.env.INCUS_WEB_AGENT_RUN_LOG_LIMIT || "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultAgentRunLogLimit;
  return Math.max(100, Math.min(50000, parsed));
}

function agentRunHistoryLimit() {
  return positiveInteger(
    process.env.INCUS_WEB_AGENT_RUN_HISTORY_LIMIT,
    defaultAgentRunHistoryLimit,
  );
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function mkdirSyncParent(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function stageLegacyJson(path) {
  const candidates = [
    path,
    path.endsWith(".sqlite") ? path.replace(/\.sqlite$/, ".json") : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const contents = readFileSync(candidate, "utf8");
    if (!contents.trimStart().startsWith("[")) continue;
    const runs = JSON.parse(contents);
    const defaultBackup = `${candidate}.legacy-json`;
    const backupPath = existsSync(defaultBackup)
      ? `${defaultBackup}-${Date.now()}`
      : defaultBackup;
    renameSync(candidate, backupPath);
    return {
      runs: Array.isArray(runs) ? runs : [],
      sourcePath: candidate,
      backupPath,
    };
  }
  return { runs: [], sourcePath: undefined, backupPath: undefined };
}

function restoreStagedLegacyJson(migration) {
  if (!migration.sourcePath || !migration.backupPath) return;
  if (existsSync(migration.backupPath) && !existsSync(migration.sourcePath)) {
    renameSync(migration.backupPath, migration.sourcePath);
  }
}

function copyArgsForRun(run) {
  if (run.container.sourceProject === run.container.project) {
    return [
      "--project",
      run.container.project,
      "copy",
      run.container.sourceContainer,
      run.container.name,
    ];
  }
  return [
    "copy",
    `${run.container.sourceContainer}`,
    run.container.name,
    "--project",
    run.container.sourceProject,
    "--target-project",
    run.container.project,
  ];
}

function cloneRepoScript(run) {
  const checkout = run.ref ? ` && git checkout ${shellQuote(run.ref)}` : "";
  const repoUrl = shellQuote(run.repoUrl);
  // A freshly `incus start`-ed container's network (DHCP/DNS) is not
  // always ready the instant the exec runs -- observed readiness delay
  // ranges from under a second up to ~30s under host disk I/O load, so
  // retry the clone with enough attempts/backoff to comfortably cover
  // that range rather than failing on a startup race.
  const cloneWithRetry = [
    "attempts=15",
    "for attempt in $(seq 1 $attempts); do",
    "  rm -rf /workspace/repo",
    `  git clone ${repoUrl} /workspace/repo && break`,
    "  status=$?",
    "  if [ $attempt -eq $attempts ]; then exit $status; fi",
    "  sleep 3",
    "done",
  ].join("\n");
  return [
    "rm -rf /workspace/repo",
    "mkdir -p /workspace",
    cloneWithRetry,
    `cd /workspace/repo${checkout}`,
  ].join(" && ");
}

function renderClaudeCommand(template, run) {
  return template
    .replaceAll("{{task}}", shellQuote(run.task))
    .replaceAll("{{repoPath}}", shellQuote("/workspace/repo"))
    .replaceAll("{{repoUrl}}", shellQuote(run.repoUrl))
    .replaceAll("{{ref}}", shellQuote(run.ref || ""));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function timestampId(now) {
  return now.toISOString().replace(/\D/g, "").slice(0, 14);
}


export function isTerminalAgentRun(run) {
  return terminalPhases.has(run.phase);
}
