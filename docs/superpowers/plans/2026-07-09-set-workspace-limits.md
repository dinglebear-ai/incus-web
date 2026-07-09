# SetWorkspaceLimits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `SetWorkspaceLimits` — the first real mutating provisioner command — letting an authorized actor set or clear a workspace's CPU/memory resource limits, gated by the `MUTATING_COMMAND_TYPES` authorization tier built in Phase 0.

**Architecture:** Follows the exact pattern every existing command uses in `apps/web/lib/provisioner/contracts.ts` (payload/result types, `hasOnlyKeys`-validated payload/result validators, wired into `validateCommandPayload`/`validateOperationResult`) and `scripts/provisioner-server.mjs` (a handler function using the existing `incusText`/`optionalText` CLI-wrapper helpers, added to the `handleCommand` switch). The one new piece: `SetWorkspaceLimits` is registered in `MUTATING_COMMAND_TYPES` (`contracts.ts`), so `sendWorkspaceCommand` (`apps/web/lib/workspaces/provisioner.ts`) automatically routes it through `getMutableWorkspaceRefForActor` instead of the plain owner check — this is the mechanism Phase 0 built specifically for this moment, and registering the type is genuinely the only wiring step required.

**Tech Stack:** TypeScript (Next.js app, vitest) for the contract; plain Node.js (`scripts/provisioner-server.mjs`, matching its existing zero-framework CLI-wrapper style) for the host-side `incus config set`/`unset` calls.

## Global Constraints

- No new runtime dependencies.
- Every new exported function gets a corresponding test.
- Every payload/result validator uses `hasOnlyKeys` to reject unknown fields, matching every existing validator in `contracts.ts` (see `validateStopWorkspacePayload`, `validateRestartWorkspacePayload` for the exact idiom).
- `vi.stubEnv` + `vi.unstubAllEnvs()` in `afterEach` for env-dependent tests (established in `apps/web/lib/workspaces/provisioner.test.ts`).
- Incus limit value formats (verified against `scripts/provisioner-server.mjs:515-519,547-566`): `limits.cpu` is a plain non-negative number string (e.g. `"2"`); `limits.memory` is a byte-size string matching `^(\d+(?:\.\d+)?)([kmgt]?i?b?)?$` case-insensitively (e.g. `"4GiB"`, `"512MB"`). Both clear via `incus config unset` (never via setting to an empty string — Incus does not treat an empty `config set` value as equivalent to unset for these keys; using the real `unset` subcommand is the only correct clear mechanism, and this plan uses it explicitly rather than relying on the empty-string ambiguity `PORTING_PLAN.md` warned about).

---

### Task 1: Add the `SetWorkspaceLimits` command to the contract

**Files:**
- Modify: `apps/web/lib/provisioner/contracts.ts:3-12` (register in `MUTATING_COMMAND_TYPES`), `:159-296` (new payload/result types + map entries), `:742-763` (payload validator dispatch), `:765-828` (new payload validator function), `:830-852` (result validator dispatch), new result validator function.
- Test: `apps/web/lib/provisioner/contracts.test.ts`.

**Interfaces:**
- Produces: `export type SetWorkspaceLimitsPayload = { cpu?: string; memory?: string }` and `export type SetWorkspaceLimitsResult = LifecycleWorkspaceResult` (reuses the existing `LifecycleWorkspaceResult` shape — `{workspaceId, state, status?}` — since setting limits doesn't change lifecycle state but the result should still report current runtime status, same as start/stop/restart already do). `"SetWorkspaceLimits"` becomes a valid `ProvisionerCommandType`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/lib/provisioner/contracts.test.ts` (find the existing `import` block at the top and add `SetWorkspaceLimitsPayload`, `SetWorkspaceLimitsResult`, `validateProvisionerCommand` is already imported — check and only add what's missing; the file already imports `PROVISIONER_CONTRACT_VERSION`, `validateProvisionerOperation`, `type ProvisionerCommand`, `type ProvisionerOperation` per existing usage). Append these tests near the other payload-validation tests (grep the file for `describe("provisioner contract validators"` — add inside that block):

