---
type: Reference
title: "Multi-Tenant Control Plane"
description: "The multi-tenant control plane defines actors, roles, and permissions for workspace access. It ensures users can only access workspaces they own or have been granted access to."
---

# Multi-Tenant Control Plane

## Overview

The multi-tenant control plane defines actors, roles, and permissions for workspace access. It ensures users can only access workspaces they own or have been granted access to.

**Contract version**: `mtcp.v1`

**Design source**: `docs/contracts/multi-tenant-control-plane-v1.md`

**Status**: Contract defined, partially implemented

## ID Types

All IDs are opaque strings. Recommended format is UUIDv7, but callers must not parse IDs.

```typescript
type UserId = string
type OrgId = string
type WorkspaceId = string
type OperationId = string
type SnapshotId = string
type ResourceProfileId = string
```

## Actor Context

Every control-plane action is evaluated against an authenticated actor.

```typescript
type ActorContext = {
  userId: UserId
  oidcSubject: string
  email: string
  displayName?: string
  requestId: string
  ipAddress?: string
  userAgent?: string
}
```

**Resolution**:
```typescript
// apps/web/lib/auth/identity.ts
function resolveActor(request: NextRequest): ActorContext {
  const oidcSubject = request.headers.get("x-remote-user")
  const email = request.headers.get("x-remote-email")

  if (oidcSubject && email) {
    return {
      userId: `oidc:${oidcSubject}`,
      oidcSubject,
      email: email.toLowerCase(),
      displayName: request.headers.get("x-remote-display-name") || undefined,
      requestId: crypto.randomUUID(),
      ipAddress: request.headers.get("x-forwarded-for") || undefined,
      userAgent: request.headers.get("user-agent") || undefined,
    }
  }

  // Development fallback
  if (process.env.INCUS_WEB_DEV_ACTOR_USER_ID) {
    return {
      userId: process.env.INCUS_WEB_DEV_ACTOR_USER_ID,
      oidcSubject: process.env.INCUS_WEB_DEV_ACTOR_EMAIL || "dev-user",
      email: process.env.INCUS_WEB_DEV_ACTOR_EMAIL || "dev@example.com",
      displayName: process.env.INCUS_WEB_DEV_ACTOR_DISPLAY_NAME,
      requestId: crypto.randomUUID(),
    }
  }

  throw new Error("Unauthenticated: no valid actor context")
}
```

## Roles and Permissions

### Workspace Roles

```typescript
type WorkspaceRole = "owner" | "admin" | "collaborator"
```

### Permission Matrix

| Action | owner | admin | collaborator |
|--------|-------|-------|--------------|
| View workspace | yes | yes | yes |
| Open terminal | yes | yes | yes |
| Run setup | yes | yes | no |
| Start/stop/restart | yes | yes | no |
| Create snapshot | yes | yes | no |
| Fork workspace | yes | yes | yes |
| Share workspace | yes | yes | no |
| Delete workspace | yes | no | no |
| Transfer ownership | yes | no | no |

### Sharing Warning

Sharing grants shell-level access to the same live container and same Linux user. The UI must show the same-user shared-container warning before creating a grant.

## Domain Objects

### Workspace

```typescript
type Workspace = {
  workspaceId: WorkspaceId
  ownerUserId: UserId
  project: string
  container: string
  createdAt: string
  resourceProfileId: ResourceProfileId
  repositoryUrl?: string
  branch?: string
}
```

### WorkspaceGrant

```typescript
type WorkspaceGrant = {
  workspaceId: WorkspaceId
  userId: UserId
  role: WorkspaceRole
  grantedBy: UserId
  grantedAt: string
}
```

### Snapshot

```typescript
type Snapshot = {
  snapshotId: SnapshotId
  workspaceId: WorkspaceId
  createdAt: string
  createdBy: UserId
  name: string
}
```

## Authorization Flow

### 1. Resolve Actor

```typescript
const actor = resolveActor(request)
// { userId: "oidc:user@example.com", email: "user@example.com", ... }
```

### 2. Lookup Workspace

```typescript
const workspace = await db.workspaces.find(workspaceId)
// { workspaceId: "workspace-abc123", ownerUserId: "oidc:user@example.com", ... }
```

### 3. Check Access

```typescript
function hasWorkspaceAccess(actor: ActorContext, workspace: Workspace): boolean {
  // Owner
  if (workspace.ownerUserId === actor.userId) {
    return true
  }

  // Granted access
  const grant = await db.workspaceGrants.find({
    workspaceId: workspace.workspaceId,
    userId: actor.userId,
  })
  if (grant) {
    return true
  }

  return false
}
```

### 4. Check Permission

```typescript
function canPerformAction(
  actor: ActorContext,
  workspace: Workspace,
  action: string
): boolean {
  if (workspace.ownerUserId === actor.userId) {
    // Owner has all permissions
    return true
  }

  const grant = await db.workspaceGrants.find({
    workspaceId: workspace.workspaceId,
    userId: actor.userId,
  })

  if (!grant) {
    return false
  }

  return ROLE_PERMISSIONS[grant.role][action]
}
```

