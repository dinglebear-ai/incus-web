# Provisioner Boundary Contract v1

Date: 2026-07-01
Status: draft contract for implementation
Design source: `docs/superpowers/specs/2026-07-01-provisioner-boundary-v1-design.md`
Bead: `incus-web-cq2`

## Purpose

This contract defines the first narrow boundary between the Next.js control plane and the host provisioner.

The provisioner is the only component in this slice allowed to mutate Incus, ZFS, workspace disk mounts, network ACLs, container profiles, and setup execution. The Next.js app calls product-level commands and never receives Incus host credentials or raw Incus API access.

The first implementation PR may introduce only the Next.js-side contract/client facade and a static prototype status adapter. That facade is not a host security boundary. `CreateWorkspace`, lifecycle mutation, and `RunSetup` routes must remain disabled until a host-local transport, service authentication, metadata revalidation, and redacted operation store are implemented.

## Versioning

Contract version: `provisioner.v1`

Breaking changes require a new contract version. Additive optional fields are allowed when consumers ignore unknown fields.

```ts
type ProvisionerContractVersion = "provisioner.v1"
```

## Transport

V1 transport is host-local only.

Preferred transport:

- Unix domain socket: `/run/incus-web/provisioner.sock`

Allowed fallback:

- `127.0.0.1` HTTP on a configured port

The endpoint must not be exposed through SWAG, Tailscale, public DNS, workspace bridges, or container-local routes.

The first host-local implementation is split across:

- `apps/web/lib/provisioner/host-transport.ts` for the Next.js-side Unix-socket/localhost transport client.
- `scripts/provisioner-server.mjs` for the host-side provisioner service entrypoint.

`deploy.sh` installs the host-side entrypoint as `incus-web-provisioner.service`, runs it as a dedicated `incus-web-provisioner` system user, writes the service env to `/etc/incus-web/provisioner.env`, and uses `/run/incus-web/provisioner.sock` with group access by default. Only the trusted host web-app service user should be added to the provisioner access group.

host-local is the default provisioner mode, but it only becomes active when `INCUS_WEB_PROVISIONER_TOKEN` is configured. Without that token, inventory fails closed with `unauthenticated_service`. `prototype-static` remains a development-only escape hatch and must not be enabled in production.

## Authentication

The control plane authenticates to the provisioner with a service token.

```ts
type ProvisionerServiceAuth = {
  scheme: "bearer"
  token: string
}
```

Rules:

- The service token is not a user token.
- The token does not carry authorization claims.
- The token only proves that the caller is the trusted control-plane service.
- User authorization is resolved by the control plane before a command is sent.
- The provisioner still validates workspace metadata before host mutation.
- `INCUS_WEB_PROVISIONER_TOKEN` must be shared only between the trusted Next.js control plane and the host provisioner service.
- Bearer authentication does not bypass workspace tuple validation.

## Scalar Types

```ts
type RequestId = string
type UserId = string
type WorkspaceId = string
type OperationId = string
type IncusProjectName = string
type IncusContainerName = string
type ResourceProfileId = "local-dev"
```

IDs are opaque strings. Callers must not parse IDs for authorization or routing decisions.

## Actor Context

```ts
type ProvisionerActor = {
  userId: UserId
  oidcSubject: string
  email: string
  displayName?: string
}
```

The provisioner records actor context for audit and log correlation. It does not trust actor context as proof of permission.

## Workspace Reference

```ts
type ProvisionerWorkspaceRef = {
  id: WorkspaceId
  ownerUserId: UserId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
}
```

Provisioner validation requirements:

- `id`, `incusProject`, and `incusContainer` must be non-empty.
- Generated multi-tenant `incusProject` and `incusContainer` values must match generated-name policy.
- The imported prototype workspace may use Incus project `default` and container `incus-web` while it is being adopted into the control plane.
- The tuple must match control-plane workspace metadata.
- The provisioner must reject mismatched tuples with `metadata_mismatch`.

## Command Envelope

```ts
type ProvisionerCommandType =
  | "CreateWorkspace"
  | "StartWorkspace"
  | "StopWorkspace"
  | "RestartWorkspace"
  | "GetWorkspaceStatus"
  | "RunSetup"

type ProvisionerCommand<TPayload> = {
  version: ProvisionerContractVersion
  requestId: RequestId
  type: ProvisionerCommandType
  actor: ProvisionerActor
  workspace: ProvisionerWorkspaceRef
  payload: TPayload
}
```

Every command must include a unique `requestId`. Retrying the same logical request should reuse the same `requestId` when possible.

## Operation Envelope

Commands return operation-shaped responses even when v1 runs synchronously internally.

