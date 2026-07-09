import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import { createStaticPrototypeStatusClient } from "@/lib/provisioner/client";
import {
  PROVISIONER_COMMAND_TYPES,
  PROVISIONER_CONTRACT_VERSION,
  type LifecycleWorkspaceResult,
  type WorkspaceRuntimeStatus,
} from "@/lib/provisioner/contracts";
import {
  getMutableWorkspaceRefForActor,
  getWorkspaceRefForActor,
  getWorkspaceInventory,
  isMutatingCommandType,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";

const ownerEmail = "owner@example.com";
const ownerSubject = "owner-subject";

function authHeaders({
  email = ownerEmail,
  subject = ownerSubject,
  displayName,
  requestId,
}: {
  email?: string;
  subject?: string | null;
  displayName?: string;
  requestId?: string;
} = {}) {
  const headers = new Headers({ "x-auth-request-email": email });
  if (subject) headers.set("x-auth-request-subject", subject);
  if (displayName) {
    headers.set("x-auth-request-preferred-username", displayName);
  }
  if (requestId) headers.set("x-request-id", requestId);
  return headers;
}

function ownerActor() {
  return getActorFromHeaders(authHeaders());
}

function useOwnerEmail() {
  vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_EMAIL", ownerEmail);
}

function useOwnerSubject() {
  vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_SUBJECT", ownerSubject);
}

function usePrototypeStaticMode() {
  vi.stubEnv("INCUS_WEB_PROVISIONER_MODE", "prototype-static");
}

describe("workspace inventory provisioner", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses Authelia/oauth2-proxy identity headers", () => {
    const actor = getActorFromHeaders(
      authHeaders({
        email: "jmagar@example.com",
        subject: "authelia-user-id",
        displayName: "Jacob",
        requestId: "req-123",
      }),
    );

    expect(actor.email).toBe("jmagar@example.com");
    expect(actor.displayName).toBe("Jacob");
    expect(actor.oidcSubject).toBe("authelia-user-id");
    expect(actor.requestId).toBe("req-123");
  });

  it("parses SWAG Authelia Remote-* identity headers", () => {
    const actor = getActorFromHeaders(
      new Headers({
        "remote-email": "jmagar@example.com",
        "remote-name": "Jacob Magar",
        "remote-user": "jmagar",
        "x-request-id": "req-swag",
      }),
    );

    expect(actor.email).toBe("jmagar@example.com");
    expect(actor.displayName).toBe("Jacob Magar");
    expect(actor.oidcSubject).toBe("jmagar");
    expect(actor.userId).toBe("oidc:jmagar");
    expect(actor.requestId).toBe("req-swag");
  });

  it("uses remote-user as the display name when SWAG omits remote-name", () => {
    const actor = getActorFromHeaders(
      new Headers({
        "remote-email": "jmagar@example.com",
        "remote-user": "jmagar",
      }),
    );

    expect(actor.displayName).toBe("jmagar");
    expect(actor.oidcSubject).toBe("jmagar");
    expect(actor.userId).toBe("oidc:jmagar");
  });

  it("requires the trusted proxy secret when configured", () => {
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "proxy-secret");

    expect(() =>
      getActorFromHeaders(
        new Headers({
          "remote-email": "jmagar@example.com",
          "remote-user": "jmagar",
        }),
      ),
    ).toThrow(AuthenticationRequiredError);

    const actor = getActorFromHeaders(
      new Headers({
        "remote-email": "jmagar@example.com",
        "remote-user": "jmagar",
        "x-incus-web-proxy-secret": "proxy-secret",
      }),
    );

    expect(actor.userId).toBe("oidc:jmagar");
  });

  it("falls back to a local development actor without headers", () => {
    vi.stubEnv("INCUS_WEB_ALLOW_DEV_AUTH", "1");
    const actor = getActorFromHeaders(new Headers());

    expect(actor.email).toBe("dev@incus-web.local");
    expect(actor.displayName).toBe("dev@incus-web.local");
    expect(actor.userId).toBe("oidc:dev@incus-web.local");
  });

  it("fails closed without identity headers when dev auth is not enabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INCUS_WEB_ALLOW_DEV_AUTH", "");
    // Isolate the "no identity headers" case from the separate
    // trusted-proxy-secret requirement by satisfying that check explicitly.
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");

    expect(() =>
      getActorFromHeaders(new Headers({ "x-incus-web-proxy-secret": "shh" })),
    ).toThrow(AuthenticationRequiredError);
  });

  it("returns the current incus-web workspace read-only inventory", async () => {
    useOwnerEmail();
    usePrototypeStaticMode();
    const actor = getActorFromHeaders(
      authHeaders({ subject: "authelia-user-id" }),
    );
    const inventory = await getWorkspaceInventory(actor);

    expect(inventory.actor.email).toBe(ownerEmail);
    expect(inventory.actor.userId).toBe("oidc:authelia-user-id");
    expect(inventory.workspaces).toHaveLength(1);
    expect(inventory.workspaces[0]).toMatchObject({
      name: "incus-web",
      incusProject: "default",
      incusContainer: "incus-web",
      state: "running",
      ownerUserId: "oidc:owner@example.com",
    });
    expect(inventory.workspaces[0]?.terminalUrl).toBeUndefined();
    expect(inventory.workspaces[0]?.setup).toMatchObject({
      phase: "ready",
      commandStatus: "ok",
      packageStatus: "ok",
      miseStatus: "ok",
      dotfilesStatus: "ok",
    });
  });

  it("matches a configured owner subject when present", async () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_SUBJECT", "authelia-user-id");
    usePrototypeStaticMode();
    const actor = getActorFromHeaders(
      authHeaders({ subject: "authelia-user-id" }),
    );
    const inventory = await getWorkspaceInventory(actor);

    expect(inventory.workspaces).toHaveLength(1);
    expect(inventory.workspaces[0]?.ownerUserId).toBe("oidc:authelia-user-id");
  });

  it("uses provisioner status when rendering the owner workspace", async () => {
    useOwnerEmail();
    const actor = ownerActor();
    const status: WorkspaceRuntimeStatus = {
      workspaceId: "workspace-incus-web",
      state: "running",
      incusProject: "default",
      incusContainer: "incus-web",
      cpuCount: 4,
      memoryLimitBytes: 8 * 1024 * 1024 * 1024,
      rootDiskLimitBytes: 40 * 1024 * 1024 * 1024,
      setupPhase: "ready",
      lastCheckedAt: "2026-07-01T00:00:00.000Z",
    };

    const inventory = await getWorkspaceInventory(
      actor,
      createStaticPrototypeStatusClient(status),
    );

    expect(inventory.workspaces[0]).toMatchObject({
      incusProject: "default",
      incusContainer: "incus-web",
      resources: {
        cpu: "4 vCPU",
        memory: "8 GiB",
        storage: "40 GiB",
      },
    });
  });

  it("sends the expected status command to the provisioner", async () => {
    useOwnerEmail();
    const actor = getActorFromHeaders(
      authHeaders({
        subject: "authelia-user-id",
        displayName: "Owner",
        requestId: "req-command",
      }),
    );
    const status: WorkspaceRuntimeStatus = {
      workspaceId: "workspace-incus-web",
      state: "running",
      incusProject: "default",
      incusContainer: "incus-web",
      lastCheckedAt: "2026-07-01T00:00:00.000Z",
    };
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-1",
        requestId: "req-command",
        type: "GetWorkspaceStatus",
        workspaceId: "workspace-incus-web",
        status: "succeeded",
        result: status,
      }),
    };

    await getWorkspaceInventory(actor, client);

    expect(client.send).toHaveBeenCalledWith({
      version: PROVISIONER_CONTRACT_VERSION,
      requestId: "req-command",
      type: "GetWorkspaceStatus",
      actor: {
        userId: "oidc:authelia-user-id",
        oidcSubject: "authelia-user-id",
        email: ownerEmail,
        displayName: "Owner",
      },
      workspace: {
        id: "workspace-incus-web",
        ownerUserId: "oidc:owner@example.com",
        incusProject: "default",
        incusContainer: "incus-web",
      },
      payload: {},
    });
  });

  it("sends owner lifecycle commands to the provisioner", async () => {
    useOwnerEmail();
    const actor = getActorFromHeaders(
      authHeaders({
        subject: "authelia-user-id",
        displayName: "Owner",
        requestId: "req-restart",
      }),
    );
    const result: LifecycleWorkspaceResult = {
      workspaceId: "workspace-incus-web",
      state: "running",
      status: {
        workspaceId: "workspace-incus-web",
        state: "running",
        incusProject: "default",
        incusContainer: "incus-web",
        lastCheckedAt: "2026-07-01T00:00:00.000Z",
      },
    };
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-restart",
        requestId: "req-restart",
        type: "RestartWorkspace",
        workspaceId: "workspace-incus-web",
        status: "succeeded",
        result,
      }),
    };

    const operation = await sendWorkspaceCommand(
      actor,
      "RestartWorkspace",
      { timeoutSeconds: 30 },
      client,
    );

    expect(operation.status).toBe("succeeded");
    expect(client.send).toHaveBeenCalledWith({
      version: PROVISIONER_CONTRACT_VERSION,
      requestId: "req-restart",
      type: "RestartWorkspace",
      actor: {
        userId: "oidc:authelia-user-id",
        oidcSubject: "authelia-user-id",
        email: ownerEmail,
        displayName: "Owner",
      },
      workspace: {
        id: "workspace-incus-web",
        ownerUserId: "oidc:owner@example.com",
        incusProject: "default",
        incusContainer: "incus-web",
      },
      payload: { timeoutSeconds: 30 },
    });
  });

  it("resolves the authorized workspace before action dispatch", () => {
    useOwnerEmail();
    const actor = ownerActor();

    expect(getWorkspaceRefForActor(actor)).toMatchObject({
      ok: true,
      workspace: {
        id: "workspace-incus-web",
        ownerUserId: "oidc:owner@example.com",
        incusProject: "default",
        incusContainer: "incus-web",
      },
    });
  });

  it("does not resolve a workspace ref for non-owners", () => {
    useOwnerEmail();
    const actor = getActorFromHeaders(
      authHeaders({ email: "other@example.com", subject: null }),
    );

    expect(getWorkspaceRefForActor(actor)).toMatchObject({
      ok: false,
      error: {
        code: "unauthenticated_service",
      },
    });
  });

  it("does not send lifecycle commands for non-owners", async () => {
    useOwnerEmail();
    const actor = getActorFromHeaders(
      authHeaders({ email: "other@example.com", subject: null }),
    );
    const client = {
      send: vi.fn(),
    };

    const operation = await sendWorkspaceCommand(
      actor,
      "StopWorkspace",
      { force: false, timeoutSeconds: 30 },
      client,
    );

    expect(client.send).not.toHaveBeenCalled();
    expect(operation).toMatchObject({
      type: "StopWorkspace",
      workspaceId: "unknown",
      status: "failed",
      error: {
        code: "unauthenticated_service",
        message: "authenticated actor is not assigned to this workspace",
      },
    });
  });

  it("uses configured host workspace metadata in provisioner commands", async () => {
    useOwnerSubject();
    vi.stubEnv("INCUS_WEB_WORKSPACE_ID", "workspace-custom");
    vi.stubEnv("INCUS_WEB_INCUS_PROJECT", "user-custom");
    vi.stubEnv("INCUS_WEB_INCUS_CONTAINER", "ws-custom");
    const actor = ownerActor();
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-custom",
        requestId: actor.requestId,
        type: "GetWorkspaceStatus",
        workspaceId: "workspace-custom",
        status: "succeeded",
        result: {
          workspaceId: "workspace-custom",
          state: "running",
          incusProject: "user-custom",
          incusContainer: "ws-custom",
          lastCheckedAt: "2026-07-01T00:00:00.000Z",
        },
      }),
    };

    await getWorkspaceInventory(actor, client);

    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: {
          id: "workspace-custom",
          ownerUserId: "oidc:owner-subject",
          incusProject: "user-custom",
          incusContainer: "ws-custom",
        },
      }),
    );
  });

  it("does not call provisioner for non-owners", async () => {
    useOwnerEmail();
    const actor = getActorFromHeaders(
      authHeaders({ email: "other@example.com", subject: null }),
    );
    const client = {
      send: vi.fn(),
    };

    const inventory = await getWorkspaceInventory(actor, client);

    expect(client.send).not.toHaveBeenCalled();
    expect(inventory.workspaces).toHaveLength(0);
  });

  it("requires explicit authenticated owner mode for actor-scoped prototype ownership", async () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "authenticated");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_PROTOTYPE", "1");
    usePrototypeStaticMode();
    const actor = getActorFromHeaders(
      authHeaders({ email: "jacob@example.com", subject: "jacob" }),
    );

    const inventory = await getWorkspaceInventory(actor);

    expect(inventory.workspaces).toHaveLength(1);
    expect(inventory.workspaces[0]?.ownerUserId).toBe("oidc:jacob");
  });

  it("rejects authenticated owner mode without the shared prototype opt-in", async () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "authenticated");
    usePrototypeStaticMode();
    const actor = getActorFromHeaders(
      authHeaders({ email: "jacob@example.com", subject: "jacob" }),
    );

    const inventory = await getWorkspaceInventory(actor);

    expect(inventory.workspaces).toHaveLength(0);
    expect(inventory.provisionerError).toMatchObject({
      code: "invalid_input",
      message:
        "INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated requires INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1",
      workspaceId: "unknown",
    });
  });

  it("does not implicitly assign the imported prototype to any signed-in actor", async () => {
    usePrototypeStaticMode();
    const actor = ownerActor();

    const inventory = await getWorkspaceInventory(actor);

    expect(inventory.workspaces).toHaveLength(0);
  });

  it("surfaces invalid owner mode as a configuration error", async () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "typo");
    const actor = ownerActor();
    const client = {
      send: vi.fn(),
    };

    const inventory = await getWorkspaceInventory(actor, client);

    expect(client.send).not.toHaveBeenCalled();
    expect(inventory.workspaces).toHaveLength(0);
    expect(inventory.provisionerError).toMatchObject({
      code: "invalid_input",
      message: "INCUS_WEB_WORKSPACE_OWNER_MODE must be authenticated or none",
      workspaceId: "unknown",
    });
  });

  it("returns no workspace when provisioner status fails", async () => {
    useOwnerSubject();
    const actor = ownerActor();
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-1",
        requestId: "req-1",
        type: "GetWorkspaceStatus",
        workspaceId: "workspace-incus-web",
        status: "failed",
        error: {
          code: "incus_unavailable",
          message: "raw /home/agent/.local path should not be rendered",
          retryable: true,
        },
      }),
    };

    const inventory = await getWorkspaceInventory(actor, client);

    expect(inventory.workspaces).toHaveLength(0);
    expect(inventory.provisionerError).toMatchObject({
      code: "incus_unavailable",
      requestId: "req-1",
      workspaceId: "workspace-incus-web",
      operationId: "op-1",
    });
  });

  it("returns no workspace when provisioner status tuple is mismatched", async () => {
    useOwnerSubject();
    const actor = ownerActor();
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-1",
        requestId: "req-1",
        type: "GetWorkspaceStatus",
        workspaceId: "workspace-incus-web",
        status: "succeeded",
        result: {
          workspaceId: "workspace-other",
          state: "running",
          incusProject: "user-other",
          incusContainer: "ws-other",
          lastCheckedAt: "2026-07-01T00:00:00.000Z",
        },
      }),
    };

    const inventory = await getWorkspaceInventory(actor, client);

    expect(inventory.workspaces).toHaveLength(0);
    expect(inventory.provisionerError).toMatchObject({
      code: "metadata_mismatch",
      requestId: actor.requestId,
      workspaceId: "workspace-incus-web",
    });
  });

  it("returns no workspace when provisioner status result is malformed", async () => {
    useOwnerSubject();
    const actor = ownerActor();
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-1",
        requestId: "req-1",
        type: "GetWorkspaceStatus",
        workspaceId: "workspace-incus-web",
        status: "succeeded",
        result: {
          workspaceId: "workspace-incus-web",
          state: "running",
        },
      }),
    };

    const inventory = await getWorkspaceInventory(actor, client);

    expect(inventory.workspaces).toHaveLength(0);
    expect(inventory.provisionerError).toMatchObject({
      code: "metadata_mismatch",
      requestId: actor.requestId,
      workspaceId: "workspace-incus-web",
    });
  });

  it("surfaces static prototype mode as a production configuration error", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Not exercising the identity trust model here -- opt out of its
    // separate production requirement so this test stays focused.
    vi.stubEnv("INCUS_WEB_ALLOW_DEV_AUTH", "1");
    useOwnerSubject();
    usePrototypeStaticMode();
    const actor = ownerActor();

    const inventory = await getWorkspaceInventory(actor);

    expect(inventory.workspaces).toHaveLength(0);
    expect(inventory.provisionerError).toMatchObject({
      code: "invalid_state",
      message: "prototype-static provisioner mode is not allowed in production",
      workspaceId: "workspace-incus-web",
    });
  });

  it("surfaces invalid prototype resource configuration", async () => {
    useOwnerSubject();
    usePrototypeStaticMode();
    vi.stubEnv("INCUS_WEB_PROTOTYPE_CPU", "nope");
    const actor = ownerActor();

    const inventory = await getWorkspaceInventory(actor);

    expect(inventory.workspaces).toHaveLength(0);
    expect(inventory.provisionerError).toMatchObject({
      code: "invalid_input",
      message: "INCUS_WEB_PROTOTYPE_CPU must be a positive number",
      workspaceId: "workspace-incus-web",
    });
  });

  it("surfaces invalid configured workspace metadata", async () => {
    useOwnerSubject();
    vi.stubEnv("INCUS_WEB_INCUS_CONTAINER", "../bad");
    const actor = ownerActor();

    const inventory = await getWorkspaceInventory(actor);

    expect(inventory.workspaces).toHaveLength(0);
    expect(inventory.provisionerError).toMatchObject({
      code: "invalid_input",
      message: "INCUS_WEB_INCUS_CONTAINER is invalid",
      workspaceId: "unknown",
    });
  });

  it("surfaces invalid dashboard URL config after provisioner success", async () => {
    useOwnerSubject();
    vi.stubEnv("INCUS_WEB_TERMINAL_URL", "javascript:alert(1)");
    const actor = ownerActor();
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-url",
        requestId: actor.requestId,
        type: "GetWorkspaceStatus",
        workspaceId: "workspace-incus-web",
        status: "succeeded",
        result: {
          workspaceId: "workspace-incus-web",
          state: "running",
          incusProject: "default",
          incusContainer: "incus-web",
          lastCheckedAt: "2026-07-01T00:00:00.000Z",
        },
      }),
    };

    const inventory = await getWorkspaceInventory(actor, client);

    expect(inventory.workspaces).toHaveLength(0);
    expect(inventory.provisionerError).toMatchObject({
      code: "invalid_input",
      message: "INCUS_WEB_TERMINAL_URL must be a relative path or http(s) URL",
      workspaceId: "workspace-incus-web",
      operationId: "op-url",
    });
  });

  it("uses authenticated ownership in production only when explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Not exercising the identity trust model here -- opt out of its
    // separate production requirement so this test stays focused.
    vi.stubEnv("INCUS_WEB_ALLOW_DEV_AUTH", "1");
    vi.stubEnv("INCUS_WEB_WORKSPACE_OWNER_MODE", "authenticated");
    vi.stubEnv("INCUS_WEB_ALLOW_SHARED_PROTOTYPE", "1");
    const actor = getActorFromHeaders(authHeaders({ subject: "owner-subject" }));
    const client = {
      send: vi.fn().mockResolvedValue({
        id: "op-prod",
        requestId: actor.requestId,
        type: "GetWorkspaceStatus",
        workspaceId: "workspace-incus-web",
        status: "succeeded",
        result: {
          workspaceId: "workspace-incus-web",
          state: "running",
          incusProject: "default",
          incusContainer: "incus-web",
          lastCheckedAt: "2026-07-01T00:00:00.000Z",
        },
      }),
    };

    const inventory = await getWorkspaceInventory(actor, client);

    expect(inventory.workspaces[0]?.ownerUserId).toBe("oidc:owner-subject");
  });

  it("does not expose the shared prototype workspace to another actor", async () => {
    useOwnerEmail();
    const actor = getActorFromHeaders(
      authHeaders({ email: "other@example.com", subject: null }),
    );
    const inventory = await getWorkspaceInventory(actor);

    expect(inventory.actor.email).toBe("other@example.com");
    expect(inventory.workspaces).toHaveLength(0);
  });

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
        workspaceId: "workspace-incus-web",
        status: "succeeded",
        result: {
          workspaceId: "workspace-incus-web",
          state: "stopped",
          status: {
            workspaceId: "workspace-incus-web",
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
});
