# Agent Runs

## Overview

Agent runs execute AI coding tasks in ephemeral containers with proper isolation and credential management. The system supports Codex app-server and Claude CLI controllers, cloning a golden container for fast spinup.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Control Plane UI                         │
│           (apps/web/components/agent-run-dispatch.tsx)     │
└──────────────────────────┬──────────────────────────────────┘
                           │ DispatchAgentRun
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Host Provisioner                          │
│              (scripts/provisioner-server.mjs)               │
│                                                              │
│  1. Validates workspace metadata                            │
│  2. Clones golden container                                  │
│  3. Injects credentials                                      │
│  4. Clones repository                                        │
│  5. Attaches controller                                      │
│  6. Returns run ID                                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Ephemeral Container                        │
│              <run-id>: cloned from golden container          │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Controller attached:                                │  │
│  │  - Codex app-server (HTTP callback)                  │  │
│  │  - Claude CLI (interactive shell)                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  Agent executes task with full toolchain access             │
└─────────────────────────────────────────────────────────────┘
```

## Golden Container

### Purpose

The golden container (`incus-web-agent-golden`) is a pre-configured template with:
- All developer toolchains installed (Node, Python, Go, Rust, Git)
- WeTTY/ghostty-web terminal backend
- Claude Code and Codex CLI
- Properly configured user and permissions
- Pre-warmed package manager caches

### Creation

Golden container is created by `scripts/build-agent-golden.sh`:

```bash
# Launch from base image
incus launch images:debian/trixie incus-web-agent-golden \
  --profile incus-web-agent

# Install toolchains inside container
incus exec incus-web-agent-golden -- bash /path/to/toolchain-install.sh

# Snapshot for fast cloning
incus snapshot incus-web-agent-golden golden-base
```

### Credential Tracking

Golden container tracks credential hash to detect stale credentials:

```javascript
// scripts/agent-runs.mjs
function trackCredentials(containerName) {
  const ghToken = incus exec ... cat ~/.config/gh/config.yml
  const gitConfig = incus exec ... cat ~/.gitconfig
  const hash = hashCredentials(ghToken, gitConfig)

  incus config set incus-web-agent-golden agent.credential_hash $hash
}
```

If credentials change in source container, clones fail and golden container is rebuilt.

## Agent Run Lifecycle

### 1. User Initiates Run

User fills dispatch form:
```typescript
{
  agent: "codex" | "claude",
  task: "Fix the authentication bug",
  repositoryUrl: "https://github.com/user/repo",
  branch: "main",
  workingDirectory: "/workspace/repo",
}
```

### 2. Provisioner Validates

```javascript
// scripts/agent-runs.mjs
function validateAgentRun(command, config) {
  if (command.agent === "codex" && !config.codexAppServerUrl) {
    throw new Error(CODEX_APP_SERVER_NOT_CONFIGURED)
  }
  if (!command.repositoryUrl) {
    throw new Error("Repository URL required")
  }
  // ... more validation
}
```

### 3. Create Run Record

```javascript
const run = {
  id: generateId(),
  workspaceId: command.workspaceId,
  agent: command.agent,
  task: command.task,
  repositoryUrl: command.repositoryUrl,
  status: "queued",
  phase: "queued",
  container: { state: "planned" },
  createdAt: new Date().toISOString(),
}

await store.insert(run)
```

### 4. Clone Golden Container

```bash
# Fast ZFS clone
incus copy incus-web-agent-golden <run-id> \
  --target-project default \
  --mode snapshot
```

Container states: `planned` → `cloning` → `stopped`

### 5. Inject Credentials

Credentials copied from source container:

```bash
# Copy GitHub token
incus exec <run-id> -- mkdir -p ~/.config/gh
incus file push incus-web~/.config/gh/config.yml <run-id>~/.config/gh/

# Copy gitconfig
incus file push incus-web~/.gitconfig <run-id>~/