```ts
type OperationStatus = "queued" | "running" | "succeeded" | "failed"

type ProvisionerOperation<TResult = unknown> = {
  id: OperationId
  requestId: RequestId
  type: ProvisionerCommandType
  workspaceId: WorkspaceId
  status: OperationStatus
  result?: TResult
  error?: ProvisionerError
  startedAt?: string
  completedAt?: string
}
```

Rules:

- `status: "succeeded"` requires a result and no error.
- `status: "failed"` requires an error and no result.
- `status: "queued"` and `status: "running"` include neither result nor error.
- `startedAt` and `completedAt` are ISO-8601 timestamps when known.
- Operation ids are generated by the provisioner.

## Error Envelope

```ts
type ProvisionerErrorCode =
  | "invalid_input"
  | "unauthenticated_service"
  | "metadata_mismatch"
  | "invalid_state"
  | "template_unavailable"
  | "incus_unavailable"
  | "zfs_unavailable"
  | "quota_failed"
  | "setup_failed"
  | "timeout"
  | "operation_failed"
  | "golden_config_failed"

type ProvisionerError = {
  code: ProvisionerErrorCode
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}
```

Raw Incus stderr, raw setup logs, secret material, and host paths must not be returned directly to browser clients. The provisioner may write raw details to host-local logs.

## Workspace State

```ts
type ProvisionerWorkspaceState =
  | "creating"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "restarting"
  | "setting_up"
  | "degraded"
  | "failed"
```

V1 does not expose delete states because delete is not part of the first command set.

## Resource Profile

```ts
type ResourceProfile = {
  id: ResourceProfileId
  cpuLimit: number
  memoryBytes: number
  rootDiskBytes: number
  processLimit: number
  networkPolicy: "default-deny-lan"
}
```

The browser and control plane do not send arbitrary Incus config keys. They refer to a known resource profile.

## Commands

### CreateWorkspace

```ts
type CreateWorkspacePayload = {
  templateVersion: string
  resourceProfileId: ResourceProfileId
  autoStart: boolean
}

type CreateWorkspaceResult = {
  workspaceId: WorkspaceId
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  state: "stopped" | "running"
  templateVersion: string
  resourceProfileId: ResourceProfileId
}

type CreateWorkspaceCommand = ProvisionerCommand<CreateWorkspacePayload>
type CreateWorkspaceOperation = ProvisionerOperation<CreateWorkspaceResult>
```

Provisioner requirements:

- Ensure the target Incus project exists.
- Create from the configured template snapshot when `templateMode: "snapshot"`.
- Create from the current image alias only when `templateMode: "image-alias"`.
- Fail closed when snapshot mode is selected but the template is unavailable.
- Apply the committed `incus-web-agent` profile.
- Apply resource limits from the named profile.
- Attach managed network and LAN-blocking ACL.
- Attach workspace disk mount using shifted mounts by default.
- Write workspace identity metadata.
- Start the container only when `autoStart` is true.
- Reject existing unexpected containers with `metadata_mismatch` or `invalid_state`.

### StartWorkspace

```ts
type StartWorkspacePayload = Record<string, never>

type StartWorkspaceResult = {
  workspaceId: WorkspaceId
  state: "running"
  status: WorkspaceRuntimeStatus
}

type StartWorkspaceCommand = ProvisionerCommand<StartWorkspacePayload>
type StartWorkspaceOperation = ProvisionerOperation<StartWorkspaceResult>
```

Allowed prior states:

- `stopped`
- `degraded`

### StopWorkspace

```ts
type StopWorkspacePayload = {
  force: boolean
  timeoutSeconds: number
}

type StopWorkspaceResult = {
  workspaceId: WorkspaceId
  state: "stopped"
}

type StopWorkspaceCommand = ProvisionerCommand<StopWorkspacePayload>
type StopWorkspaceOperation = ProvisionerOperation<StopWorkspaceResult>
```

Allowed prior states:

- `running`
- `degraded`
- `failed`

### RestartWorkspace

```ts
type RestartWorkspacePayload = {
  timeoutSeconds: number
}

type RestartWorkspaceResult = {
  workspaceId: WorkspaceId
  state: "running"
  status: WorkspaceRuntimeStatus
}

type RestartWorkspaceCommand = ProvisionerCommand<RestartWorkspacePayload>
type RestartWorkspaceOperation = ProvisionerOperation<RestartWorkspaceResult>
```

The implementation may compose stop and start internally.

### GetWorkspaceStatus

```ts
type WorkspaceRuntimeStatus = {
  workspaceId: WorkspaceId
  state: ProvisionerWorkspaceState
  incusProject: IncusProjectName
  incusContainer: IncusContainerName
  cpuCount?: number
  memoryUsedBytes?: number
  memoryLimitBytes?: number
  rootDiskUsedBytes?: number
  rootDiskLimitBytes?: number
  loadAverage?: [number, number, number]
  setupPhase?: string
  lastCheckedAt: string
}

type GetWorkspaceStatusPayload = Record<string, never>
type GetWorkspaceStatusResult = WorkspaceRuntimeStatus
type GetWorkspaceStatusCommand = ProvisionerCommand<GetWorkspaceStatusPayload>
type GetWorkspaceStatusOperation = ProvisionerOperation<GetWorkspaceStatusResult>
```

