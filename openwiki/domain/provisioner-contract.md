# Provisioner Contract

## Overview

The provisioner contract defines the boundary between the Next.js control plane and the host provisioner service. It specifies commands, authentication, error handling, and versioning.

**Contract version**: `provisioner.v1`

**Design source**: `docs/contracts/provisioner-boundary-v1.md`

**Implementation**:
- Control plane: `apps/web/lib/provisioner/contracts.ts`, `client.ts`
- Provisioner: `scripts/provisioner-server.mjs`

## Transport

### Unix Domain Socket (Preferred)

**Path**: `/run/incus-web/provisioner.sock`

**Mode**: `0660` (group-readable)

**Ownership**: root:incus-web

Only trusted control-plane service user should be in the `incus-web` group.

### Localhost HTTP (Fallback)

**Bind**: `127.0.0.1:$PORT`

**Restrictions**: Must not be exposed through:
- SWAG (Secure Web Application Gateway)
- Tailscale
- Public DNS
- Workspace bridges
- Container-local routes

### Implementation

**Control plane side**: `apps/web/lib/provisioner/host-transport.ts`
```typescript
async function callProvisioner(command: ProvisionerCommand): Promise<ProvisionerOperation> {
  const socket = process.env.INCUS_WEB_PROVISIONER_SOCKET || "/run/incus-web/provisioner.sock"
  const token = process.env.INCUS_WEB_PROVISIONER_TOKEN

  const response = await fetch(`http://unix/${socket}:/${command.endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  })

  return await response.json()
}
```

**Provisioner side**: `scripts/provisioner-server.mjs`
```javascript
const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    send(res, 200, { status: "ok" })
    return
  }

  const auth = req.headers.authorization
  if (!auth || !auth.startsWith("Bearer ")) {
    send(res, 401, { error: { code: "unauthenticated_service", message: "Missing bearer token" }})
    return
  }

  const token = auth.slice(7)
  if (token !== process.env.INCUS_WEB_PROVISIONER_TOKEN) {
    send(res, 401, { error: { code: "unauthenticated_service", message: "Invalid token" }})
    return
  }

  // ... handle command
})

server.listen(socketPath, () => {
  fs.chmod(socketPath, socketMode)
})
```

## Authentication

### Bearer Token

```typescript
type ProvisionerServiceAuth = {
  scheme: "bearer"
  token: string
}
```

**Rules**:
- Token is not a user token
- Token does not carry authorization claims
- Token only proves caller is trusted control-plane service
- User authorization resolved by control plane before command sent
- Provisioner still validates workspace metadata before mutation
- `INCUS_WEB_PROVISIONER_TOKEN` shared only between trusted services
- Bearer auth does not bypass workspace tuple validation

### Token Management

**Generation** (if blank):
```bash
# deploy.sh
if [[ -z "$INCUS_WEB_PROVISIONER_TOKEN" ]]; then
  INCUS_WEB_PROVISIONER_TOKEN=$(openssl rand -base64 32)
fi
```

**Storage**:
```bash
# /etc/incus-web/provisioner.env (mode 0640, root:incus-web)
INCUS_WEB_PROVISIONER_TOKEN=<token>

# /etc/incus-web/web.env (mode 0640, root:incus-web)
INCUS_WEB_PROVISIONER_TOKEN=<token>
```

**Rotation**:
1. Generate new token
2. Update both env files
3. Restart both services
4. Old token immediately invalid

## Scalar Types

```typescript
type RequestId = string              // Opaque request identifier
type UserId = string                 // Opaque user identifier (e.g., "oidc:user@example.com")
type WorkspaceId = string            // Opaque workspace identifier
type OperationId = string             // Opaque operation identifier
type IncusProjectName = string       // Incus project name (e.g., "default")
type IncusContainerName = string      // Incus container name (e.g., "incus-web")
type ResourceProfileId = "local-dev"  // Resource profile (currently only local-dev)
```

**ID format**: Recommended UUIDv7, but callers must not parse IDs.

## Commands

### CreateWorkspace

Creates new workspace container.

```typescript
type CreateWorkspaceCommand = {
  command: "CreateWorkspace"
  requestId: RequestId
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
  resourceProfileId: ResourceProfileId
  repositoryUrl?: string         // Optional: repo to clone during setup
  branch?: string                 // Optional: branch to checkout
}