# Copy SSH keys
incus file push -r incus-web~/.ssh <run-id>~/

# Copy Codex/Claude configs
incus file push incus-web~/.config/codex <run-id>~/.config/
incus file push incus-web~/.config/claude <run-id>~/.config/
```

Phase: `injecting_credentials`

### 6. Clone Repository

```bash
incus exec <run-id> -- git clone --depth=1 $REPO_URL /workspace/repo
incus exec <run-id> -- git checkout $BRANCH
```

Phase: `cloning_repo`

### 7. Attach Controller

**Codex app-server:**
```javascript
// scripts/agent-runs.mjs
const codexResponse = await fetch(config.codexAppServerUrl, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${config.codexAppServerToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    run_id: run.id,
    task: command.task,
    working_directory: command.workingDirectory,
    repository_url: command.repositoryUrl,
    callback_url: `${PUBLIC_URL}/api/agent-runs/${run.id}/callback`,
  }),
})

const { agent_run_id } = await codexResponse.json()
```

Controller attaches via HTTP callback. Agent runs in Codex service, periodically contacting the ephemeral container.

**Claude CLI:**
```bash
incus exec <run-id> -- sudo -u agent bash -c "
  cd /workspace/repo
  claude -p 'Fix the authentication bug'
"
```

Controller attaches via interactive shell. Claude runs inside the container.

Phase: `attaching_agent`

### 8. Agent Running

Agent executes task with full toolchain access:
- Node, Python, Go, Rust compilers/interpreters
- Git and GitHub CLI
- Claude Code or Codex CLI
- File system access at `/workspace`

Phase: `running`

### 9. Monitor and Complete

**Codex:** Codex app-server sends status updates via callback:
```typescript
POST /api/agent-runs/:runId/callback
{
  status: "running" | "succeeded" | "failed",
  phase: "running" | "succeeded" | "failed",
  completedAt: "2026-07-03T12:00:00Z",
  result: { ... },
}
```

**Claude:** Provisioner monitors shell process:
```javascript
const proc = spawn("incus", ["exec", runId, "--", ...claudeCmd])
proc.on("close", (code) => {
  if (code === 0) {
    store.update(run.id, {
      status: "succeeded",
      phase: "succeeded",
      completedAt: new Date().toISOString(),
    })
  } else {
    store.update(run.id, {
      status: "failed",
      phase: "failed",
      completedAt: new Date().toISOString(),
      error: "Process exited with code " + code,
    })
  }
})
```

### 10. Cleanup

After completion or timeout:
```bash
incus delete <run-id>
```

Container state: `deleted`

Run record retained in history:
```javascript
await store.list(workspaceId, 20)
// Returns last 20 runs, most recent first
```

## Controller Types

### Codex App-Server

**Configuration:**
```bash
INCUS_WEB_CODEX_APP_SERVER_URL=https://codex.example.com
INCUS_WEB_CODEX_APP_SERVER_TOKEN=secret-token
INCUS_WEB_CODEX_MODEL=gpt-4
INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS=43200000  # 12 hours
```

**Flow:**
1. Provisioner sends HTTP POST to Codex app-server
2. Codex app-server creates agent run, returns `agent_run_id`
3. Codex agent executes tasks, calling back to ephemeral container
4. Codex sends final status via callback

**Advantages:**
- Agent runs in managed service
- Persistent state across container failures
- Can handle long-running tasks

**Disadvantages:**
- Requires external Codex service
- Network latency between agent and container

### Claude CLI

**Configuration:**
```bash
INCUS_WEB_CLAUDE_COMMAND_TEMPLATE="claude -p {{task}}"
```

**Flow:**
1. Provisioner starts Claude CLI inside container
2. Claude runs interactively with terminal access
3. Claude completes task and exits
4. Provisioner captures exit code

**Advantages:**
- No external service required
- Agent runs directly in container
- Lower latency

**Disadvantages:**
- Agent state tied to container lifetime
- Harder to monitor progress
- Interactive nature complicates automation

## Stale Credential Detection

### Problem

If credentials change in source container after golden container is created, subsequent agent runs will have stale credentials.

### Solution

Golden container tracks credential hash:

```bash
# When golden container is created or credentials change
GH_TOKEN=$(incus exec incus-web -- cat ~/.config/gh/config.yml | base64)
GIT_CONFIG=$(incus exec incus-web -- cat ~/.gitconfig | base64)
CREDENTIAL_HASH=$(echo -n "${GH_TOKEN}${GIT_CONFIG}" | sha256sum)

