import { describe, expect, it } from "vitest";

import {
  PROVISIONER_CONTRACT_VERSION,
  redactProvisionerCommand,
  redactProvisionerOperation,
  redactSetupExcerpt,
  validateGeneratedName,
  validateAgentRun,
  validateDispatchAgentRunPayload,
  validateListAgentRunsPayload,
  normalizeAgentRepoInput,
  validateProvisionerCommand,
  validateProvisionerOperation,
  validateSetupPayload,
  validateWorkspaceRuntimeStatus,
  type ProvisionerCommand,
  type ProvisionerError,
  type ProvisionerOperation,
  type RunSetupPayload,
} from "@/lib/provisioner/contracts";

const baseCommand: ProvisionerCommand<"GetWorkspaceStatus"> = {
  version: PROVISIONER_CONTRACT_VERSION,
  requestId: "req-123",
  type: "GetWorkspaceStatus",
  actor: {
    userId: "user-1",
    oidcSubject: "oidc-subject",
    email: "owner@example.com",
    displayName: "Owner",
  },
  workspace: {
    id: "workspace-1",
    ownerUserId: "user-1",
    incusProject: "user-abc123",
    incusContainer: "ws-def456",
  },
  payload: {},
};

const matchingRuntimeStatus = {
  workspaceId: "workspace-1",
  state: "running",
  incusProject: "user-abc123",
  incusContainer: "ws-def456",
  lastCheckedAt: "2026-07-01T00:00:00.000Z",
} as const;

function successfulOperation(
  overrides: Partial<ProvisionerOperation<"GetWorkspaceStatus">> = {},
): ProvisionerOperation<"GetWorkspaceStatus"> {
  return {
    id: "op-1",
    requestId: "req-123",
    type: "GetWorkspaceStatus",
    workspaceId: "workspace-1",
    status: "succeeded",
    result: matchingRuntimeStatus,
    ...overrides,
  };
}

