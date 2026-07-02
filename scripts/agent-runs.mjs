import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export const CODEX_APP_SERVER_NOT_CONFIGURED =
  "Codex app-server controller is not configured for this host.";

const terminalPhases = new Set(["succeeded", "failed"]);

export function agentRunConfigFromEnv(env = process.env) {
  const incusProject = env.INCUS_WEB_INCUS_PROJECT || "default";
  return {
    storePath:
      env.INCUS_WEB_AGENT_RUN_STORE_PATH || "/var/lib/incus-web/agent-runs.json",
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
  };
}

export function createAgentRunStore(path) {
  return {
    async list(workspaceId, limit = 20) {
      const runs = await readRuns(path);
      return runs
        .filter((run) => run.workspaceId === workspaceId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, clampLimit(limit));
    },
    async insert(run) {
      const runs = await readRuns(path);
      runs.unshift(run);
      await writeRuns(path, runs);
      return run;
    },
    async update(runId, patch) {
      const runs = await readRuns(path);
      const index = runs.findIndex((run) => run.id === runId);
      if (index === -1) {
        throw new Error(`agent run not found: ${runId}`);
      }
      const next = {
        ...runs[index],
        ...patch,
        container: {
          ...runs[index].container,
          ...(patch.container || {}),
        },
        controller:
          patch.controller === undefined
            ? runs[index].controller
            : patch.controller,
        updatedAt: new Date().toISOString(),
      };
      runs[index] = next;
      await writeRuns(path, runs);
      return next;
    },
  };
}

export async function dispatchAgentRun(command, options) {
  const config = options.config || agentRunConfigFromEnv();
  const store = options.store || createAgentRunStore(config.storePath);
  const run = createAgentRun(command, config);
  await store.insert(run);

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
    void executeAgentRun(run, {
      ...options,
      config,
      store,
    }).catch(async (err) => {
      await failRun(store, run.id, err);
    });
  }
  return { run };
}

export async function listAgentRuns(command, options) {
  const config = options.config || agentRunConfigFromEnv();
  const store = options.store || createAgentRunStore(config.storePath);
  return {
    runs: await store.list(command.workspace.id, command.payload?.limit ?? 20),
  };
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

  await store.update(run.id, {
    phase: "cloning_container",
    status: "running",
    container: { state: "cloning" },
    lastLogExcerpt: `Cloning ${run.container.sourceContainer} into ${run.container.name}`,
  });
  await incus(copyArgsForRun(run));

  await store.update(run.id, {
    phase: "starting_container",
    container: { state: "starting" },
    lastLogExcerpt: `Starting ${run.container.name}`,
  });
  await incus(["--project", run.container.project, "start", run.container.name]);

  await store.update(run.id, {
    phase: "cloning_repo",
    container: { state: "running" },
    lastLogExcerpt: `Cloning ${run.repoUrl}`,
  });
  await execInContainer(run, cloneRepoScript(run));

  await store.update(run.id, {
    phase: "injecting_credentials",
    lastLogExcerpt: `Injecting ${run.agent} credentials`,
  });
  const sourcePath = sourceCredentialPathForAgent(run.agent);
  const targetPath = targetCredentialPathForAgent(run.agent);
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
  await injectCredential(
    run.container.name,
    run.container.project,
    targetPath,
    credentialContent,
  );

  try {
    await store.update(run.id, {
      phase: "attaching_agent",
      lastLogExcerpt:
        run.agent === "codex"
          ? "Attaching Codex app-server controller"
          : "Launching Claude CLI controller",
    });
    const controller = await startAgentController(run, config, execInContainer, {
      onProgress: async (message) => {
        await store.update(run.id, {
          phase: "running",
          status: "running",
          lastLogExcerpt: message,
        });
      },
    });

    return await store.update(run.id, {
      phase: "succeeded",
      status: "succeeded",
      completedAt: new Date().toISOString(),
      controller,
      lastLogExcerpt:
        run.agent === "codex"
          ? "Codex app-server controller attached"
          : "Claude CLI controller completed",
    });
  } finally {
    await deleteInjectedCredential(
      run.container.name,
      run.container.project,
      targetPath,
    );
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
    if (!config.codexAppServerUrl) {
      const error = new Error(CODEX_APP_SERVER_NOT_CONFIGURED);
      error.code = "missing_controller_config";
      throw error;
    }
    return startCodexAppServerController(run, config, options);
  }

  await execInContainer(run, renderClaudeCommand(config.claudeCommandTemplate, run));
  return { kind: "claude-cli" };
}