incus config set incus-web-agent-golden agent.credential_hash $CREDENTIAL_HASH
```

### Validation

Before cloning, provisioner checks hash:

```javascript
const currentHash = getCredentialsFromSource("incus-web")
const goldenHash = incus config get incus-web-agent-golden agent.credential_hash

if (currentHash !== goldenHash) {
  throw new Error("Stale credentials: golden container must be rebuilt")
}
```

### Rebuild

If hash mismatches, golden container is rebuilt:
```bash
incus delete incus-web-agent-golden
./scripts/build-agent-golden.sh
```

## Timeouts

### Command Timeouts

Per-command timeout for `incus` CLI invocations:
```bash
INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS=180000  # 3 minutes
```

ZFS COW clones complete quickly, but `incus copy` CLI can take up to a couple minutes to report completion after data is ready.

### Request Timeouts

Overall HTTP request timeout:
```bash
INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS=200000  # 3.3 minutes
```

### Agent Run Timeouts

**Codex:**
```bash
INCUS_WEB_CODEX_APP_SERVER_TIMEOUT_MS=43200000  # 12 hours
```

**Claude:**
Claude CLI runs interactively, so timeout is managed by shell process lifetime.

## Store

Agent runs are stored in JSON file:
```javascript
// /var/lib/incus-web/agent-runs.json
[
  {
    "id": "run-abc123",
    "workspaceId": "workspace-incus-web",
    "agent": "codex",
    "task": "Fix the authentication bug",
    "repositoryUrl": "https://github.com/user/repo",
    "status": "succeeded",
    "phase": "succeeded",
    "container": {
      "name": "run-abc123",
      "state": "deleted"
    },
    "controller": {
      "kind": "codex-app-server",
      "agentRunId": "codex-run-xyz"
    },
    "createdAt": "2026-07-03T10:00:00Z",
    "updatedAt": "2026-07-03T12:00:00Z",
    "completedAt": "2026-07-03T12:00:00Z"
  }
]
```

Store operations:
```javascript
await store.list(workspaceId, limit = 20)
await store.insert(run)
await store.update(runId, patch)
```

## Error Handling

### Common Errors

**`not_configured`** - Agent run system not configured:
- Codex: app-server URL missing
- Claude: CLI not installed

**`template_unavailable`** - Golden container doesn't exist:
```javascript
if (!containerExists(config.goldenContainer)) {
  throw new Error("Golden container not found. Run build-agent-golden.sh")
}
```

**`stale_credentials`** - Credential hash mismatch:
```javascript
if (currentHash !== goldenHash) {
  throw new Error("Stale credentials. Rebuild golden container")
}
```

**`timeout`** - Agent run exceeded timeout:
```javascript
if (elapsed > config.timeoutMs) {
  await failRun(store, run.id, new Error("Agent run timeout"))
  incus delete run.id
}
```

**`operation_failed`** - Incus operation failed:
```bash
incus copy ... && exit $?
# If exit code non-zero, mark run as failed
```

## Related Documentation

- [Provisioner Contract](domain/provisioner-contract.md) - DispatchAgentRun specification
- [Architecture](architecture.md) - Agent run architecture
- [Security](operations/security.md) - Credential isolation
- [Deployment](workflows/deployment.md) - Golden container setup