type CreateWorkspaceResult = {
  operation: {
    operationId: OperationId
    status: "queued" | "running" | "succeeded" | "failed"
    workspaceRef: {
      workspaceId: WorkspaceId
      incusProject: IncusProjectName
      incusContainer: IncusContainerName
      ownerUserId: UserId
    }
  }
}
```

**Validation**:
- Workspace ID format
- Container doesn't already exist
- Owner user ID format
- Resource profile exists

**Side effects**:
- Launches container from image
- Applies profile
- Configures network and storage
- Records workspace metadata

### StartWorkspace

Starts stopped workspace.

```typescript
type StartWorkspaceCommand = {
  command: "StartWorkspace"
  requestId: RequestId
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
}
```

**Validation**:
- Workspace exists
- Owner matches
- Container is stopped

**Side effects**:
- Starts container
- Updates state: `stopped` → `starting` → `running`

### StopWorkspace

Stops running workspace.

```typescript
type StopWorkspaceCommand = {
  command: "StopWorkspace"
  requestId: RequestId
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
}
```

**Validation**:
- Workspace exists
- Owner matches
- Container is running

**Side effects**:
- Stops container
- Updates state: `running` → `stopped`

### RestartWorkspace

Restarts running workspace.

```typescript
type RestartWorkspaceCommand = {
  command: "RestartWorkspace"
  requestId: RequestId
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
}
```

**Validation**:
- Workspace exists
- Owner matches
- Container is running

**Side effects**:
- Restarts container
- Updates state: `running` → `restarting` → `running`

### GetWorkspaceStatus

Queries workspace status.

```typescript
type GetWorkspaceStatusCommand = {
  command: "GetWorkspaceStatus"
  requestId: RequestId
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
}

type WorkspaceStatus = {
  workspaceId: WorkspaceId
  state: WorkspaceState
  setupPhase: SetupPhase
  container: {
    name: IncusContainerName
    project: IncusProjectName
    ipv4Address?: string
    cpu?: number
    memory?: number
    processes?: number
  }
  owner: {
    userId: UserId
    email?: string
  }
}
```

**Validation**:
- Workspace exists
- Owner matches

**Side effects**: None (read-only)

### RunSetup

Executes setup scripts in workspace.

```typescript
type RunSetupCommand = {
  command: "RunSetup"
  requestId: RequestId
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
  targetPhase: SetupPhase
}
```

**Validation**:
- Workspace exists
- Owner matches
- Container is running
- Setup is configured

**Side effects**:
- Runs setup scripts inside container
- Updates setup phase: `queued` → `installing_mise` → `applying_dotfiles` → `checking_tools` → `ready`

### DispatchAgentRun

Creates ephemeral container for AI agent.

```typescript
type DispatchAgentRunCommand = {
  command: "DispatchAgentRun"
  requestId: RequestId
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
  agent: AgentRunAgent          // "codex" | "claude"
  task: string                 // Task description
  repositoryUrl: string        // Repository to clone
  branch?: string              // Branch to checkout
  workingDirectory?: string    // Working directory inside container
}

type DispatchAgentRunResult = {
  run: {
    id: string
    workspaceId: WorkspaceId
    agent: AgentRunAgent
    task: string
    status: AgentRunStatus
    phase: AgentRunPhase
    container: {
      name: string
      state: AgentRunContainerState
    }
    controller: {
      kind: AgentControllerKind
      agentRunId?: string  // For codex-app-server
    }
    createdAt: string
  }
}
```

**Validation**:
- Workspace exists
- Owner matches
- Container is running
- Repository URL is valid
- Agent controller is configured

**Side effects**:
- Clones golden container
- Injects credentials
- Clones repository
- Attaches controller
- Starts agent

### ListAgentRuns

Lists agent runs for workspace.

```typescript
type ListAgentRunsCommand = {
  command: "ListAgentRuns"
  requestId: RequestId
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
  limit?: number  // Default 20
}