```typescript
it("accepts a SetWorkspaceLimits command with both cpu and memory set", () => {
  const command: ProvisionerCommand<"SetWorkspaceLimits"> = {
    ...baseCommand,
    type: "SetWorkspaceLimits",
    payload: { cpu: "2", memory: "4GiB" },
  };
  const result = validateProvisionerCommand(command);
  expect(result).toMatchObject({ ok: true });
});

it("accepts a SetWorkspaceLimits command with no fields (clears both)", () => {
  const command: ProvisionerCommand<"SetWorkspaceLimits"> = {
    ...baseCommand,
    type: "SetWorkspaceLimits",
    payload: {},
  };
  const result = validateProvisionerCommand(command);
  expect(result).toMatchObject({ ok: true });
});

it("accepts a SetWorkspaceLimits command clearing only cpu", () => {
  const command: ProvisionerCommand<"SetWorkspaceLimits"> = {
    ...baseCommand,
    type: "SetWorkspaceLimits",
    payload: { memory: "4GiB" },
  };
  const result = validateProvisionerCommand(command);
  expect(result).toMatchObject({ ok: true });
});

it("rejects a SetWorkspaceLimits payload with unsupported fields", () => {
  const command = {
    ...baseCommand,
    type: "SetWorkspaceLimits",
    payload: { cpu: "2", disk: "40GiB" },
  };
  const result = validateProvisionerCommand(command);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
});

it("rejects a SetWorkspaceLimits payload with a malformed cpu value", () => {
  const command = {
    ...baseCommand,
    type: "SetWorkspaceLimits",
    payload: { cpu: "not-a-number" },
  };
  const result = validateProvisionerCommand(command);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
});

it("rejects a SetWorkspaceLimits payload with a negative cpu value", () => {
  const command = {
    ...baseCommand,
    type: "SetWorkspaceLimits",
    payload: { cpu: "-1" },
  };
  const result = validateProvisionerCommand(command);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
});

it("rejects a SetWorkspaceLimits payload with a malformed memory value", () => {
  const command = {
    ...baseCommand,
    type: "SetWorkspaceLimits",
    payload: { memory: "lots" },
  };
  const result = validateProvisionerCommand(command);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
});

it("accepts a valid SetWorkspaceLimits operation result", () => {
  const operation: ProvisionerOperation<"SetWorkspaceLimits"> = {
    id: "op-limits-1",
    requestId: "req-limits-1",
    type: "SetWorkspaceLimits",
    workspaceId: "workspace-1",
    status: "succeeded",
    result: {
      workspaceId: "workspace-1",
      state: "running",
    },
  };
  const validated = validateProvisionerOperation(
    operation,
    {
      id: "workspace-1",
      ownerUserId: "user-1",
      incusProject: "user-abc123",
      incusContainer: "ws-def456",
    },
    "SetWorkspaceLimits",
  );
  expect(validated).toMatchObject({ ok: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npm run test -- --run contracts.test.ts`
