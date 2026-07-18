# Workspace Lifecycle

## Overview

Workspaces are Incus containers that provide isolated developer environments with browser-based terminal access. The lifecycle includes creation, startup, setup execution, status monitoring, and destruction.

## Workspace States

Workspaces transition through the following states (from `apps/web/lib/provisioner/contracts.ts`):

```
creating → stopped → starting → running
              ↓           ↓
           restarting ← setting_up
              ↓
            degraded / failed
```

**State descriptions**:
- `creating` - Container is being provisioned
- `stopped` - Container exists but is not running
- `starting` - Container is booting
- `running` - Container is running and ready
- `stopping` - Container is shutting down
- `restarting` - Container is restarting
- `setting_up` - Setup scripts are running (mise, dotfiles, tooling)
- `degraded` - Container is running but some services are unhealthy
- `failed` - Container or setup failed

## Setup Phases

When a workspace is configured for setup, it progresses through these phases:

```
not_configured → queued → installing_mise → applying_dotfiles → checking_tools → ready
                                           ↓
                                        failed
```

**Phase descriptions**:
- `not_configured` - Setup not configured or disabled
- `queued` - Setup is queued
- `installing_mise` - Installing mise (version manager)
- `applying_dotfiles` - Applying dotfiles from Git repository
- `checking_tools` - Verifying installed tools
- `ready` - Setup completed successfully
- `failed` - Setup failed

## Creation Workflow

### 1. User Initiates Creation

User calls `CreateWorkspace` through control plane API:
```typescript
POST /api/workspaces
{
  workspaceId: "workspace-abc123",
  ownerUserId: "oidc:user@example.com",
  // ... metadata
}
```

### 2. Authorization Check

Control plane resolves actor from OIDC headers:
```typescript
// apps/web/lib/auth/identity.ts
const actor = {
  userId: "oidc:user@example.com",
  email: "user@example.com",
  displayName: "User Name",
  requestId: "req-xyz",
}
```

Validates workspace ownership/authorization.

### 3. Provisioner Call

Control plane calls provisioner:
```typescript
// apps/web/lib/provisioner/client.ts
await provisioner.createWorkspace({
  command: "CreateWorkspace",
  workspaceId: "workspace-abc123",
  incusProject: "default",
  incusContainer: "incus-web",
  ownerUserId: "oidc:user@example.com",
  // ... metadata
})
```

### 4. Provisioner Validation

Provisioner validates metadata:
```javascript
// scripts/provisioner-server.mjs
function validateWorkspaceMetadata(command) {
  if (command.workspaceId !== command.workspaceId) {
    return { code: "metadata_mismatch", message: "Workspace ID mismatch" }
  }
  if (command.incusProject !== "default") {
    return { code: "invalid_input", message: "Invalid project" }
  }
  // ... more validation
}
```

### 5. Container Launch

Provisioner launches container:
```bash
incus launch images:debian/trixie incus-web \
  --profile incus-web-agent \
  --config boot.autostart=false \
  --device workspace=.../host/path
```

### 6. Status Returned

Provisioner returns initial status:
```json
{
  "state": "creating",
  "setupPhase": "not_configured",
  "container": {
    "name": "incus-web",
    "project": "default",
    "ipv4Address": "198.18.0.10"
  }
}
```

## Startup Workflow

### 1. Start Command

User calls `StartWorkspace`:
```typescript
await provisioner.startWorkspace({
  workspaceId: "workspace-abc123",
  incusProject: "default",
  incusContainer: "incus-web",
})
```

### 2. Provisioner Starts Container

```bash
incus start incus-web
```

### 3. Status Polling

Control plane polls `GetWorkspaceStatus`:
```typescript
const status = await provisioner.getWorkspaceStatus({
  workspaceId: "workspace-abc123",
  incusProject: "default",
  incusContainer: "incus-web",
})
// Returns: { state: "running", ... }
```

### 4. Terminal Access

User opens terminal via WeTTY or ghostty-web:
- Tailscale: `https://incus-web.<tailnet>.ts.net`
- OIDC: `https://$PUBLIC_URL` (with oauth2-proxy auth)

## Setup Workflow

### 1. Configure Setup

Setup is configured via environment:
```bash
SETUP_ENABLED=1
SETUP_ALLOWED_EMAILS=user@example.com
SETUP_PORT=3080
```

### 2. Run Setup Command

User calls `RunSetup`:
```typescript
await provisioner.runSetup({
  workspaceId: "workspace-abc123",
  incusProject: "default",
  incusContainer: "incus-web",
  setupPhase: "ready",  // Target phase
})
```