Status calls must not mutate workspace lifecycle state except for safe health-derived degradation metadata recorded by the control plane.

### RunSetup

```ts
type RunSetupPayload = {
  dotfilesRepo?: string
  ageKey?: {
    value: string
    persistEncrypted: boolean
  }
  skipAptScripts: boolean
}

type SetupCheckStatus = "ok" | "warn" | "missing" | "unknown"

type ProvisionerSetupPhase =
  | "not_configured"
  | "queued"
  | "installing_mise"
  | "applying_dotfiles"
  | "checking_tools"
  | "ready"
  | "failed"

type SetupSummary = {
  phase: ProvisionerSetupPhase
  dotfilesRepo?: string
  dotfilesStatus: SetupCheckStatus
  miseStatus: SetupCheckStatus
  commandStatus: SetupCheckStatus
  packageStatus: SetupCheckStatus
  lastLogExcerpt?: string
  updatedAt: string
}

type RunSetupResult = {
  workspaceId: WorkspaceId
  setup: SetupSummary
}

type RunSetupCommand = ProvisionerCommand<RunSetupPayload>
type RunSetupOperation = ProvisionerOperation<RunSetupResult>
```

Provisioner requirements:

- Validate dotfiles repo URL form and length.
- Validate age identity material before writing it.
- Deny `persistEncrypted` unless host policy enables key persistence.
- Run setup only in the target workspace container.
- Run user-level setup as the workspace Linux user.
- Bound `lastLogExcerpt`.
- Remove raw age key material after use.

### ImportGoldenConfig

Seeds a workspace's `~/.claude` and `~/.codex` from a "golden config" zip
previously exported with `scripts/export-onboarding.mjs` (settings, MCP
config, skills, agents, plugin registrations, `CLAUDE.md`/`AGENTS.md`,
memories — never a full recursive dump; see that script for the exact
include list). This is one of the two `MUTATING_COMMAND_TYPES` entries and
routes through `getMutableWorkspaceRefForActor`.

```ts
type ImportGoldenConfigPayload = {
  sha256Hex: string // 64-char hex sha256 digest of the staged upload
}

type ImportGoldenConfigResult = {
  workspaceId: WorkspaceId
  extractedAt: string
  fileCount: number
  warnings: string[] // best-effort, read from the zip's own manifest.json
}

type ImportGoldenConfigCommand = ProvisionerCommand<ImportGoldenConfigPayload>
type ImportGoldenConfigOperation = ProvisionerOperation<ImportGoldenConfigResult>
```

The payload never carries a file path. The upload flow is:

1. `POST /api/workspaces/:workspaceId/golden-config` (in `apps/web`) accepts
   the raw zip body, validates its content-type and zip magic bytes, and
   streams it to disk at `${INCUS_WEB_GOLDEN_CONFIG_DIR}/<workspaceId>.zip`
   (a directory shared between the web app and provisioner system users via
   `INCUS_WEB_PROVISIONER_GROUP`, mode `2770` — see
   `ensure_golden_config_staging_dir` in `scripts/incus-web-lib.sh`).
2. The route computes the upload's sha256 and sends `ImportGoldenConfig`
   with only that hash.
3. `scripts/provisioner-server.mjs` derives the staged path itself from the
   already-authenticated workspace tuple, re-reads the file, verifies the
   hash matches, `incus file push`es it into the container, and runs a
   single `incus exec` script that unzips it, merges `claude/` and `codex/`
   into `/home/<workspace user>/.claude` and `.codex` (`cp -a` over the
   top, not a wipe-and-replace, so container-local state the export never
   captured is preserved), `chown`s the result to the workspace user, and
   cleans up its own temp files.

Provisioner requirements:

- Validate `sha256Hex` independently of the web app (64-char hex).
- Re-verify the staged file's hash before pushing it into the container —
  never trust that the file on disk still matches what the caller declared.
- Reject uploads over `INCUS_WEB_GOLDEN_CONFIG_MAX_BYTES`.
- Fail with `golden_config_failed` (not a generic incus error) when `unzip`
  is missing from the container image.
- Cap `warnings` length and per-entry length like every other bounded
  result array in this contract.

## Validation Rules

### Generated Names

The control plane generates Incus names. V1 generated names should be deterministic and non-secret:

```ts
type GeneratedNames = {
  incusProject: `user-${string}`
  incusContainer: `ws-${string}`
}
```