type ListAgentRunsResult = {
  runs: AgentRun[]
}
```

**Validation**:
- Workspace exists
- Owner matches

**Side effects**: None (read-only)

### ImportGoldenConfig

Seeds a workspace's `~/.claude` and `~/.codex` from a "golden config" zip
exported with `scripts/export-onboarding.mjs` (settings, MCP config,
skills, agents, plugin registrations, `CLAUDE.md`/`AGENTS.md`, memories).
Mutating — requires the same `getMutableWorkspaceRefForActor` authorization
as `SetWorkspaceLimits`.

```typescript
type ImportGoldenConfigCommand = {
  command: "ImportGoldenConfig"
  requestId: RequestId
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
  sha256Hex: string  // 64-char hex sha256 of the staged upload
}

type ImportGoldenConfigResult = {
  workspaceId: WorkspaceId
  extractedAt: string
  fileCount: number
  warnings: string[]  // best-effort, read from the zip's own manifest.json
}
```

The web app (`POST /api/workspaces/:workspaceId/golden-config`) stages the
uploaded zip at `${INCUS_WEB_GOLDEN_CONFIG_DIR}/<workspaceId>.zip` — a
directory shared between the web app and provisioner system users via
`INCUS_WEB_PROVISIONER_GROUP` — before sending this command. The command
payload never carries a path, only a content hash; the provisioner derives
the staged path itself from the already-authenticated workspace tuple.

**Validation**:
- `sha256Hex` is a 64-character hex digest
- Staged file exists at the derived path and is under
  `INCUS_WEB_GOLDEN_CONFIG_MAX_BYTES`
- Staged file's actual sha256 matches `sha256Hex` (re-verified server-side,
  not trusted from the request)

**Side effects**: Pushes the zip into the container, unzips it, merges
`claude/` and `codex/` into the workspace user's home directories (`cp -a`
over existing files, not a wipe-and-replace), `chown`s the result, and
removes its own temp files inside the container. The host-side staged zip
at `${INCUS_WEB_GOLDEN_CONFIG_DIR}/<workspaceId>.zip` is left in place
(each new upload overwrites it, so there's no unbounded growth) to allow
re-running the import without re-uploading.

## Error Codes

```typescript
type ProvisionerErrorCode =
  | "invalid_input"           // Invalid request format or values
  | "unauthenticated_service" // Missing or invalid bearer token
  | "metadata_mismatch"       // Workspace metadata doesn't match
  | "invalid_state"          // Operation not allowed in current state
  | "template_unavailable"   // Golden container doesn't exist
  | "incus_unavailable"      // Incus daemon not running
  | "zfs_unavailable"        // ZFS not available (for quota operations)
  | "quota_failed"           // Failed to set ZFS quota
  | "setup_failed"           // Setup script failed
  | "missing_controller_config"  // Agent controller not configured
  | "not_implemented"       // Command not yet implemented
  | "timeout"               // Operation timed out
  | "operation_failed"       // Generic failure
  | "golden_config_failed"   // ImportGoldenConfig-specific failure (e.g. unzip missing)
```

### Error Response Format

```typescript
type ProvisionerError = {
  code: ProvisionerErrorCode
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}
```

**Example**:
```json
{
  "error": {
    "code": "metadata_mismatch",
    "message": "Workspace ID does not match container/project tuple",
    "retryable": false,
    "details": {
      "expectedWorkspaceId": "workspace-abc123",
      "actualContainerName": "different-container",
      "actualProject": "default"
    }
  }
}
```

## Operation Format

All commands return an operation wrapper:

```typescript
type ProvisionerOperation = {
  operation: {
    operationId: OperationId
    requestId: RequestId
    status: OperationStatus
    workspaceRef?: ProvisionerWorkspaceRef
    error?: ProvisionerError
    result?: unknown  // Command-specific result
  }
}

type OperationStatus = "queued" | "running" | "succeeded" | "failed"