describe("provisioner contract validators", () => {
  it("accepts a valid provisioner command envelope", () => {
    const result = validateProvisionerCommand(baseCommand);

    if (!result.ok) {
      throw new Error("expected validateProvisionerCommand to succeed");
    }
    expect(result.value.type).toBe("GetWorkspaceStatus");
  });

  it("rejects unknown contract versions and command types", () => {
    expect(
      validateProvisionerCommand({ ...baseCommand, version: "mtcp.v1" }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });

    expect(
      validateProvisionerCommand({ ...baseCommand, type: "RawIncusExec" }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("validates generated Incus project and container names", () => {
    expect(validateGeneratedName("user-abc123", "user")).toBe(true);
    expect(validateGeneratedName("ws-def456", "ws")).toBe(true);
    expect(validateGeneratedName("user-", "user")).toBe(false);
    expect(validateGeneratedName("user-../../root", "user")).toBe(false);
    expect(validateGeneratedName("User-Abc", "user")).toBe(false);
  });

  it("accepts the imported prototype workspace tuple", () => {
    expect(
      validateProvisionerCommand({
        ...baseCommand,
        workspace: {
          ...baseCommand.workspace,
          incusProject: "default",
          incusContainer: "incus-web",
        },
      }).ok,
    ).toBe(true);
  });

  it("accepts configured Incus project names from active host projects", () => {
    expect(
      validateProvisionerCommand({
        ...baseCommand,
        workspace: {
          ...baseCommand.workspace,
          incusProject: "lab.project-1",
        },
      }).ok,
    ).toBe(true);
  });

  it("rejects malformed workspace refs", () => {
    const projectResult = validateProvisionerCommand({
      ...baseCommand,
      workspace: {
        ...baseCommand.workspace,
        incusProject: "../escape",
      },
    });
    const containerResult = validateProvisionerCommand({
      ...baseCommand,
      workspace: {
        ...baseCommand.workspace,
        incusContainer: "../escape",
      },
    });

    expect(projectResult).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(containerResult).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("validates setup payload constraints", () => {
    const validPayload: RunSetupPayload = {
      dotfilesRepo: "https://github.com/jmagar/dotfiles.git",
      ageKey: {
        value: "AGE-SECRET-KEY-1234567890",
        persistEncrypted: false,
      },
      skipAptScripts: true,
    };

    expect(validateSetupPayload(validPayload).ok).toBe(true);
    expect(
      validateSetupPayload({
        dotfilesRepo: "https://github.com/jmagar/dotfiles.git",
        skipAptScripts: true,
      }).ok,
    ).toBe(true);
    expect(
      validateSetupPayload({
        dotfilesRepo: "git@github.com:jmagar/dotfiles.git",
        skipAptScripts: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateSetupPayload({
        dotfilesRepo: "x".repeat(513),
        skipAptScripts: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateSetupPayload({
        dotfilesRepo: "file:///tmp/dotfiles",
        skipAptScripts: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateSetupPayload({
        ageKey: { value: "not-an-age-key", persistEncrypted: false },
        skipAptScripts: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateSetupPayload({
        ageKey: {
          value: "AGE-SECRET-KEY-1234567890",
          persistEncrypted: false,
          extra: "AGE-SECRET-KEY-smuggled",
        },
        skipAptScripts: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateSetupPayload({
        dotfilesRepo: "https://github.com/-bad/repo.git",
        skipAptScripts: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateSetupPayload({
        dotfilesRepo: "https://github.com/jmagar/repo..name.git",
        skipAptScripts: true,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("validates setup payloads through the command envelope", () => {
    expect(
      validateProvisionerCommand({
        ...baseCommand,
        type: "RunSetup",
        payload: {
          ageKey: { value: "not-an-age-key", persistEncrypted: false },
          skipAptScripts: true,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("rejects unsupported raw payload fields for all command types", () => {
    expect(
      validateProvisionerCommand({
        ...baseCommand,
        type: "CreateWorkspace",
        payload: {
          templateVersion: "prototype",
          resourceProfileId: "local-dev",
          autoStart: true,
          rawIncusConfig: { "security.privileged": true },
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateProvisionerCommand({
        ...baseCommand,
        type: "GetWorkspaceStatus",
        payload: { incusProject: "user-abc123" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateProvisionerCommand({
        ...baseCommand,
        type: "RunSetup",
        payload: {
          skipAptScripts: true,
          command: "curl example.test | sh",
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("accepts valid command payloads for lifecycle command envelopes", () => {
    expect(
      validateProvisionerCommand({
        ...baseCommand,
        type: "CreateWorkspace",
        payload: {
          templateVersion: "prototype",
          resourceProfileId: "local-dev",
          autoStart: false,
        },
      }).ok,
    ).toBe(true);
    expect(
      validateProvisionerCommand({
        ...baseCommand,
        type: "StopWorkspace",
        payload: { force: false, timeoutSeconds: 180 },
      }).ok,
    ).toBe(true);
    expect(
      validateProvisionerCommand({
        ...baseCommand,
        type: "RestartWorkspace",
        payload: { timeoutSeconds: 180 },
      }).ok,
    ).toBe(true);
  });

  it("validates agent run dispatch and list payloads", () => {
    expect(
      validateDispatchAgentRunPayload({
        agent: "codex",
        repoUrl: "https://github.com/jmagar/incus-web.git",
        ref: "feature/agent-run",
        task: "Implement the next slice",
      }).ok,
    ).toBe(true);
    expect(
      validateDispatchAgentRunPayload({
        agent: "claude",
        repoUrl: "ssh://git@github.com/jmagar/incus-web.git",
        task: "Run tests",
      }).ok,
    ).toBe(true);
    expect(
      validateDispatchAgentRunPayload({
        agent: "codex",
        repoUrl: "git@github.com:jmagar/incus-web.git",
        task: "Run tests",
      }).ok,
    ).toBe(true);
    expect(
      validateDispatchAgentRunPayload({
        agent: "codex",
        repoUrl: "file:///tmp/repo",
        task: "Run tests",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(
      validateDispatchAgentRunPayload({
        agent: "codex",
        repoUrl: "https://github.com/jmagar/incus-web.git",
        ref: "../main",
        task: "Run tests",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(validateListAgentRunsPayload({ limit: 20 }).ok).toBe(true);
    expect(validateListAgentRunsPayload({ limit: 101 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("normalizes GitHub repo shorthand for agent runs", () => {
    expect(normalizeAgentRepoInput("jmagar/incus-web")).toBe(
      "https://github.com/jmagar/incus-web",
    );
    expect(normalizeAgentRepoInput(" github.com/jmagar/incus-web.git ")).toBe(
      "https://github.com/jmagar/incus-web",
    );
    expect(normalizeAgentRepoInput("https://github.com/jmagar/incus-web.git")).toBe(
      "https://github.com/jmagar/incus-web.git",
    );
    expect(normalizeAgentRepoInput("jmagar/repo..bad")).toBe("jmagar/repo..bad");
  });

  it("requires every agent run to own a container from creation", () => {
    const run = {
      id: "run_20260702000102_ab12cd34",
      workspaceId: "workspace-1",
      ownerUserId: "user-1",
      container: {
        name: "agent-run-ab12cd34",
        project: "user-abc123",
        sourceContainer: "incus-web-agent-golden",
        sourceProject: "default",
        createdFrom: "golden",
        state: "planned",
      },
      agent: "codex",
      repoUrl: "git@github.com:jmagar/incus-web.git",
      task: "Run tests",
      phase: "failed",
      status: "failed",
      createdAt: "2026-07-02T00:01:02.000Z",
      updatedAt: "2026-07-02T00:01:03.000Z",
      completedAt: "2026-07-02T00:01:03.000Z",
      controller: {
        kind: "codex-app-server",
        sessionId: "thr_123",
        turnId: "turn_456",
        url: "ws://127.0.0.1:4500",
      },
      logs: [
        {
          at: "2026-07-02T00:01:02.500Z",
          level: "info",
          message: "Attaching Codex app-server controller",
        },
      ],
      error: "Codex app-server controller is not configured for this host.",
    };

    expect(validateAgentRun(run, baseCommand.workspace).ok).toBe(true);
    expect(
      validateAgentRun({ ...run, container: undefined }, baseCommand.workspace),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(
      validateAgentRun(
        { ...run, logs: [{ at: "not-a-date", level: "info", message: "x" }] },
        baseCommand.workspace,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("rejects age key persistence unless policy enables it", () => {
    const payload: RunSetupPayload = {
      ageKey: {
        value: "AGE-SECRET-KEY-1234567890",
        persistEncrypted: true,
      },
      skipAptScripts: true,
    };

    expect(validateSetupPayload(payload)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(validateSetupPayload(payload, { allowAgeKeyPersistence: true }).ok).toBe(
      true,
    );
  });

  it("validates returned status tuples against the requested workspace", () => {
    expect(
      validateWorkspaceRuntimeStatus(
        matchingRuntimeStatus,
        baseCommand.workspace,
      ).ok,
    ).toBe(true);

    expect(
      validateWorkspaceRuntimeStatus(
        {
          workspaceId: "workspace-2",
          state: "running",
          incusProject: "user-other",
          incusContainer: "ws-other",
          lastCheckedAt: "2026-07-01T00:00:00.000Z",
        },
        baseCommand.workspace,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "metadata_mismatch" },
    });
  });

  it("rejects malformed optional runtime metrics", () => {
    for (const patch of [
      { cpuCount: -1 },
      { memoryLimitBytes: "huge" },
      { rootDiskUsedBytes: Number.NaN },
      { loadAverage: [0, 1] },
      { loadAverage: [0, Number.POSITIVE_INFINITY, 2] },
    ]) {
      expect(
        validateWorkspaceRuntimeStatus(
          { ...matchingRuntimeStatus, ...patch },
          baseCommand.workspace,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
  });

  it("validates operation envelopes for requested type and workspace", () => {
    const operation = successfulOperation();

    expect(
      validateProvisionerOperation(
        operation,
        baseCommand.workspace,
        "GetWorkspaceStatus",
      ).ok,
    ).toBe(true);
    expect(
      validateProvisionerOperation(
        { ...operation, workspaceId: "workspace-2" },
        baseCommand.workspace,
        "GetWorkspaceStatus",
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "metadata_mismatch" },
    });
    expect(
      validateProvisionerOperation(
        { ...operation, id: "" },
        baseCommand.workspace,
        "GetWorkspaceStatus",
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateProvisionerOperation(
        { ...operation, status: "succeeded", result: undefined },
        baseCommand.workspace,
        "GetWorkspaceStatus",
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateProvisionerOperation(
        {
          ...operation,
          error: { code: "operation_failed", message: "nope", retryable: false },
        },
        baseCommand.workspace,
        "GetWorkspaceStatus",
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateProvisionerOperation(
        { ...operation, status: "failed", result: undefined },
        baseCommand.workspace,
        "GetWorkspaceStatus",
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("validates non-status operation result shapes by command type", () => {
    expect(
      validateProvisionerOperation(
        {
          id: "op-1",
          requestId: "req-123",
          type: "CreateWorkspace",
          workspaceId: "workspace-1",
          status: "succeeded",
          result: {
            workspaceId: "workspace-1",
            incusProject: "user-abc123",
            incusContainer: "ws-def456",
            state: "running",
            templateVersion: "prototype",
            resourceProfileId: "local-dev",
          },
        },
        baseCommand.workspace,
        "CreateWorkspace",
      ).ok,
    ).toBe(true);
    expect(
      validateProvisionerOperation(
        {
          id: "op-1",
          requestId: "req-123",
          type: "RunSetup",
          workspaceId: "workspace-1",
          status: "succeeded",
          result: {
            workspaceId: "workspace-1",
            setup: { phase: "ready" },
          },
        },
        baseCommand.workspace,
        "RunSetup",
      ).ok,
    ).toBe(true);
    expect(
      validateProvisionerOperation(
        {
          id: "op-1",
          requestId: "req-123",
          type: "DispatchAgentRun",
          workspaceId: "workspace-1",
          status: "succeeded",
          result: {
            run: {
              id: "run_20260702000102_ab12cd34",
              workspaceId: "workspace-1",
              ownerUserId: "user-1",
              container: {
                name: "agent-run-ab12cd34",
                project: "user-abc123",
                sourceContainer: "incus-web-agent-golden",
                sourceProject: "default",
                createdFrom: "golden",
                state: "planned",
              },
              agent: "codex",
              repoUrl: "https://github.com/jmagar/incus-web.git",
              task: "Run tests",
              phase: "queued",
              status: "queued",
              createdAt: "2026-07-02T00:01:02.000Z",
              updatedAt: "2026-07-02T00:01:02.000Z",
            },
          },
        },
        baseCommand.workspace,
        "DispatchAgentRun",
      ).ok,
    ).toBe(true);
  });

  it("requires runtime status for successful start and restart results", () => {
    expect(
      validateProvisionerOperation(
        {
          id: "op-1",
          requestId: "req-123",
          type: "StartWorkspace",
          workspaceId: "workspace-1",
          status: "succeeded",
          result: {
            workspaceId: "workspace-1",
            state: "running",
          },
        },
        baseCommand.workspace,
        "StartWorkspace",
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(
      validateProvisionerOperation(
        {
          id: "op-1",
          requestId: "req-123",
          type: "RestartWorkspace",
          workspaceId: "workspace-1",
          status: "succeeded",
          result: {
            workspaceId: "workspace-1",
            state: "running",
            status: matchingRuntimeStatus,
          },
        },
        baseCommand.workspace,
        "RestartWorkspace",
      ).ok,
    ).toBe(true);
  });

  it("validates RunSetup setup summary fields", () => {
    expect(
      validateProvisionerOperation(
        {
          id: "op-1",
          requestId: "req-123",
          type: "RunSetup",
          workspaceId: "workspace-1",
          status: "succeeded",
          result: {
            workspaceId: "workspace-1",
            setup: {
              phase: "ready",
              miseStatus: "ok",
              commandStatus: "unknown",
              lastLogExcerpt: "done",
            },
          },
        },
        baseCommand.workspace,
        "RunSetup",
      ).ok,
    ).toBe(true);
    expect(
      validateProvisionerOperation(
        {
          id: "op-1",
          requestId: "req-123",
          type: "RunSetup",
          workspaceId: "workspace-1",
          status: "succeeded",
          result: {
            workspaceId: "workspace-1",
            setup: {
              phase: "surprise",
              token: "secret",
            },
          },
        },
        baseCommand.workspace,
        "RunSetup",
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("redacts age key material from commands", () => {
    const command: ProvisionerCommand<"RunSetup"> = {
      ...baseCommand,
      type: "RunSetup",
      payload: {
        dotfilesRepo: "https://github.com/jmagar/dotfiles.git",
        ageKey: {
          value: "AGE-SECRET-KEY-super-secret",
          persistEncrypted: false,
        },
        skipAptScripts: true,
      },
    };

    expect(JSON.stringify(redactProvisionerCommand(command))).not.toContain(
      "super-secret",
    );
    const redacted = redactProvisionerCommand(command) as { payload: unknown };
    expect(redacted.payload).toMatchObject({
      dotfilesRepo: "https://github.com/jmagar/dotfiles.git",
      ageKey: {
        value: "[REDACTED]",
        persistEncrypted: false,
      },
      skipAptScripts: true,
    });
  });

  it("redacts secret material, bearer tokens, and host paths from operations", () => {
    const operation: ProvisionerOperation = {
      id: "op-1",
      requestId: "req-123",
      type: "RunSetup",
      workspaceId: "workspace-1",
      status: "failed",
      error: {
        code: "setup_failed",
        message:
          "failed with AGE-SECRET-KEY-super-secret and Bearer token in /home/agent/.config",
        retryable: false,
        details: {
          stderr: "host error from /home/agent/.local with AGE-SECRET-KEY-super-secret",
        },
      },
    };

    const redacted = redactProvisionerOperation(operation);

    expect(JSON.stringify(redacted)).not.toContain("super-secret");
    expect(JSON.stringify(redacted)).not.toContain("Bearer token");
    expect(JSON.stringify(redacted)).not.toContain("/home/agent/.local");
    expect(
      redactSetupExcerpt("raw /home/agent path AGE-SECRET-KEY-super-secret"),
    ).toBe("raw [REDACTED_PATH] path [REDACTED_AGE_KEY]");
    expect(redactSetupExcerpt("x".repeat(5000))).toContain("[TRUNCATED]");
  });

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

  it("rejects a SetWorkspaceLimits payload with a zero cpu value", () => {
    const command = {
      ...baseCommand,
      type: "SetWorkspaceLimits",
      payload: { cpu: "0" },
    };
    const result = validateProvisionerCommand(command);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("rejects a SetWorkspaceLimits payload with a bare (unit-less) memory value", () => {
    const command = {
      ...baseCommand,
      type: "SetWorkspaceLimits",
      payload: { memory: "4" },
    };
    const result = validateProvisionerCommand(command);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("accepts a SetWorkspaceLimits payload with a byte-unit memory value", () => {
    const command: ProvisionerCommand<"SetWorkspaceLimits"> = {
      ...baseCommand,
      type: "SetWorkspaceLimits",
      payload: { memory: "512b" },
    };
    const result = validateProvisionerCommand(command);
    expect(result).toMatchObject({ ok: true });
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

  const validSha256Hex =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  it("accepts an ImportGoldenConfig command with a valid sha256Hex", () => {
    const command: ProvisionerCommand<"ImportGoldenConfig"> = {
      ...baseCommand,
      type: "ImportGoldenConfig",
      payload: { sha256Hex: validSha256Hex },
    };
    const result = validateProvisionerCommand(command);
    expect(result).toMatchObject({ ok: true });
  });

  it("accepts an uppercase sha256Hex", () => {
    const command: ProvisionerCommand<"ImportGoldenConfig"> = {
      ...baseCommand,
      type: "ImportGoldenConfig",
      payload: { sha256Hex: validSha256Hex.toUpperCase() },
    };
    const result = validateProvisionerCommand(command);
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects an ImportGoldenConfig payload missing sha256Hex", () => {
    const command = {
      ...baseCommand,
      type: "ImportGoldenConfig",
      payload: {},
    };
    const result = validateProvisionerCommand(command);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("rejects an ImportGoldenConfig payload with a malformed sha256Hex", () => {
    const command = {
      ...baseCommand,
      type: "ImportGoldenConfig",
      payload: { sha256Hex: "not-a-hash" },
    };
    const result = validateProvisionerCommand(command);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("rejects an ImportGoldenConfig payload with unsupported fields", () => {
    const command = {
      ...baseCommand,
      type: "ImportGoldenConfig",
      payload: { sha256Hex: validSha256Hex, stagedPath: "/etc/passwd" },
    };
    const result = validateProvisionerCommand(command);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("accepts a valid ImportGoldenConfig operation result", () => {
    const operation: ProvisionerOperation<"ImportGoldenConfig"> = {
      id: "op-golden-1",
      requestId: "req-golden-1",
      type: "ImportGoldenConfig",
      workspaceId: "workspace-1",
      status: "succeeded",
      result: {
        workspaceId: "workspace-1",
        extractedAt: new Date().toISOString(),
        fileCount: 721,
        warnings: [],
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
      "ImportGoldenConfig",
    );
    expect(validated).toMatchObject({ ok: true });
  });

  it("rejects an ImportGoldenConfig operation result with a mismatched workspace", () => {
    const operation: ProvisionerOperation<"ImportGoldenConfig"> = {
      id: "op-golden-2",
      requestId: "req-golden-2",
      type: "ImportGoldenConfig",
      workspaceId: "workspace-1",
      status: "succeeded",
      result: {
        workspaceId: "some-other-workspace",
        extractedAt: new Date().toISOString(),
        fileCount: 1,
        warnings: [],
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
      "ImportGoldenConfig",
    );
    expect(validated).toMatchObject({
      ok: false,
      error: { code: "metadata_mismatch" },
    });
  });
});
