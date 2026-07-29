---
type: Documentation Quickstart
title: "incus-web Quick Start"
description: "incus-web creates browser-accessible developer workspaces inside Incus system containers. It provides:"
---

# incus-web Quick Start

## What is incus-web?

incus-web creates browser-accessible developer workspaces inside Incus system containers. It provides:

- **Container provisioning** - Incus containers with developer toolchains (Node, Python, Go, Rust, Git, GitHub CLI, Claude Code, Codex CLI)
- **Browser terminal access** - WeTTY or experimental ghostty-web backend accessed through Tailscale Serve or OIDC reverse proxy
- **Multi-tenant control plane** - Next.js web app for workspace inventory, lifecycle management, and agent run dispatch
- **Host-local provisioner** - Security boundary between control plane and Incus host operations
- **AI agent run dispatch** - Ephemeral containers for Codex and Claude agent execution with credential injection

## Quick Start

### 1. Prepare Environment

Create a working directory and configure secrets:

```bash
git clone https://github.com/jmagar/incus-web.git ~/incus-web-run
cd ~/incus-web-run
cp .env.example .env
chmod 600 .env
editor .env  # Configure ACCESS_MODE and related secrets
```

### 2. Deploy

Run the deploy script from the repository:

```bash
./deploy.sh
```

The deploy script:
- Installs and configures Incus if missing
- Creates a Debian Trixie container with developer tools
- Sets up network bridge with RFC1918 egress blocking
- Configures Tailscale or OIDC access mode
- Installs host provisioner service
- Optionally installs the Next.js control plane service

### 3. Access the Terminal

**Tailscale mode:**
```bash
# Container joins your tailnet at $TS_HOSTNAME (default: incus-web)
# Access via HTTPS: https://incus-web.<tailnet-name>.ts.net
```

**OIDC mode:**
```bash
# Configure OIDC provider (e.g., Auth0, Azure AD, Google)
# Set PUBLIC_URL, OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
# Access via: https://$PUBLIC_URL
```

## Architecture Overview

incus-web consists of three major components:

### 1. Workspace Containers (Incus)
- **Profile source**: `incus-web-profile.yaml` defines container shape, security, and resource limits
- **Base image**: Debian Trixie with toolchains (zsh, Node 22, Python, Go, Rust, Git, GitHub CLI, Claude Code, Codex CLI)
- **Access layer**: WeTTY (port 3000) or ghostty-web behind Tailscale Serve or oauth2-proxy
- **Network isolation**: Dedicated bridge with ACL blocking RFC1918 and IPv4 link-local egress
- **Security**: Unprivileged containers with nesting enabled for Docker/Incus workflows

### 2. Control Plane (Next.js)
- **Location**: `apps/web/`
- **Framework**: Next.js 16 with App Router, Aurora UI components (shadcn/radix-ui)
- **Features**: Workspace inventory, status dashboard, lifecycle actions, agent run dispatch
- **Authentication**: OIDC reverse-proxy headers or local development mode
- **Authorization**: Multi-tenant workspace ownership and role-based permissions

### 3. Host Provisioner
- **Service**: `incus-web-provisioner.service` systemd unit
- **Transport**: Unix socket `/run/incus-web/provisioner.sock`
- **Authentication**: Bearer token (`INCUS_WEB_PROVISIONER_TOKEN`)
- **Contract**: `provisioner.v1` defined in `docs/contracts/provisioner-boundary-v1.md`
- **Operations**: Create, start, stop, restart workspaces; run setup; dispatch agent runs

## Documentation Sections

### Architecture
- [**Architecture Overview**](architecture.md) - System components, relationships, and design principles
- Incus container profiles and security boundaries
- Control plane and provisioner separation
- Agent run dispatch architecture

### Workflows
- [**Deployment**](workflows/deployment.md) - How to deploy and configure incus-web
- [**Workspace Lifecycle**](workflows/workspace-lifecycle.md) - Creating and managing workspaces
- [**Agent Runs**](workflows/agent-runs.md) - Dispatching AI agents in ephemeral containers