type ProvisionerWorkspaceRef = {
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  ownerUserId: UserId
}
```

## Versioning

### Contract Version

```typescript
type ProvisionerContractVersion = "provisioner.v1"
```

Breaking changes require new contract version (e.g., `provisioner.v2`).

### Version Negotiation

Control plane sends version in request header:
```http
X-Provisioner-Contract-Version: provisioner.v1
```

Provisioner validates version and returns error if unsupported:
```json
{
  "error": {
    "code": "invalid_input",
    "message": "Unsupported contract version: provisioner.v2",
    "retryable": false
  }
}
```

### Additive Changes

Additive optional fields are allowed when consumers ignore unknown fields:
- New optional fields in existing commands
- New error codes
- New operations (old commands unchanged)

### Breaking Changes

Breaking changes include:
- Removing or renaming fields
- Changing field types
- Removing commands
- Changing error semantics

## Validation

### Request Validation

Provisioner validates all requests before mutation:

```javascript
// scripts/provisioner-server.mjs
function validateCommand(command) {
  if (!command.requestId) {
    return { valid: false, error: "Missing requestId" }
  }

  if (!PROVISIONER_COMMAND_TYPES.includes(command.command)) {
    return { valid: false, error: "Unknown command" }
  }

  if (command.command === "CreateWorkspace") {
    if (!command.workspaceId || !command.incusContainer) {
      return { valid: false, error: "Missing required fields" }
    }
  }

  // ... more validation
}
```

### Metadata Validation

Provisioner validates workspace metadata before mutation:

```javascript
function validateWorkspaceMetadata(command) {
  // Check workspace ID matches container name
  if (command.workspaceId !== `workspace-${command.incusContainer}`) {
    return {
      valid: false,
      error: { code: "metadata_mismatch", message: "Workspace ID mismatch" }
    }
  }

  // Check owner is allowed (future: database lookup)
  // For prototype: just check format

  // Check container exists
  const container = await getContainer(command.incusProject, command.incusContainer)
  if (!container) {
    return {
      valid: false,
      error: { code: "invalid_input", message: "Container does not exist" }
    }
  }

  return { valid: true }
}
```

## Timeouts

### Command Timeout

Per-command timeout for `incus` CLI invocations:
```bash
INCUS_WEB_PROVISIONER_COMMAND_TIMEOUT_MS=180000  # 3 minutes
```

ZFS COW clones complete quickly, but `incus copy` CLI can take up to a couple minutes to report completion.

### Request Timeout

Overall HTTP request timeout:
```bash
INCUS_WEB_PROVISIONER_REQUEST_TIMEOUT_MS=200000  # 3.3 minutes
```

Includes command execution time plus any additional processing.

### Concurrency Limits

Max concurrent Incus commands:
```bash
INCUS_WEB_PROVISIONER_MAX_INCUS_COMMANDS=4
```

Provisioner queues commands if limit reached.

## Implementation Notes

### Status Caching

Provisioner caches status to reduce Incus queries:
```javascript
const statusCacheTtlMs = 2000  // 2 seconds

let statusCache
let statusCacheTime

function getStatus() {
  const now = Date.now()
  if (statusCache && (now - statusCacheTime) < statusCacheTtlMs) {
    return statusCache
  }

  statusCache = fetchStatusFromIncus()
  statusCacheTime = now
  return statusCache
}
```

### Redacted Logs

Provisioner redacts sensitive values from logs:
```javascript
function redactForLogging(command) {
  return {
    ...command,
    // Don't log sensitive values
    repositoryUrl: command.repositoryUrl ? "[REDACTED]" : undefined,
    task: command.task ? "[REDACTED]" : undefined,
  }
}
```

### Concurrency Control

Provisioner limits concurrent Incus commands:
```javascript
const maxConcurrentIncusCommands = 4
let activeIncusCommands = 0

async function withIncusCommand(fn) {
  while (activeIncusCommands >= maxConcurrentIncusCommands) {
    await sleep(100)
  }

  activeIncusCommands++
  try {
    return await fn()
  } finally {
    activeIncusCommands--
  }
}
```

## Related Documentation

- [Multi-Tenant Control Plane](domain/multi-tenant-control-plane.md) - Actors and permissions
- [Architecture](architecture.md) - Provisioner architecture
- [Deployment](workflows/deployment.md) - Provisioner installation
- [Contract Specification](../../docs/contracts/provisioner-boundary-v1.md) - Full contract spec
