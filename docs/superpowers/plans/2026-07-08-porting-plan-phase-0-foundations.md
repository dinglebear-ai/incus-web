# Porting Plan Phase 0: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the two real prerequisites `PORTING_PLAN.md` §7 Phase 0 calls for — a mutating-command authorization gate that's actually wired into the one dispatch chokepoint every command goes through, and a hardened, shared bearer-token verification primitive Phase 2's build worker will use — before any Phase 1/2 work (importers, `SetWorkspaceLimits`, the image builder) touches either.

**Architecture:** `getMutableWorkspaceRefForActor` composes with the existing `getWorkspaceRefForActor` (never duplicates its owner-resolution logic) and layers one additional shared-prototype-mode gate on top. `sendWorkspaceCommand` — the single function every existing and future command already dispatches through — now checks a `MUTATING_COMMAND_TYPES` registry and routes through the mutation gate automatically when a command type is registered as mutating. This means a future `SetWorkspaceLimits` handler cannot accidentally bypass the gate by following the codebase's existing dispatch pattern (the previous design of this plan had that exact gap); registering the type is the only step required, and a test proves the routing works today using an existing command type as a stand-in. The bearer-token work is extracted into a shared, timing-safe `scripts/service-auth.mjs` module and backported into the existing provisioner (closing a pre-existing timing side-channel) rather than being built into a new, uncalled HTTP service — Phase 2 imports this same module when it stands up the real build worker with real handlers.