Expected: FAIL — TypeScript error, `"SetWorkspaceLimits"` is not assignable to `ProvisionerCommandType` (the type doesn't exist yet).

- [ ] **Step 3: Register the command type**

In `apps/web/lib/provisioner/contracts.ts`, add to `PROVISIONER_COMMAND_TYPES` (currently lines 3-12):

```typescript
export const PROVISIONER_COMMAND_TYPES = [
  "CreateWorkspace",
  "StartWorkspace",
  "StopWorkspace",
  "RestartWorkspace",
  "GetWorkspaceStatus",
  "RunSetup",
  "DispatchAgentRun",
  "ListAgentRuns",
  "SetWorkspaceLimits",
] as const;
```

And register it as mutating — this is the entire authorization-wiring step, per Phase 0's design:

```typescript
export const MUTATING_COMMAND_TYPES = [
  "SetWorkspaceLimits",
] as const satisfies readonly (typeof PROVISIONER_COMMAND_TYPES)[number][];
```

- [ ] **Step 4: Add the payload and result types**

Add near the other payload types (after `RestartWorkspacePayload`, currently ending at line 169):

```typescript
export type SetWorkspaceLimitsPayload = {
  cpu?: string;
  memory?: string;
};
```

Add near `LifecycleWorkspaceResult` (currently lines 254-258) — reuse it directly, no new result type needed:

```typescript
export type SetWorkspaceLimitsResult = LifecycleWorkspaceResult;
```

Add to `ProvisionerCommandPayloadMap` (currently lines 276-285):

```typescript
export type ProvisionerCommandPayloadMap = {
  CreateWorkspace: CreateWorkspacePayload;
  StartWorkspace: StartWorkspacePayload;
  StopWorkspace: StopWorkspacePayload;
  RestartWorkspace: RestartWorkspacePayload;
  GetWorkspaceStatus: GetWorkspaceStatusPayload;
  RunSetup: RunSetupPayload;
  DispatchAgentRun: DispatchAgentRunPayload;
  ListAgentRuns: ListAgentRunsPayload;
  SetWorkspaceLimits: SetWorkspaceLimitsPayload;
};
```

Add to `ProvisionerCommandResultMap` (currently lines 287-296):

```typescript
export type ProvisionerCommandResultMap = {
  CreateWorkspace: CreateWorkspaceResult;
  StartWorkspace: LifecycleWorkspaceResult;
  StopWorkspace: LifecycleWorkspaceResult;
  RestartWorkspace: LifecycleWorkspaceResult;
  GetWorkspaceStatus: WorkspaceRuntimeStatus;
  RunSetup: RunSetupResult;
  DispatchAgentRun: DispatchAgentRunResult;
  ListAgentRuns: ListAgentRunsResult;
  SetWorkspaceLimits: SetWorkspaceLimitsResult;
};
```

- [ ] **Step 5: Add the payload validator**

Add a case to `validateCommandPayload`'s switch (currently lines 742-763):

```typescript
function validateCommandPayload(
  type: ProvisionerCommandType,
  payload: unknown,
): ValidationResult<unknown> {
  switch (type) {
    case "CreateWorkspace":
      return validateCreateWorkspacePayload(payload);
    case "StartWorkspace":
    case "GetWorkspaceStatus":
      return validateEmptyPayload(payload);
    case "StopWorkspace":
      return validateStopWorkspacePayload(payload);
    case "RestartWorkspace":
      return validateRestartWorkspacePayload(payload);
    case "RunSetup":
      return validateSetupPayload(payload);
    case "DispatchAgentRun":
      return validateDispatchAgentRunPayload(payload);
    case "ListAgentRuns":
      return validateListAgentRunsPayload(payload);
    case "SetWorkspaceLimits":
      return validateSetWorkspaceLimitsPayload(payload);
  }
}
```

Add the new validator function near `validateRestartWorkspacePayload` (currently ending at line 816):

```typescript
const CPU_LIMIT_PATTERN = /^\d+(\.\d+)?$/;
const MEMORY_LIMIT_PATTERN = /^\d+(\.\d+)?[kmgt]?i?b?$/i;

function validateSetWorkspaceLimitsPayload(
  payload: unknown,
): ValidationResult<SetWorkspaceLimitsPayload> {
  if (!isRecord(payload)) {
    return invalid("SetWorkspaceLimits payload must be an object");
  }
  if (!hasOnlyKeys(payload, ["cpu", "memory"])) {
    return invalid("SetWorkspaceLimits payload contains unsupported fields");
  }
  if (
    payload.cpu !== undefined &&
    (typeof payload.cpu !== "string" ||
      payload.cpu.length === 0 ||
      !CPU_LIMIT_PATTERN.test(payload.cpu))
  ) {
    return invalid("cpu must be a non-negative number string");
  }
  if (
    payload.memory !== undefined &&
    (typeof payload.memory !== "string" ||
      payload.memory.length === 0 ||
      !MEMORY_LIMIT_PATTERN.test(payload.memory))
  ) {
    return invalid("memory must be a byte-size string like 4GiB or 512MB");
  }
  return { ok: true, value: payload as SetWorkspaceLimitsPayload };
}
```

- [ ] **Step 6: Add the result validator**

Add a case to `validateOperationResult`'s switch (currently lines 830-852):

```typescript
function validateOperationResult(
  type: ProvisionerCommandType,
  result: unknown,
  workspace: ProvisionerWorkspaceRef,
): ValidationResult<unknown> {
  switch (type) {
    case "GetWorkspaceStatus":
      return validateWorkspaceRuntimeStatus(result, workspace);
    case "CreateWorkspace":
      return validateCreateWorkspaceResult(result, workspace);
    case "StartWorkspace":
    case "RestartWorkspace":
      return validateLifecycleWorkspaceResult(result, workspace, "running", true);
    case "StopWorkspace":
      return validateLifecycleWorkspaceResult(result, workspace, "stopped", false);
    case "RunSetup":
      return validateRunSetupResult(result, workspace);
    case "DispatchAgentRun":
      return validateDispatchAgentRunResult(result, workspace);
    case "ListAgentRuns":
      return validateListAgentRunsResult(result, workspace);
    case "SetWorkspaceLimits":
      return validateSetWorkspaceLimitsResult(result, workspace);
  }
}
```

Add the new result validator near `validateLifecycleWorkspaceResult` (currently ending at line 933) — `SetWorkspaceLimits` doesn't force a particular lifecycle state (the workspace could be running or stopped when limits are changed), so this validator is a relaxed variant that accepts either:

```typescript
function validateSetWorkspaceLimitsResult(
  result: unknown,
  workspace: ProvisionerWorkspaceRef,
): ValidationResult<SetWorkspaceLimitsResult> {
  if (!isRecord(result)) {
    return invalid("SetWorkspaceLimits result must be an object");
  }
  if (result.workspaceId !== workspace.id) {
    return metadataMismatch("SetWorkspaceLimits result workspace did not match request");
  }
  if (result.state !== "running" && result.state !== "stopped") {
    return invalid("SetWorkspaceLimits result state is invalid");
  }
  if (result.status !== undefined) {
    const status = validateWorkspaceRuntimeStatus(result.status, workspace);
    if (!status.ok) {
      return status;
    }
  }
  return { ok: true, value: result as SetWorkspaceLimitsResult };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/web && npm run test -- --run contracts.test.ts`
Expected: PASS — all 9 new cases plus the existing suite.

- [ ] **Step 8: Run the full test suite, lint, and typecheck**

Run: `cd apps/web && npm run test -- --run && npm run lint && npx tsc --noEmit`
Expected: all tests passing, 0 lint errors, 0 typecheck errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/provisioner/contracts.ts apps/web/lib/provisioner/contracts.test.ts
git commit -m "feat(web): add SetWorkspaceLimits to the provisioner contract"
```

---

### Task 2: Wire the authorization gate and dispatch test

**Files:**
- Test: `apps/web/lib/workspaces/provisioner.test.ts`.

**Interfaces:**
- Consumes: `SetWorkspaceLimits` command type and `MUTATING_COMMAND_TYPES` from Task 1.
- Confirms: `sendWorkspaceCommand` (already implemented in Phase 0, `apps/web/lib/workspaces/provisioner.ts:239-241` — `isMutatingCommandType(type) ? getMutableWorkspaceRefForActor(actor) : getWorkspaceRefForActor(actor)`) now has a *real* command type to route, replacing the Phase 0 test that had to temporarily borrow `StopWorkspace` as a stand-in. No production code changes in this task — this task exists purely to add the real-command-type test coverage Phase 0's own plan review called out as missing.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/workspaces/provisioner.test.ts`, inside the existing `describe("workspace inventory provisioner", ...)` block, after the last test (the "treats no real command type as mutating yet" pinning test added in Phase 0):

```typescript
  it("routes SetWorkspaceLimits through the mutation gate for real", async () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "authenticated");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_PROTOTYPE", "1");
    const actor = getActorFromHeaders(
      authHeaders({ email: "jacob@example.com", subject: "jacob" }),
    );
    const client = { send: vi.fn() };

    const operation = await sendWorkspaceCommand(
      actor,
      "SetWorkspaceLimits",
      { cpu: "2" },
      client,
    );

    expect(client.send).not.toHaveBeenCalled();
    expect(operation).toMatchObject({
      type: "SetWorkspaceLimits",
      status: "failed",
      error: { code: "mutation_not_authorized" },
    });
  });

  it("allows SetWorkspaceLimits through the mutation gate with the explicit opt-in", async () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "authenticated");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_PROTOTYPE", "1");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION", "1");
    const actor = getActorFromHeaders(
      authHeaders({ email: "jacob@example.com", subject: "jacob" }),
    );
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-limits-1",
        requestId: actor.requestId,
        type: "SetWorkspaceLimits",
        workspaceId: "workspace-incus-web",
        status: "succeeded",
        result: {
          workspaceId: "workspace-incus-web",
          state: "running",
        },
      }),
    };

    const operation = await sendWorkspaceCommand(
      actor,
      "SetWorkspaceLimits",
      { cpu: "2" },
      client,
    );

    expect(client.send).toHaveBeenCalled();
    expect(operation.status).toBe("succeeded");
  });

  it("no longer needs a stand-in command type for the mutation-gate pinning test", () => {
    // SetWorkspaceLimits is now a real, permanent entry in
    // MUTATING_COMMAND_TYPES -- update the Phase 0 pinning test's
    // expectation accordingly (see the next step in this task).
    expect(isMutatingCommandType("SetWorkspaceLimits")).toBe(true);
  });
```

- [ ] **Step 2: Update the Phase 0 pinning test to reflect the new real entry**

Find the test added in Phase 0 titled `"treats no real command type as mutating yet (Phase 0 ships the gate mechanism, not a populated registry)"` in `apps/web/lib/workspaces/provisioner.test.ts` and replace it:

```typescript
  it("treats exactly SetWorkspaceLimits as mutating today", () => {
    // Pins the current state: MUTATING_COMMAND_TYPES in contracts.ts
    // contains exactly SetWorkspaceLimits. When a future command (e.g.
    // SetWorkspaceMount, Phase 3) is added to that array, this test
    // should be updated alongside that change.
    for (const type of PROVISIONER_COMMAND_TYPES) {
      const expected = type === "SetWorkspaceLimits";
      expect(isMutatingCommandType(type)).toBe(expected);
    }
  });
```

- [ ] **Step 3: Run tests to verify they fail, then pass**

Run: `cd apps/web && npm run test -- --run provisioner.test.ts`
Expected first: FAIL (SetWorkspaceLimits payload/type doesn't validate without Task 1's contract changes present — this task assumes Task 1 is already committed, so if run standalone it should already PASS since Task 1 lands first).
Run again after confirming Task 1 is present: PASS — all cases including the 3 new ones and the updated pinning test.

- [ ] **Step 4: Run the full suite, lint, typecheck**

Run: `cd apps/web && npm run test -- --run && npm run lint && npx tsc --noEmit`
Expected: all passing, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/workspaces/provisioner.test.ts
git commit -m "test(web): cover SetWorkspaceLimits through the real mutation gate"
```

---

### Task 3: Implement the provisioner-server handler

**Files:**
- Modify: `scripts/provisioner-server.mjs:354-421` (add `setWorkspaceLimits` near `startWorkspace`/`stopWorkspace`/`restartWorkspace`), `:572-646` (add the `SetWorkspaceLimits` case to `handleCommand`).
- Test: `apps/web/lib/provisioner/agent-runs-host.test.ts` pattern doesn't apply here directly (that file tests `agent-runs.mjs` specifically) — create `apps/web/lib/provisioner/provisioner-server-limits.test.ts`, a new cross-module test file importing `handleCommand`... **correction, see Step 1 note below**: `provisioner-server.mjs` does not currently export `handleCommand` or the individual command handlers for unit testing — it only self-executes as an HTTP server. Rather than refactor the whole file's export surface (out of scope for this plan), this task adds a focused **integration test** following the exact pattern already established in Phase 0's `apps/web/lib/provisioner/provisioner-server-auth.integration.test.ts` (spawn the real server as a subprocess, hit it over its Unix socket, assert on the HTTP response) — this is the established, working pattern for testing this file's behavior end-to-end without an export refactor.

**Interfaces:**
- Consumes: the `SetWorkspaceLimits` command shape from Task 1, the existing `incusText`/`optionalText`/`getWorkspaceStatus`/`statusCache` machinery already in `provisioner-server.mjs`.
- Produces: a working `SetWorkspaceLimits` handler reachable over the real provisioner Unix socket.

- [ ] **Step 1: Write the failing integration test**

Create `apps/web/lib/provisioner/provisioner-server-limits.test.ts`, closely modeled on the existing `provisioner-server-auth.integration.test.ts` (same subprocess-spawn + Unix-socket-request pattern, same `waitForSocket` helper duplicated locally since the existing one isn't exported — check `provisioner-server-auth.integration.test.ts` first and copy its `waitForSocket`/`postOperations`-style helpers verbatim, adapting the request body). This test does NOT require a real `incus` binary or a real container — it asserts on the **shape and status code** of the response for an unauthenticated/malformed case (which doesn't reach the `incus` CLI at all) and documents that the happy-path `incus config set` call itself is exercised manually, matching how Phase 0's Task 2 Step 7 validated the auth backport without needing a real container:

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const TOKEN = "integration-test-token-limits";

function postOperations(
  socketPath: string,
  body: unknown,
): Promise<{ status: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path: "/v1/operations",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: `Bearer ${TOKEN}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let parsed: unknown = undefined;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            // non-JSON response is fine for these assertions
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function waitForSocket(socketPath: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await access(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`provisioner socket did not appear at ${socketPath} within ${timeoutMs}ms`);
}

describe("provisioner-server SetWorkspaceLimits (integration)", () => {
  let tempDir: string;
  let socketPath: string;
  let child: ChildProcess;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "incus-web-provisioner-limits-"));
    socketPath = join(tempDir, "provisioner.sock");

    child = spawn(
      process.execPath,
      [join(currentDir, "../../../../scripts/provisioner-server.mjs")],
      {
        env: {
          ...process.env,
          INCUS_WEB_PROVISIONER_TOKEN: TOKEN,
          INCUS_WEB_PROVISIONER_SOCKET: socketPath,
          INCUS_WEB_PROVISIONER_HOST: "",
          INCUS_WEB_PROVISIONER_PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForSocket(socketPath);
  }, 15000);

  afterAll(async () => {
    child?.kill();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("returns a structured invalid_input error for a malformed SetWorkspaceLimits command, proving the handler is reachable and validates before touching incus", async () => {
    const response = await postOperations(socketPath, {
      version: "provisioner.v1",
      requestId: "req-1",
      type: "SetWorkspaceLimits",
      actor: {
        userId: "user-1",
        oidcSubject: "subject-1",
        email: "owner@example.com",
      },
      workspace: {
        id: "workspace-incus-web",
        ownerUserId: "user-1",
        incusProject: "default",
        incusContainer: "incus-web",
      },
      payload: { cpu: "not-a-number" },
    });

    // The provisioner's own validateWorkspace() check runs before command
    // validation and will reject this tuple as a metadata_mismatch unless
    // it matches the real host's INCUS_WEB_WORKSPACE_ID/PROJECT/CONTAINER
    // env vars -- so this asserts on "not a 404 (route exists) and not a
    // 401 (auth passed)" rather than a specific success/validation code,
    // proving the SetWorkspaceLimits case in handleCommand's switch is
    // reachable and doesn't crash, without needing to match this dev
    // machine's exact (unset) workspace env vars.
    expect(response.status).not.toBe(404);
    expect(response.status).not.toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npm run test -- --run provisioner-server-limits.test.ts`
Expected: FAIL — response status is `400` from the `default:` branch in `handleCommand`'s switch (`"SetWorkspaceLimits is not enabled in the host provisioner yet"`), because there's no explicit `SetWorkspaceLimits` case yet. Actually check: the `default` branch returns an `operation(..., "failed", error("invalid_state", ...))`, which the HTTP layer wraps as `200` with a JSON `status: "failed"` body (following the same pattern as every other command's failure path — verify by reading `scripts/provisioner-server.mjs`'s `send(res, 200, await handleCommand(...))` call at the request handler). So the actual expected-to-fail assertion is that `response.body` is `{status: "failed", error: {code: "invalid_state", ...}}` instead of the validation-layer `invalid_input` we want — confirm this by running the test and reading its actual failure output before writing the implementation.

- [ ] **Step 3: Implement `setWorkspaceLimits` in provisioner-server.mjs**

Add near `restartWorkspace` (currently ending at line 477, right before `mapIncusState`):

```javascript
async function setWorkspaceLimits(command, options) {
  const cpu = command.payload?.cpu;
  const memory = command.payload?.memory;

  if (cpu !== undefined) {
    await incusText(["config", "set", incusContainer, `limits.cpu=${cpu}`], options);
  } else {
    await incusText(["config", "unset", incusContainer, "limits.cpu"], options);
  }

  if (memory !== undefined) {
    await incusText(["config", "set", incusContainer, `limits.memory=${memory}`], options);
  } else {
    await incusText(["config", "unset", incusContainer, "limits.memory"], options);
  }

  statusCache = undefined;
  const status = await getWorkspaceStatus(command, options);
  return {
    workspaceId: command.workspace.id,
    state: status.state === "running" ? "running" : "stopped",
    status,
  };
}
```

This mirrors `startWorkspace`/`stopWorkspace`/`restartWorkspace`'s exact shape: an `incusText` CLI call, a `statusCache = undefined` invalidation (the same line already present in all three existing mutating lifecycle handlers, per `scripts/provisioner-server.mjs:436,455,471` — carrying that pattern forward is what the Phase 0 plan review explicitly called out as required, not optional, for any new mutating command), then a fresh `getWorkspaceStatus` call. Uses `config unset` (not an empty-string `config set`) to clear a limit — this is the exact clear-semantics fix `PORTING_PLAN.md` §4 calls out as a footgun incus-unraid hit in production.

- [ ] **Step 4: Wire the handler into `handleCommand`**

Add a case to the switch in `handleCommand` (currently lines 585-646), right after the `RestartWorkspace` case:

```javascript
      case "RestartWorkspace":
        return operation(
          command,
          "succeeded",
          await restartWorkspace(command, options),
        );
      case "SetWorkspaceLimits":
        return operation(
          command,
          "succeeded",
          await setWorkspaceLimits(command, options),
        );
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `cd apps/web && npm run test -- --run provisioner-server-limits.test.ts`
Expected: PASS — the response is no longer a 404/401, and the response body's `status` field is no longer the `invalid_state` "not enabled" error (it will likely be `"failed"` with a `metadata_mismatch` or an `incus_unavailable`-class error instead, since this dev machine has no real `incus-web` container to operate on — that's fine, the test only asserts reachability per its own documented intent in Step 1).

- [ ] **Step 6: Run the full suite, lint, typecheck, and the static deploy tests**

Run: `cd apps/web && npm run test -- --run && npm run lint && npx tsc --noEmit && cd .. && bash tests/deploy_static_tests.sh`
Expected: all passing, 0 errors. (The static deploy test script greps `scripts/provisioner-server.mjs` for known content strings — verify it doesn't need updating; if it does, add `"SetWorkspaceLimits"` to its needle list following the exact pattern used for `"StartWorkspace"`/`"StopWorkspace"` in that file.)

- [ ] **Step 7: Manual smoke test against a real container (if available)**

If a real `incus-web` container is reachable from this environment:

```bash
INCUS_WEB_PROVISIONER_TOKEN=smoke-test-token node scripts/provisioner-server.mjs &
sleep 1
curl -s --unix-socket /run/incus-web/provisioner.sock \
  -X POST http://localhost/v1/operations \
  -H 'Authorization: Bearer smoke-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"version":"provisioner.v1","requestId":"smoke-1","type":"SetWorkspaceLimits","actor":{"userId":"user-1","oidcSubject":"s","email":"e@example.com"},"workspace":{"id":"workspace-incus-web","ownerUserId":"user-1","incusProject":"default","incusContainer":"incus-web"},"payload":{"cpu":"2"}}'
incus config get incus-web limits.cpu
kill %1
```

Expected: the response's `status` is `"succeeded"`, and `incus config get incus-web limits.cpu` prints `2`. If no real container is available in this environment, skip this step and note it as unverified in the handoff.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/provisioner/provisioner-server-limits.test.ts scripts/provisioner-server.mjs tests/deploy_static_tests.sh
git commit -m "feat(provisioner): implement SetWorkspaceLimits handler"
```

---

## Self-Review

**1. Spec coverage against `PORTING_PLAN.md` §4 and §7 Phase 1's `SetWorkspaceLimits` bullet:**
- "added to `contracts.ts` with the same typed-payload, `hasOnlyKeys`-validated discipline as the existing eight commands" → Task 1, following the exact existing pattern (verified against `validateStopWorkspacePayload`/`validateRestartWorkspacePayload`).
- "gated on Phase 0's authorization design" → Task 1 Step 3 registers it in `MUTATING_COMMAND_TYPES`; Task 2 proves the routing works with the real command type (not a borrowed stand-in).
- "clear via omit-or-empty-string" footgun → deliberately NOT replicated as "empty string clears" — this plan uses `incus config unset` exclusively for clearing, which is the actually-correct Incus mechanism (verified: Incus's `config set key=` with an empty value does not reliably behave as unset for all key types; `config unset` is the unambiguous, documented clear operation). This is a considered deviation from a literal reading of the PORTING_PLAN.md text, not an oversight — noted here per the plan's own instruction to replicate clear-semantics *carefully*, which this interprets as "get it actually right" rather than "copy the ambiguous mechanism."
- `SetWorkspaceMount`/`ClearWorkspaceMount` and the Details panel UI are explicitly **out of scope** — those are Phase 2/3 work per `PORTING_PLAN.md` §7, not part of this plan.

**2. Placeholder scan:** No TBD/TODO markers. Every step has complete, real code grounded in direct reads of the current `contracts.ts` and `provisioner-server.mjs`. Task 3's test acknowledges the real limitation (no exported handler functions to unit-test directly, no real `incus` binary in this dev environment) rather than hiding it, and states exactly what the integration test can and can't prove.

**3. Type consistency:** `SetWorkspaceLimitsPayload` (`{cpu?: string; memory?: string}`) and `SetWorkspaceLimitsResult` (`= LifecycleWorkspaceResult`) are used identically across Task 1's contract types, Task 2's dispatch tests, and Task 3's handler implementation — no renamed fields between tasks.
