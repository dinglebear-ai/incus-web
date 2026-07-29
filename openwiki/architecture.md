---
type: Reference
title: "Architecture"
description: "incus-web creates browser-accessible developer workspaces through a three-tier architecture:"
---

# Architecture

## System Overview

incus-web creates browser-accessible developer workspaces through a three-tier architecture:

1. **Incus containers** - Isolated Linux environments with developer toolchains
2. **Host provisioner** - Security boundary that translates product commands into Incus operations
3. **Control plane** - Next.js web app for workspace management and agent dispatch

```
┌─────────────────────────────────────────────────────────────────┐
│                     Browser Client                              │
│              (OIDC auth or Tailscale identity)                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Next.js Control Plane                          │
│                   (apps/web/)                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Workspace Dashboard  │  Agent Run Dispatch  │  Actions│   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                       │
│                   Actor Resolution                              │
│                   (OIDC headers or dev mode)                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ bearer token over Unix socket
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Host Provisioner                               │
│            (scripts/provisioner-server.mjs)                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Contract: provisioner.v1                                 │   │
│  │  Commands: CreateWorkspace, StartWorkspace,               │   │
│  │            StopWorkspace, RunSetup, DispatchAgentRun      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                       │
│                   Unix socket: /run/incus-web/provisioner.sock  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ incus CLI commands
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Incus Daemon                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Containers: incus-web (workspace)                       │   │
│  │              incus-web-agent-golden (agent run base)     │   │
│  │              <run-id> (ephemeral agent containers)       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │                                       │
│                   Network: agentbr0 (RFC1918-blocked ACL)       │
└─────────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. Workspace Containers

**Profile source**: `incus-web-profile.yaml`

Each workspace is an Incus system container with:

**Base image**: Debian Trixie with toolchains:
- Shell: zsh
- Languages: Node 22, Python 3, Go, Rust/Cargo
- Tools: Git, GitHub CLI, Claude Code, Codex CLI
- Terminals: WeTTY (default) or experimental ghostty-web

**Security model**:
- `security.privileged=false` - Unprivileged container
- `security.nesting=true` - Allows Docker/Incus workflows
- AppArmor profile with signal peer rules for nested systemd
- Resource limits: 2 CPU, 4GiB RAM, 2048 processes (configurable)

**Network isolation**:
- Dedicated managed bridge: `agentbr0`
- ACL: `agent-block-lan` rejects RFC1918 and IPv4 link-local egress
- No direct LAN access by default

**Access layer**:
- **Tailscale mode**: Container runs Tailscale with `tailscale serve` HTTPS route
- **OIDC mode**: oauth2-proxy reverse proxy in front of WeTTY

**Storage**:
- Host directory mounted at `/workspace` (persistent working files)
- ZFS-backed with quota support (when using ZFS storage pool)

### 2. Host Provisioner

**Service**: `incus-web-provisioner.service` systemd unit

**Entry point**: `scripts/provisioner-server.mjs`

**Transport**:
- Preferred: Unix socket at `/run/incus-web/provisioner.sock` (mode 0660)
- Fallback: localhost HTTP on configured port
- Must not be exposed to external networks

**Authentication**:
- Bearer token: `INCUS_WEB_PROVISIONER_TOKEN`
- Token proves caller is trusted control-plane service
- Token does not carry authorization claims
- Workspace metadata validated before each mutation

**Contract**: `provisioner.v1` (see [domain/provisioner-contract.md](domain/provisioner-contract.md))

**Commands**:
- `CreateWorkspace` - Provision new workspace container
- `StartWorkspace` / `StopWorkspace` / `RestartWorkspace` - Lifecycle control
- `GetWorkspaceStatus` - Query container and setup state
- `RunSetup` - Execute mise, dotfiles, tooling setup
- `DispatchAgentRun` - Create ephemeral container for AI agent
- `ListAgentRuns` - Query agent run history

**Safety properties**:
- Validates workspace metadata (project, container, owner) before mutation
- Status caching with TTL to reduce Incus queries
- Command timeout and concurrency limits
- Redacted operation store (no sensitive values in logs)

**Agent run support**:
- Clones golden container instead of full image rebuild
- Injects credentials from source container
- Manages ephemeral agent container lifecycle
- Supports Codex app-server and Claude CLI controllers

### 3. Control Plane

**Location**: `apps/web/`

**Framework**: Next.js 16 with App Router

**UI**: Aurora components from shadcn/radix-ui registry

**Authentication flows**:
- **Production**: OIDC reverse-proxy headers (`X-Remote-User`, `X-Remote-Email`)
- **Development**: Local actor from `INCUS_WEB_DEV_ACTOR_*` env vars

**Authorization**:
- Multi-tenant workspace ownership (planned: database-backed)
- Current prototype: configurable owner mode
  - `INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated` - Current OIDC user owns workspace
  - `INCUS_WEB_WORKSPACE_OWNER_MODE=none` - No ownership checks (development)
- Role-based permissions: owner, admin, collaborator (contract-defined, not yet enforced)

**Key features**:
- Workspace inventory dashboard
- Live status monitoring (container state, setup phase, agent runs)
- Lifecycle actions (start, stop, restart)
- Agent run dispatch UI
- Terminal launch (WeTTY/ghostty-web URL)

**API structure**:
```
apps/web/app/api/
├── workspaces/
│   └── [workspaceId]/
│       ├── route.ts                # Workspace status and actions
│       ├── actions/route.ts        # Lifecycle commands
│       └── agent-runs/
│           ├── route.ts           # Agent run list
│           └── route.test.ts      # Integration tests
└── healthz/route.ts                # Health check
```

**Business logic**:
```
apps/web/lib/
├── provisioner/
│   ├── contracts.ts                # Contract types and validation
│   ├── client.ts                   # Provisioner client interface
│   ├── host-transport.ts          # Unix socket transport
│   ├── status-adapter.ts           # Incus status → domain model
│   └── *.test.ts                   # Unit tests
├── workspaces/
│   ├── provisioner.ts              # Workspace provisioning logic
│   └── *.test.ts                   # Unit tests
└── auth/
    └── identity.ts                 # Actor resolution