export async function startCodexAppServerController(run, config, options = {}) {
  const client =
    options.codexAppServerClient ||
    createCodexAppServerClient({
      url: config.codexAppServerUrl,
      token: config.codexAppServerToken,
      timeoutMs: config.codexAppServerTimeoutMs,
    });
  const cwd = "/workspace/repo";
  const model = config.codexModel || undefined;
  const { threadId, turnId } = await client.startTurn({
    cwd,
    model,
    task: run.task,
    onProgress: options.onProgress,
  });

  return {
    kind: "codex-app-server",
    sessionId: threadId,
    url: config.codexAppServerUrl,
    ...(turnId ? { turnId } : {}),
  };
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
        const completion = new Promise((resolve, reject) => {
          rpc.onNotification = async (message) => {
            if (message.method === "item/agentMessage/delta") {
              const text = extractNotificationText(message.params);
              if (text && onProgress) await onProgress(text);
            }
            if (message.method === "turn/started") {
              turnId = message.params?.turn?.id || turnId;
              if (turnId && onProgress) await onProgress(`Codex turn started: ${turnId}`);
            }
            if (message.method === "turn/completed") {
              completed = true;
              const status = message.params?.turn?.status || "completed";
              if (status && status !== "completed" && status !== "succeeded") {
                reject(new Error(`Codex app-server turn completed with status ${status}.`));
                return;
              }
              resolve({ turnId });
            }
            if (message.method === "error") {
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

export async function failRun(store, runId, err) {
  const message = err instanceof Error ? err.message : String(err);
  const controller =
    err && typeof err === "object" && "controller" in err
      ? err.controller
      : undefined;
  return store.update(runId, {
    phase: "failed",
    status: "failed",
    completedAt: new Date().toISOString(),
    container: { state: "failed" },
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

export function clampLimit(value) {
  if (!Number.isInteger(value)) return 20;
  return Math.min(100, Math.max(1, value));
}

async function createJsonRpcWebSocket({ url, token, timeoutMs }) {
  if (typeof WebSocket !== "function") {
    throw new Error("Node.js WebSocket support is required for Codex app-server.");
  }
  if (token) {
    const error = new Error(
      "Codex app-server bearer-token WebSocket auth requires a Node WebSocket client with header support.",
    );
    error.code = "not_implemented";
    error.controller = { kind: "codex-app-server", url };
    throw error;
  }

  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  let opened = false;
  let closed = false;

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 43200000;

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
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
  });

  const openedPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out connecting to Codex app-server.")),
      Math.min(timeout, 30000),
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      opened = true;
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to Codex app-server."));
    });
  });

  socket.addEventListener("close", () => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("Codex app-server connection closed."));
    }
    pending.clear();
  });

  const rpc = {
    onNotification: undefined,
    async request(method, params) {
      await openedPromise;
      if (!opened || closed) {
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
      socket.send(JSON.stringify({ method, params }));
    },
    close() {
      if (!closed) socket.close();
    },
  };

  await openedPromise;
  return rpc;
}

function extractNotificationText(params) {
  if (!params || typeof params !== "object") return "";
  for (const key of ["text", "delta", "message", "content"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
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

async function readRuns(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function writeRuns(path, runs) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(runs, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(tmp, path);
}

export function isTerminalAgentRun(run) {
  return terminalPhases.has(run.phase);
}