**Tech Stack:** TypeScript (Next.js app, vitest) for Task 1; plain Node.js (`node:crypto`, zero framework, matching `scripts/provisioner-server.mjs`'s existing style) for Task 2.

## Global Constraints

- No new runtime dependencies.
- Every new env var is documented in `.env.example` in the same section style as existing `INCUS_WEB_*` vars. (This plan adds none — see Task 2's scope note.)
- Every new exported function gets a corresponding test file — this repo has 100% test coverage on the provisioner boundary (`apps/web/lib/workspaces/provisioner.test.ts` has 25+ cases) and Phase 0 must not regress that convention.
- `vi.stubEnv` + `vi.unstubAllEnvs()` in `afterEach` is this repo's established pattern for env-dependent tests (see `apps/web/lib/workspaces/provisioner.test.ts:1,59-61`) — use it, don't invent a new mocking approach.
- Cross-module tests for `scripts/*.mjs` files live under `apps/web/lib/provisioner/*.test.ts` and import the script by relative path — this repo has no root `package.json`/test runner; `apps/web` is the only vitest project (established precedent: `apps/web/lib/provisioner/agent-runs-host.test.ts:18` imports `../../../../scripts/agent-runs.mjs`).

---

### Task 1: Mutation-authorization gate, wired into dispatch

**Files:**
- Modify: `apps/web/lib/provisioner/contracts.ts:78-91` (add `"mutation_not_authorized"` to the `ProvisionerErrorCode` union), `:1126-1140` (add it to the `isProvisionerErrorCode` runtime guard).
- Modify: `apps/web/lib/provisioner/contracts.test.ts` (add a case for the new error code round-tripping through `isProvisionerError`).
- Modify: `apps/web/lib/workspaces/provisioner.ts:62-67` (add `getMutableWorkspaceRefForActor` after `ownerForActor`), `:206-228` (`sendWorkspaceCommand` routes through it when the command type is registered as mutating).
- Test: `apps/web/lib/workspaces/provisioner.test.ts` (append new `describe` block).
- Modify: `.env.example` (document `INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION` next to the existing `INCUS_WEB_ALLOW_SHARED_PROTOTYPE` entry).

**Interfaces:**
- Consumes: `ActorContext` (`@/lib/workspaces/types`), `ProvisionerError`/`ProvisionerErrorCode`/`ProvisionerCommandType` (`@/lib/provisioner/contracts`), the existing unexported `configuredOwner()`/`actorMatchesOwner()` helpers (via `getWorkspaceRefForActor`, not directly — see Step 3 rationale).
- Produces: `export const MUTATING_COMMAND_TYPES: Set<ProvisionerCommandType>` (empty today — Phase 1 adds `"SetWorkspaceLimits"` to it as a one-line change once that command type exists in `PROVISIONER_COMMAND_TYPES`). `export function getMutableWorkspaceRefForActor(actor: ActorContext): { ok: true; workspace: ProvisionerWorkspaceRef } | { ok: false; error: ProvisionerError }` — later Phase 1 work doesn't need to call this directly; registering a type in `MUTATING_COMMAND_TYPES` is sufficient, `sendWorkspaceCommand` calls it automatically.

- [ ] **Step 1: Write the failing tests for the new error code**

Append to `apps/web/lib/provisioner/contracts.test.ts`, in the same style as the existing `isProvisionerError`/error-code round-trip cases already in that file:

```typescript
it("accepts mutation_not_authorized as a valid provisioner error code", () => {
  const error: ProvisionerError = {
    code: "mutation_not_authorized",
    message: "shared prototype mode does not allow workspace config mutation by default",
    retryable: false,
  };
  const operation: ProvisionerOperation<"GetWorkspaceStatus"> = {
    id: "op-1",
    requestId: "req-1",
    type: "GetWorkspaceStatus",
    workspaceId: "workspace-1",
    status: "failed",
    error,
  };
  const validated = validateProvisionerOperation(
    operation,
    {
      id: "workspace-1",
      ownerUserId: "user-1",
      incusProject: "user-abc123",
      incusContainer: "ws-def456",
    },
    "GetWorkspaceStatus",
  );
  expect(validated).toMatchObject({ ok: true, value: { error } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npm run test -- --run contracts.test.ts`
Expected: FAIL — TypeScript error, `"mutation_not_authorized"` is not assignable to `ProvisionerErrorCode`.

- [ ] **Step 3: Add the error code to the contract**

In `apps/web/lib/provisioner/contracts.ts`, extend the union at lines 78-91:

```typescript
export type ProvisionerErrorCode =
  | "invalid_input"
  | "unauthenticated_service"
  | "mutation_not_authorized"
  | "metadata_mismatch"
  | "invalid_state"
  | "template_unavailable"
  | "incus_unavailable"
  | "zfs_unavailable"
  | "quota_failed"
  | "setup_failed"
  | "missing_controller_config"
  | "not_implemented"
  | "timeout"
  | "operation_failed";
```

And extend the runtime guard at `isProvisionerErrorCode` (currently lines 1126-1140):

```typescript
function isProvisionerErrorCode(value: unknown): value is ProvisionerErrorCode {
  return (
    value === "invalid_input" ||
    value === "unauthenticated_service" ||
    value === "mutation_not_authorized" ||
    value === "metadata_mismatch" ||
    value === "invalid_state" ||
    value === "template_unavailable" ||
    value === "incus_unavailable" ||
    value === "zfs_unavailable" ||
    value === "quota_failed" ||
    value === "setup_failed" ||
    value === "missing_controller_config" ||
    value === "not_implemented" ||
    value === "timeout" ||
    value === "operation_failed"
  );
}
```

This is a distinct code from `unauthenticated_service` deliberately (per the security review) — an operator grepping logs later needs to distinguish "not the owner at all" from "owner, but shared-mode mutation isn't opted into" for incident response.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npm run test -- --run contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for the mutation gate**

Append to `apps/web/lib/workspaces/provisioner.test.ts`, inside the existing `describe("workspace inventory provisioner", ...)` block, after the last existing `it(...)` (line 698):

```typescript
  it("allows the single configured owner to obtain a mutable workspace ref", () => {
    useOwnerEmail();
    const actor = ownerActor();

    expect(getMutableWorkspaceRefForActor(actor)).toMatchObject({
      ok: true,
      workspace: { id: "workspace-incus-web" },
    });
  });

  it("denies a mutable workspace ref for a non-owner", () => {
    useOwnerEmail();
    const actor = getActorFromHeaders(
      authHeaders({ email: "other@example.com", subject: null }),
    );

    expect(getMutableWorkspaceRefForActor(actor)).toMatchObject({
      ok: false,
      error: { code: "unauthenticated_service" },
    });
  });

  it("denies a mutable workspace ref in shared-prototype mode by default", () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "authenticated");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_PROTOTYPE", "1");
    const actor = getActorFromHeaders(
      authHeaders({ email: "jacob@example.com", subject: "jacob" }),
    );

    expect(getMutableWorkspaceRefForActor(actor)).toMatchObject({
      ok: false,
      error: {
        code: "mutation_not_authorized",
        message:
          "shared prototype mode does not allow workspace config mutation by default",
      },
    });
  });

  it("allows a mutable workspace ref in shared-prototype mode with the explicit second opt-in", () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "authenticated");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_PROTOTYPE", "1");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION", "1");
    const actor = getActorFromHeaders(
      authHeaders({ email: "jacob@example.com", subject: "jacob" }),
    );

    expect(getMutableWorkspaceRefForActor(actor)).toMatchObject({ ok: true });
  });

  it("denies a mutable workspace ref when no owner is configured at all", () => {
    const actor = ownerActor();

    expect(getMutableWorkspaceRefForActor(actor)).toMatchObject({
      ok: false,
      error: { code: "unauthenticated_service" },
    });
  });

  it("routes commands registered as mutating through the mutation gate, not the plain owner check", async () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "authenticated");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_PROTOTYPE", "1");
    const actor = getActorFromHeaders(
      authHeaders({ email: "jacob@example.com", subject: "jacob" }),
    );
    const client = { send: vi.fn() };

    // No mutating command type exists in the real contract yet (Phase 1 adds
    // one). Prove the routing mechanism itself works today by temporarily
    // registering an existing, harmless command type as mutating — this is
    // exactly the mechanism Phase 1 will rely on by adding "SetWorkspaceLimits"
    // to MUTATING_COMMAND_TYPES as its only wiring step.
    MUTATING_COMMAND_TYPES.add("StopWorkspace");
    try {
      const operation = await sendWorkspaceCommand(
        actor,
        "StopWorkspace",
        { force: false, timeoutSeconds: 30 },
        client,
      );

      expect(client.send).not.toHaveBeenCalled();
      expect(operation).toMatchObject({
        type: "StopWorkspace",
        status: "failed",
        error: { code: "mutation_not_authorized" },
      });
    } finally {
      MUTATING_COMMAND_TYPES.delete("StopWorkspace");
    }
  });

  it("does not route non-mutating commands through the mutation gate", async () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "authenticated");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_PROTOTYPE", "1");
    const actor = getActorFromHeaders(
      authHeaders({ email: "jacob@example.com", subject: "jacob" }),
    );
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-1",
        requestId: actor.requestId,
        type: "StopWorkspace",
        workspaceId: "workspace-jacob",
        status: "succeeded",
        result: {
          workspaceId: "workspace-jacob",
          state: "stopped",
          status: {
            workspaceId: "workspace-jacob",
            state: "stopped",
            incusProject: "default",
            incusContainer: "incus-web",
            lastCheckedAt: "2026-07-08T00:00:00.000Z",
          },
        },
      }),
    };

    // StopWorkspace is not registered as mutating today, so shared-mode's
    // existing lifecycle behavior (any authenticated actor may start/stop
    // their own prototype workspace) must be unaffected by this change.
    const operation = await sendWorkspaceCommand(
      actor,
      "StopWorkspace",
      { force: false, timeoutSeconds: 30 },
      client,
    );

    expect(client.send).toHaveBeenCalled();
    expect(operation.status).toBe("succeeded");
  });
```

Add `getMutableWorkspaceRefForActor` and `MUTATING_COMMAND_TYPES` to the existing import block at the top of the file (`apps/web/lib/workspaces/provisioner.test.ts:13-17`):

```typescript
import {
  getMutableWorkspaceRefForActor,
  getWorkspaceRefForActor,
  getWorkspaceInventory,
  MUTATING_COMMAND_TYPES,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd apps/web && npm run test -- --run provisioner.test.ts`
Expected: FAIL — `getMutableWorkspaceRefForActor`/`MUTATING_COMMAND_TYPES` are not exported yet.

- [ ] **Step 7: Implement `getMutableWorkspaceRefForActor` and wire `sendWorkspaceCommand`**

In `apps/web/lib/workspaces/provisioner.ts`, add this immediately after `getWorkspaceRefForActor` (currently ending at line 204), before `sendWorkspaceCommand`:

```typescript
export const MUTATING_COMMAND_TYPES = new Set<ProvisionerCommandType>();

export function getMutableWorkspaceRefForActor(
  actor: ActorContext,
): { ok: true; workspace: ProvisionerWorkspaceRef } | { ok: false; error: ProvisionerError } {
  const access = getWorkspaceRefForActor(actor);
  if (!access.ok) {
    return access;
  }

  const ownerMode = process.env.INCUS_WEB_WORKSPACE_OWNER_MODE ?? "none";
  if (ownerMode === "authenticated" && process.env.INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION !== "1") {
    return {
      ok: false,
      error: {
        code: "mutation_not_authorized",
        message:
          "shared prototype mode does not allow workspace config mutation by default",
        retryable: false,
      },
    };
  }

  return access;
}
```

This deliberately calls `getWorkspaceRefForActor` — the same function every other read/lifecycle path already goes through — rather than re-deriving owner state from `configuredOwner`/`actorMatchesOwner` directly. There is exactly one place that decides "is this actor the owner"; this function only adds the *new* shared-mode mutation gate on top of that single source of truth.

Then modify `sendWorkspaceCommand` (currently lines 206-228) to route through it:

```typescript
export async function sendWorkspaceCommand<TType extends ProvisionerCommandType>(
  actor: ActorContext,
  type: TType,
  payload: ProvisionerCommand<TType>["payload"],
  client?: ProvisionerClient,
): Promise<ProvisionerOperation<TType>> {
  const access = MUTATING_COMMAND_TYPES.has(type)
    ? getMutableWorkspaceRefForActor(actor)
    : getWorkspaceRefForActor(actor);
  if (!access.ok) {
    return failedCommandOperation(actor, type, "unknown", access.error);
  }

  const command = {
    ...commandFor(type, actor, access.workspace.ownerUserId, payload),
    workspace: access.workspace,
  };
  const provisioner = client ?? defaultProvisionerClient(access.workspace.ownerUserId);
  const operation = await provisioner.send(command);
  const validated = validateProvisionerOperation(operation, command.workspace, type);
  if (!validated.ok) {
    return failedCommandOperation(actor, type, command.workspace.id, validated.error);
  }
  return validated.value;
}
```

The only change from the existing implementation is the first line of the function body — `access` now comes from whichever gate applies, based on the command's registered mutation status. Every existing caller (`StartWorkspace`, `StopWorkspace`, `RestartWorkspace`, `DispatchAgentRun`, etc.) is unaffected today because `MUTATING_COMMAND_TYPES` starts empty; Phase 1 opts `SetWorkspaceLimits` into the stricter gate with one line, not a new call site to remember.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/web && npm run test -- --run provisioner.test.ts`
Expected: PASS — all 7 new cases plus the existing 25+ cases in this file.

- [ ] **Step 9: Document the new env var**

In `.env.example`, immediately after the existing `INCUS_WEB_ALLOW_SHARED_PROTOTYPE=0` line, add:

```bash
# When INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated (shared prototype mode),
# every authenticated actor is treated as the owner of the shared workspace
# for read/lifecycle (start/stop/restart) purposes. Mutating workspace
# configuration (resource limits, mounts — commands registered in
# MUTATING_COMMAND_TYPES, apps/web/lib/workspaces/provisioner.ts) requires
# this SECOND, separate opt-in. Leave unset/0 in shared mode unless every
# actor with access is trusted to change container resource limits or mounts.
INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION=0
```

- [ ] **Step 10: Run the full test suite and lint**

Run: `cd apps/web && npm run test -- --run && npm run lint`
Expected: all tests pass (91 existing + 8 new = 99), lint reports 0 errors (pre-existing warnings unchanged).

- [ ] **Step 11: Commit**

```bash
git add apps/web/lib/provisioner/contracts.ts apps/web/lib/provisioner/contracts.test.ts apps/web/lib/workspaces/provisioner.ts apps/web/lib/workspaces/provisioner.test.ts .env.example
git commit -m "feat(web): wire a mutation-authorization gate into command dispatch"
```

---

### Task 2: Shared, timing-safe bearer-token verification

**Files:**
- Create: `scripts/service-auth.mjs`
- Test: `apps/web/lib/provisioner/service-auth.test.ts` (cross-module test importing the script by relative path, matching the `agent-runs-host.test.ts` precedent).
- Modify: `scripts/provisioner-server.mjs:13,66-69,143-153` (backport: use the shared, hardened primitive instead of the inline `!==`/`if (!token)` checks).

**Interfaces:**
- Consumes: nothing new — `node:crypto`'s `timingSafeEqual` is a Node builtin, no new dependency.
- Produces: `export function verifyBearerToken(authorizationHeader: string | undefined, expectedToken: string): boolean` and `export function requireConfiguredToken(token: string | undefined, envVarName: string): string` (throws `Error` if empty/whitespace-only — callers decide how to fail, e.g. `console.error` + `process.exit(1)` at startup, matching the existing convention). Phase 2's build worker imports both from `scripts/service-auth.mjs` directly when it stands up real handlers — no service, port, or new env var exists yet to import them into, so this task stops at the shared primitive plus the backport, per the simplicity review's finding that a standalone echo-only service is unjustified scaffolding with no caller.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/lib/provisioner/service-auth.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  requireConfiguredToken,
  verifyBearerToken,
} from "../../../../scripts/service-auth.mjs";

describe("service-auth", () => {
  describe("verifyBearerToken", () => {
    it("accepts a correctly formatted matching token", () => {
      expect(verifyBearerToken("Bearer secret-token", "secret-token")).toBe(true);
    });

    it("rejects a mismatched token of the same length", () => {
      expect(verifyBearerToken("Bearer wrong-tokennn", "secret-token")).toBe(false);
    });

    it("rejects a mismatched token of a different length", () => {
      expect(verifyBearerToken("Bearer short", "secret-token")).toBe(false);
    });

    it("rejects a missing authorization header", () => {
      expect(verifyBearerToken(undefined, "secret-token")).toBe(false);
    });

    it("rejects a header missing the Bearer prefix", () => {
      expect(verifyBearerToken("secret-token", "secret-token")).toBe(false);
    });

    it("throws if the expected token is empty", () => {
      expect(() => verifyBearerToken("Bearer x", "")).toThrow(
        "expected token must not be empty",
      );
    });
  });

  describe("requireConfiguredToken", () => {
    it("returns the trimmed token when present", () => {
      expect(requireConfiguredToken("  secret-token  \n", "TEST_TOKEN")).toBe(
        "secret-token",
      );
    });

    it("throws a descriptive error when unset", () => {
      expect(() => requireConfiguredToken(undefined, "TEST_TOKEN")).toThrow(
        "TEST_TOKEN is required",
      );
    });

    it("throws a descriptive error when empty", () => {
      expect(() => requireConfiguredToken("", "TEST_TOKEN")).toThrow(
        "TEST_TOKEN is required",
      );
    });

    it("throws a descriptive error when whitespace-only", () => {
      expect(() => requireConfiguredToken("   ", "TEST_TOKEN")).toThrow(
        "TEST_TOKEN is required",
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npm run test -- --run service-auth.test.ts`
Expected: FAIL — `Cannot find module '../../../../scripts/service-auth.mjs'`.

- [ ] **Step 3: Implement `scripts/service-auth.mjs`**

```javascript
import { timingSafeEqual } from "node:crypto";

export function verifyBearerToken(authorizationHeader, expectedToken) {
  const expected = (expectedToken || "").trim();
  if (!expected) {
    throw new Error("expected token must not be empty");
  }

  const provided = typeof authorizationHeader === "string" ? authorizationHeader : "";
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(`Bearer ${expected}`, "utf8");

  if (providedBuffer.length !== expectedBuffer.length) {
    // Compare against a same-length dummy so a length mismatch doesn't
    // short-circuit in meaningfully less time than a same-length wrong
    // token would take to reject via timingSafeEqual below.
    timingSafeEqual(providedBuffer, providedBuffer);
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function requireConfiguredToken(token, envVarName) {
  const trimmed = (token || "").trim();
  if (!trimmed) {
    throw new Error(`${envVarName} is required`);
  }
  return trimmed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npm run test -- --run service-auth.test.ts`
Expected: PASS — all 10 cases.

- [ ] **Step 5: Backport into the existing provisioner**

In `scripts/provisioner-server.mjs`, add the import near the top (after the existing `agent-runs.mjs` import block, currently ending at line 11):

```javascript
import { requireConfiguredToken, verifyBearerToken } from "./service-auth.mjs";
```

Replace the token-loading line (currently line 13):

```javascript
// before:
const token = (process.env.INCUS_WEB_PROVISIONER_TOKEN || "").trim();
// after:
let token;
try {
  token = requireConfiguredToken(
    process.env.INCUS_WEB_PROVISIONER_TOKEN,
    "INCUS_WEB_PROVISIONER_TOKEN",
  );
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
```

And remove the now-redundant check at lines 66-69 (`if (!token) { console.error(...); process.exit(1); }`) — `requireConfiguredToken` already enforces this, so keeping both would be dead code.

Replace `requireServiceAuth` (currently lines 143-153):

```javascript
function requireServiceAuth(req, res) {
  if (verifyBearerToken(req.headers.authorization, token)) {
    return true;
  }
  send(res, 401, {
    code: "unauthenticated_service",
    message: "invalid provisioner service token",
    retryable: false,
  });
  return false;
}
```

- [ ] **Step 6: Run the provisioner's own tests and full suite**

Run: `cd apps/web && npm run test -- --run && npm run lint`
Expected: all tests pass (99 from Task 1 + 10 new = 109), lint reports 0 errors.

- [ ] **Step 7: Manual smoke test of the backported provisioner**

Run: `INCUS_WEB_PROVISIONER_TOKEN=smoke-test-token node scripts/provisioner-server.mjs &` then, in another shell:
```bash
curl -s -o /dev/null -w '%{http_code}\n' --unix-socket /run/incus-web/provisioner.sock \
  -X POST http://localhost/v1/operations -H 'Authorization: Bearer wrong' -d '{}'
```
Expected: `401` (confirms the backported `verifyBearerToken` still rejects bad tokens end-to-end, not just in isolation). Kill the background process afterward (`kill %1`).

- [ ] **Step 8: Commit**

```bash
git add scripts/service-auth.mjs apps/web/lib/provisioner/service-auth.test.ts scripts/provisioner-server.mjs
git commit -m "feat(provisioner): extract and harden shared bearer-token verification"
```

---

## Self-Review

**1. Spec coverage against `PORTING_PLAN.md` §7 Phase 0, as revised by this session's engineering review:**
- "Design `actorCanMutateWorkspaceConfig`" → superseded by Task 1's `getMutableWorkspaceRefForActor` + `MUTATING_COMMAND_TYPES` wiring, per the security review's Finding 1 (the original design was never called from anywhere, so it didn't actually close the gap it claimed to). Covered, and covered more strictly than originally specified.
- "Stand up the build-worker service skeleton" → superseded by Task 2's shared `service-auth.mjs` extraction, per the simplicity review (a full standalone service with no caller is premature scaffolding) and the security/performance reviews' fixes (timing-safe comparison, fail-closed startup, no unbounded body-read code introduced because there's no HTTP server yet to have that bug). The isolation-boundary *intent* is preserved: Phase 2's real build worker imports this same hardened module rather than reinventing bearer-auth from scratch, and inherits the timing-safe fix by construction instead of by reminder.
- The `statusCache`/`Map` item remains correctly excluded (see the original plan's Self-Review — confirmed against real code, not applicable to the current single-container-per-process architecture).

**2. Placeholder scan:** No TBD/TODO markers. Every step has real, complete code, verified against the actual current contents of `contracts.ts`, `provisioner.ts`, and `provisioner-server.mjs` (not invented). Task 2's `/v1/echo` placeholder from the prior revision is removed entirely rather than left as an unexplained stub.

**3. Type consistency:** `getMutableWorkspaceRefForActor` returns the exact same `{ ok: true; workspace: ProvisionerWorkspaceRef } | { ok: false; error: ProvisionerError }` shape as `getWorkspaceRefForActor` (by construction — it returns `access` directly on the happy path). `verifyBearerToken`/`requireConfiguredToken` signatures are the ones Phase 2 will import unchanged; no breaking signature change anticipated since both are pure functions with no hidden state.

**4. Review-finding traceability** (so nothing raised in this session's four-agent review silently didn't make it into the plan):
- Architecture Finding 1 (drift risk from a parallel auth decision path) → fixed by composing through `getWorkspaceRefForActor` instead of re-deriving owner state.
- Architecture Finding 2 (aspirational isolation claim) → resolved by not claiming a service is isolated when no service exists; the README-overclaim risk is moot.
- Simplicity's core recommendation (cut the standalone service) → adopted; Task 2 is now a shared module + backport, not a service.
- Security Finding 1 (HIGH — gate not enforced by construction) → fixed via `MUTATING_COMMAND_TYPES` + `sendWorkspaceCommand` routing, proven by the "routes commands registered as mutating" test.
- Security Finding 2 (error code collision) → fixed with the new `mutation_not_authorized` code.
- Security Finding 4 (timing-unsafe comparison) → fixed via `timingSafeEqual`, and backported into the existing provisioner rather than left to propagate.
- Security Finding 5 (unproven fail-closed startup) → fixed via `requireConfiguredToken`, independently unit-tested (4 cases) rather than only asserted in prose.
- Performance Finding 1 (unbounded body accumulation) → moot; no HTTP body-reading code is introduced in this plan. Noted as a Phase 2 requirement, not fixed here since there's nothing to fix yet.
- Performance Findings 2-3 (concurrency limiting, seeked log-tail reads) → correctly out of scope for Phase 0; flagged for the Phase 2 plan when it's written.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-08-porting-plan-phase-0-foundations.md`.