### 5. Execute or Deny

```typescript
if (!canPerformAction(actor, workspace, "RunSetup")) {
  return NextResponse.json(
    { error: { code: "forbidden", message: "Insufficient permissions" }},
    { status: 403 }
  )
}

// Execute action
await provisioner.runSetup({ ... })
```

## Provisioner Authorization

The provisioner does not trust actor-provided authorization claims. The control plane resolves authorization before sending commands, and the provisioner validates workspace metadata before mutation.

### Control Plane Responsibility

- Resolve actor from OIDC headers or dev mode
- Check workspace ownership and grants
- Check role-based permissions
- Send only authorized commands to provisioner

### Provisioner Responsibility

- Validate workspace metadata (project, container, owner)
- Ensure command is allowed for workspace state
- Never trust user-provided authorization claims
- Fail closed on metadata mismatch

## Current Implementation

### Prototype Mode

The current prototype uses a shared workspace with configurable owner mode:

```bash
INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated
INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1
```

**Authenticated mode**:
```typescript
// apps/web/lib/workspaces/provisioner.ts
function configuredOwner(actor: ActorContext): ConfiguredOwner | undefined {
  const ownerMode = process.env.INCUS_WEB_WORKSPACE_OWNER_MODE ?? "none"

  if (ownerMode === "authenticated") {
    if (process.env.INCUS_WEB_ALLOW_SHARED_PROTOTYPE !== "1") {
      throw new Error(
        "INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated requires INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1"
      )
    }
    return {
      userId: actor.userId,
      email: actor.email.toLowerCase(),
    }
  }

  return undefined
}
```

Current OIDC user owns the workspace. Other users are denied access.

**None mode (development)**:
```typescript
if (ownerMode === "none") {
  return undefined  // No ownership checks
}
```

No ownership checks. Useful for local development.

### Future Database-Backed Model

Planned multi-tenancy with database records:

```typescript
// Schema (planned)
const workspaces = pgTable("workspaces", {
  workspaceId: text("workspace_id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull(),
  project: text("project").notNull(),
  container: text("container").notNull(),
  resourceProfileId: text("resource_profile_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  repositoryUrl: text("repository_url"),
  branch: text("branch"),
})

const workspaceGrants = pgTable("workspace_grants", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.workspaceId),
  userId: text("user_id").notNull(),
  role: text("role").notNull(), // "admin" | "collaborator"
  grantedBy: text("granted_by").notNull(),
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
})
```

**Authorization queries**:
```typescript
async function getWorkspace(actor: ActorContext, workspaceId: WorkspaceId): Promise<Workspace> {
  const workspace = await db.workspaces.find(workspaceId)
  if (!workspace) {
    throw new Error("Workspace not found")
  }

  if (workspace.ownerUserId === actor.userId) {
    return workspace
  }

  const grant = await db.workspaceGrants.find({
    workspaceId,
    userId: actor.userId,
  })
  if (!grant) {
    throw new Error("Access denied")
  }

  return workspace
}
```

## Organizational Multi-Tenancy (Planned)

Future support for organizations:

```typescript
type Org = {
  orgId: OrgId
  name: string
  createdAt: string
}

type OrgMember = {
  orgId: OrgId
  userId: UserId
  role: "admin" | "member"
  joinedAt: string
}

type OrgWorkspace = {
  workspaceId: WorkspaceId
  orgId: OrgId
  createdAt: string
}
```

Workspaces owned by organizations instead of individual users.

## Security Considerations

### OIDC Header Trust

The control plane trusts OIDC headers only when:
- Request comes from trusted reverse proxy
- TLS terminates before reverse proxy
- `OIDC_REVERSE_PROXY=true` when using upstream TLS

**Configuration**:
```bash
# Control plane trusts these headers
X-Remote-User: user@example.com
X-Remote-Email: user@example.com
X-Remote-Display-Name: User Name
```

### Cross-Site Scripting

State-changing actions must use CSRF protection:
```typescript
// Next.js App Router uses same-site cookies by default
// Additional CSRF tokens for sensitive actions
```

### Terminal Access Isolation

Terminal access (WeTTY, ghostty-web) runs as non-root user `agent`:
```bash
incus exec $CONTAINER_NAME -- useradd -m -s /bin/zsh agent
incus exec $CONTAINER_NAME -- systemctl enable wetty@agent
```

Users with terminal access can:
- Read all files in `/workspace`
- Execute commands as `agent` user
- Install global packages as `agent`

Users with terminal access cannot:
- Escalate to root
- Access other containers
- Access host system

## Related Documentation

- [Provisioner Contract](provisioner-contract.md) - Provisioner security boundary
- [Workspace Lifecycle](../workflows/workspace-lifecycle.md) - Workspace states and operations
- [Security](../operations/security.md) - Security model and hardening
- [Contract Specification](../../docs/contracts/multi-tenant-control-plane-v1.md) - Full contract spec