RunSetup ageKey accepts only value and persistEncrypted. Extra nested fields are rejected before redaction so callers cannot smuggle unredacted key material.

WorkspaceRuntimeStatus metrics must be finite, non-negative numbers. `loadAverage`, when present, must be exactly three finite, non-negative numbers.

The provisioner must still validate the actual strings at runtime:

- lowercase letters, numbers, and hyphens only
- no leading or trailing hyphen
- no path separators
- max length compatible with Incus

### Setup Input

- `dotfilesRepo` max length: 512 characters.
- hosted default supported repo forms: `https://github.com/<owner>/<repo>` or `https://github.com/<owner>/<repo>.git`
- `ssh://...`, `git@host:owner/repo.git`, GitHub shorthand, and non-GitHub hosts require an explicit host policy before use.
- dotfiles are executable code inside the same personal workspace trust boundary; they are not safe for collaborators who do not explicitly trust the workspace owner.
- `ageKey.value` max length: 200000 characters
- `ageKey.value` must contain valid line-oriented age identity material.
- `ageKey.persistEncrypted=true` must be rejected unless host policy explicitly enables encrypted-at-rest key persistence.

### Timeouts

- lifecycle command default timeout: 180 seconds
- setup command default timeout: 1200 seconds
- callers may request shorter timeouts
- callers may not request longer timeouts unless host policy allows it

## Security Rules

- Hosted workspaces remain `security.privileged=false`.
- Hosted workspaces keep `security.nesting=true`.
- Shifted workspace disk mounts are the runtime default.
- CI may set unshifted disposable mounts only for runner compatibility.
- The provisioner never accepts arbitrary shell snippets.
- The provisioner never trusts browser-supplied Incus names without metadata validation.
- Secret-bearing fields must be redacted from logs and operation records.
- Browser-facing setup excerpts must be allowlisted summaries or redacted excerpts. Raw Incus stderr, host paths, bearer tokens, age key material, and full setup output remain host-local only.

## Audit Requirements

The control plane records product audit events. The provisioner records host audit logs.

Provisioner log fields:

- operation id
- request id
- command type
- workspace id
- Incus project/container
- actor user id and email
- start/end timestamps
- final status
- stable error code when failed

Do not log raw age keys, service tokens, or full setup output.

## Contract Tests

The implementation must include tests that prove:

- all commands reject unknown `version`
- all commands reject unknown `type`
- malformed workspace refs fail validation
- mismatched project/container tuples fail with `metadata_mismatch`
- raw Incus config keys are not accepted in payloads
- setup secret fields are redacted in errors/log excerpts
- `RunSetup ageKey accepts only value and persistEncrypted`
- `WorkspaceRuntimeStatus metrics must be finite, non-negative numbers`
- `status: "succeeded" requires a result and no error`
- `status: "failed" requires an error and no result`
- status operations validate `workspaceId`, `incusProject`, and `incusContainer` against the requested workspace tuple before rendering
- production owner gating requires stable OIDC subject configuration; email fallback is only for local prototype/development mode
- `CreateWorkspace` and `RunSetup` return operation envelopes
- status results fit `WorkspaceRuntimeStatus`

## Compatibility With Current Prototype

The true host provisioner implementation can wrap existing shell helpers:

- `scripts/incus-web-lib.sh` for network/profile/common behavior
- image/profile conventions from `distrobuilder.yaml` and `incus-web-profile.yaml`
- current setup behavior from the container-local setup server
- imported prototype defaults from `.env.example`: `workspace-incus-web`, `default`, and `incus-web`

This compatibility is an implementation detail. The web app consumes only this contract. Static prototype status mode must be explicitly configured and must not be treated as a real host-local provisioner.

The first host service may call the `incus` CLI as a bounded adapter while the Incus REST client is being developed, but only behind the provisioner service. Next.js request handlers must continue to call the provisioner contract, not `incus`, shell commands, or raw Incus endpoints.

## Implementation Entry Points

The first TypeScript implementation lives in:

- `apps/web/lib/provisioner/contracts.ts` for contract types and validators
- `apps/web/lib/provisioner/client.ts` for the provisioner client interface
- `apps/web/lib/provisioner/host-transport.ts` for the host-local transport client
- `apps/web/lib/provisioner/status-adapter.ts` for mapping v1 status into workspace dashboard data
- `scripts/provisioner-server.mjs` for the initial host provisioner service

Future host transports must preserve these interfaces so the Next.js workspace inventory does not learn raw Incus details.

## Acceptance Criteria

- A developer can implement Zod schemas directly from this document.
- The first implementation slice can be planned without consulting raw Incus docs.
- Next.js remains outside the host mutation boundary.
- The provisioner command set is limited to create, lifecycle, status, and setup.
- Security expectations for unprivileged hosted containers and setup secrets are explicit.