### Domain Concepts
- [**Provisioner Contract**](domain/provisioner-contract.md) - Provisioner boundary specification (provisioner.v1)
- [**Multi-Tenant Control Plane**](domain/multi-tenant-control-plane.md) - Actors, roles, and permissions
- [**Workspace Model**](domain/workspaces.md) - Workspace states, setup phases, and ownership

### Operations
- [**Configuration**](operations/configuration.md) - Environment variables and settings
- [**Security**](operations/security.md) - Security model, boundaries, and hardening
- [**Testing**](operations/testing.md) - Static tests, smoke tests, and unit tests
- [**Backup and Restore**](operations/backup-restore.md) - SQLite state backup, integrity, and restore procedure
- [**Monitoring and Alerts**](operations/monitoring.md) - Readiness gauges, alert thresholds, and response runbooks

### OpenWiki documentation workflow

Repository documentation is regenerated through `.github/workflows/openwiki-update.yml`, which runs:

- `openwiki code --update --print`
- `OPENWIKI_PROVIDER=openrouter` with model `z-ai/glm-5.2`
- automatic pull requests that include `openwiki/`, `AGENTS.md`, `CLAUDE.md`, and `.github/workflows/openwiki-update.yml`

## Key Design Principles

### Security Boundary
The provisioner is the only component allowed to mutate Incus state. The Next.js control plane calls product-level commands (`CreateWorkspace`, `StartWorkspace`, `DispatchAgentRun`) and never receives raw Incus credentials or API access. See [Provisioner Contract](domain/provisioner-contract.md).

### Unprivileged Containers
Workspaces run as unprivileged Incus containers with nesting enabled. Privileged containers should be reserved for explicitly trusted single-tenant scenarios. The AppArmor profile in `incus-web-profile.yaml` allows signal peer access for nested systemd contexts.

### Multi-Tenant by Design
The control plane supports authenticated actors, workspace ownership, and role-based permissions. The current prototype uses a shared workspace with configurable owner mode (`INCUS_WEB_WORKSPACE_OWNER_MODE`). Database-backed multi-tenancy is planned.

### Golden Container Pattern
Agent runs clone a "golden" container with preinstalled tooling, then inject credentials and attach an AI controller. This enables fast agent spinup with proper isolation. See [Agent Runs](workflows/agent-runs.md).

## Next Steps

1. **Deploy your first workspace**: Follow the [deployment guide](workflows/deployment.md)
2. **Understand the architecture**: Read [architecture overview](architecture.md)
3. **Learn the provisioner contract**: Study [provisioner boundary specification](domain/provisioner-contract.md)
4. **Explore agent runs**: See [agent run dispatch](workflows/agent-runs.md)

## Repository Structure

```
incus-web/
├── incus-web-profile.yaml    # Container profile (source of truth)
├── deploy.sh                 # Main deploy script
├── distrobuilder.yaml        # Incus image build recipe
├── apps/web/                 # Next.js control plane
│   ├── app/                  # App Router pages and API routes
│   ├── lib/                  # Business logic and contracts
│   └── components/           # React components
├── scripts/                  # Host-side scripts
│   ├── provisioner-server.mjs     # Host provisioner service
│   ├── agent-runs.mjs             # Agent run dispatch logic
│   ├── incus-web-lib.sh           # Shared shell library
│   └── build-agent-golden.sh     # Golden container setup
├── docs/                     # Design documentation
│   ├── contracts/            # Contract specifications
│   ├── sessions/             # Work session logs
│   └── superpowers/         # Plans and specs
└── tests/                    # Static and integration tests
```

## Contributing

See deployment documentation for local development setup. The repository uses:
- Shell scripts for host provisioning (deploy.sh, incus-web-lib.sh)
- Node.js for provisioner service (provisioner-server.mjs, agent-runs.mjs)
- TypeScript/Next.js for control plane (apps/web/)

Run tests with:
```bash
# Static tests
./tests/deploy_static_tests.sh

# Smoke test image
./scripts/smoke-image.sh

# Web app tests
npm --prefix apps/web run lint
npm --prefix apps/web run test
npm --prefix apps/web run build
```