```

### 4. Agent Run Architecture

Agent runs execute AI coding tasks in ephemeral containers with proper isolation and credential management.

**Components**:
- `scripts/agent-runs.mjs` - Agent run orchestration
- `scripts/build-agent-golden.sh` - Golden container setup
- `apps/web/components/agent-run-dispatch.tsx` - Dispatch UI

**Flow**:
1. User initiates agent run with task and repository
2. Provisioner clones golden container (`incus-web-agent-golden`)
3. Credentials injected from source container (`~/.config/gh`, `~/.gitconfig`, etc.)
4. Repository cloned into ephemeral container
5. AI controller attached:
   - **Codex app-server**: HTTP callback to Codex service
   - **Claude CLI**: Interactive shell with `claude -p "{{task}}"`
6. Agent runs in container with full toolchain access
7. Container deleted after completion or timeout

**Stale credential detection**:
- Golden container tracks credential hash
- Clones fail if source credentials changed
- Forces golden container rebuild on credential rotation

**Controllers**:
- `codex-app-server`: Requires `INCUS_WEB_CODEX_APP_SERVER_URL` and token
- `claude-cli`: Uses template command `INCUS_WEB_CLAUDE_COMMAND_TEMPLATE`

**Timeouts**:
- Default: 12 hours (43,200,000 ms) for Codex
- Configurable per controller

## Design Principles

### Security Boundary
The provisioner is the only component that mutates Incus state. The control plane calls product commands, never raw Incus operations. This boundary:
- Prevents compromised web app from accessing Incus directly
- Allows audit and rate limiting at provisioner level
- Enables future multi-tenant isolation at host level

### Unprivileged by Default
Workspaces run unprivileged with nesting for container workflows. Privileged containers require explicit configuration and should be rare.

### Network Isolation
The `agent-block-lan` ACL blocks workspace access to RFC1918 and link-local ranges. This:
- Prevents workspace scanning internal networks
- Contains potential lateral movement
- Requires explicit network configuration for allowed services

### Golden Container Pattern
Agent runs use a prebuilt "golden" container instead of rebuilding from scratch. This:
- Reduces agent spinup time (ZFS clone is fast)
- Ensures consistent tooling across runs
- Separates credential injection from base image

### Contract Versioning
The provisioner contract (`provisioner.v1`) is versioned and documented. Breaking changes require new contract versions. This:
- Allows independent evolution of control plane and provisioner
- Supports multiple contract versions in production
- Provides clear upgrade paths

## Data Flow Examples

### Workspace Creation

```
User → Control Plane (CreateWorkspace API)
     → Resolves actor from OIDC headers
     → Validates ownership/authorization
     → Calls provisioner.CreateWorkspace
     → Provisioner validates metadata
     → Runs: incus launch images:debian/trixie <container>
     → Configures network, storage, profile
     → Runs setup scripts inside container
     → Returns workspace status
     → Control plane renders dashboard
```

### Agent Run Dispatch

```
User → Control Plane (DispatchAgentRun API)
     → Validates workspace ownership
     → Calls provisioner.DispatchAgentRun
     → Provisioner clones golden container
     → Injects credentials from source
     → Clones repository
     → Attaches controller (Codex/Claude)
     → Returns run ID
     → User monitors run via dashboard
     → Agent runs in container with full toolchain
     → On completion, container deleted
```

## Security Boundaries

### Between User and Control Plane
- **Boundary**: OIDC reverse-proxy or Tailscale authentication
- **Enforcement**: Only authenticated identities reach control plane
- **Isolation**: Each workspace has owner and role-based access

### Between Control Plane and Provisioner
- **Boundary**: Unix socket with bearer token authentication
- **Enforcement**: Only trusted control-plane service has token
- **Isolation**: Provisioner validates all metadata before mutation

### Between Provisioner and Incus
- **Boundary**: Incus Unix socket (root-owned)
- **Enforcement**: Only provisioner service user has Incus access
- **Isolation**: Incus enforces container-level isolation

### Between Workspaces
- **Boundary**: Incus container isolation, network ACL
- **Enforcement**: Separate containers, separate network namespaces
- **Isolation**: No direct container-to-container communication by default

## Extension Points

### Adding New Provisioner Commands
1. Define command in `apps/web/lib/provisioner/contracts.ts`
2. Implement in `scripts/provisioner-server.mjs`
3. Add client wrapper in `apps/web/lib/provisioner/client.ts`
4. Create API route in `apps/web/app/api/`
5. Update contract documentation

### Adding New Agent Controllers
1. Define controller kind in contracts
2. Implement controller attachment in `scripts/agent-runs.mjs`
3. Add env vars for controller configuration
4. Update dispatch UI with controller options

### Adding New Workspace States
1. Update state enums in contracts
2. Implement status mapping in `apps/web/lib/provisioner/status-adapter.ts`
3. Update UI to reflect new states
4. Add transition logic in provisioner

## Related Documentation

- [Provisioner Contract](domain/provisioner-contract.md) - Detailed contract specification
- [Multi-Tenant Control Plane](domain/multi-tenant-control-plane.md) - Actors and permissions
- [Deployment](workflows/deployment.md) - How to deploy and configure
- [Security](operations/security.md) - Security model and hardening