### 3. Provisioner Executes Setup

```bash
# Inside container
incus exec incus-web -- sudo -u agent bash -c "
  curl https://mise.run | bash
  mise install node@22 python@latest
  git clone --depth=1 https://github.com/user/dotfiles ~/.dotfiles
  ~/.dotfiles/install.sh
  mise doctor
"
```

### 4. Status Updates

Provisioner updates setup phase:
```json
{
  "state": "setting_up",
  "setupPhase": "installing_mise"
}
```

Progressively updates through phases until `ready` or `failed`.

## Status Monitoring

### Status Adapter

Status adapter maps Incus state to domain model:
```typescript
// apps/web/lib/provisioner/status-adapter.ts
function statusToWorkspace(incusStatus, setupPhase) {
  const state = mapIncusState(incusStatus)
  const setupPhase = mapSetupPhase(setupPhase)

  return {
    workspaceId: "workspace-abc123",
    state,
    setupPhase,
    container: {
      name: "incus-web",
      ipv4Address: "198.18.0.10",
      cpu: 2,
      memory: 4GiB,
      // ...
    },
    owner: {
      userId: "oidc:user@example.com",
      email: "user@example.com",
    },
  }
}
```

### Dashboard UI

Control plane renders live status:
```typescript
// apps/web/components/workspace-dashboard.tsx
<WorkspaceDashboard
  workspace={workspace}
  status={status}
  onStart={() => startWorkspace(workspace.workspaceId)}
  onStop={() => stopWorkspace(workspace.workspaceId)}
  onRestart={() => restartWorkspace(workspace.workspaceId)}
  onRunSetup={() => runSetup(workspace.workspaceId)}
/>
```

## Lifecycle Actions

### Stop Workspace

```typescript
await provisioner.stopWorkspace({
  workspaceId: "workspace-abc123",
  incusProject: "default",
  incusContainer: "incus-web",
})
```

Provisioner executes:
```bash
incus stop incus-web --force
```

### Restart Workspace

```typescript
await provisioner.restartWorkspace({
  workspaceId: "workspace-abc123",
  incusProject: "default",
  incusContainer: "incus-web",
})
```

Provisioner executes:
```bash
incus restart incus-web --force
```

### Delete Workspace

Not yet implemented in current prototype. Planned for future multi-tenant version:
```typescript
await provisioner.deleteWorkspace({
  workspaceId: "workspace-abc123",
  incusProject: "default",
  incusContainer: "incus-web",
})
```

Provisioner would execute:
```bash
incus delete incus-web
# Optionally cleanup ZFS dataset, host directory
```

## Multi-Tenant Ownership

### Current Prototype

Single workspace with configurable owner:
```bash
INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated  # Current OIDC user owns workspace
INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1            # Required for authenticated mode
```

Or:
```bash
INCUS_WEB_WORKSPACE_OWNER_MODE=none  # No ownership checks (development)
```

### Future Database-Backed Model

Planned multi-tenancy with database records:
```typescript
type Workspace = {
  workspaceId: string
  ownerUserId: string
  project: string
  container: string
  createdAt: string
  resourceProfileId: string
}

type WorkspaceGrant = {
  workspaceId: string
  userId: string
  role: "admin" | "collaborator"
  grantedBy: string
  grantedAt: string
}
```

Control plane would query database for ownership before allowing actions.

## Error Handling

### Common Errors

**`invalid_input`**:
- Invalid workspace ID or metadata
- Missing required fields

**`metadata_mismatch`**:
- Workspace ID doesn't match container/project tuple
- Owner ID doesn't match expected owner

**`invalid_state`**:
- Operation not allowed in current state (e.g., start already running container)

**`incus_unavailable`**:
- Incus daemon not running
- Incus socket not accessible

**`setup_failed`**:
- Setup script failed
- Tool installation failed

### Error Response Format

```json
{
  "error": {
    "code": "metadata_mismatch",
    "message": "Workspace ID does not match container",
    "retryable": false,
    "details": {
      "expectedWorkspaceId": "workspace-abc123",
      "actualContainerName": "different-container"
    }
  }
}
```

## Related Documentation

- [Provisioner Contract](../domain/provisioner-contract.md) - Command specifications
- [Multi-Tenant Control Plane](../domain/multi-tenant-control-plane.md) - Roles and permissions
- [Architecture](../architecture.md) - System architecture overview
- [Deployment](deployment.md) - How to deploy and configure
