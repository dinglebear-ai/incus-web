import type {
  ActorContext,
  WorkspaceInventory,
} from "@/lib/workspaces/types";
import {
  PROVISIONER_CONTRACT_VERSION,
  isProvisionerCommandType,
  type ProvisionerCommand,
  type ProvisionerCommandType,
  type ProvisionerError,
  type ProvisionerOperation,
  type ProvisionerWorkspaceRef,
  validateProvisionerOperation,
} from "@/lib/provisioner/contracts";
import {
  createStaticPrototypeStatusClient,
  type ProvisionerClient,
} from "@/lib/provisioner/client";
import {
  createHostProvisionerClient,
  hostProvisionerConfigFromEnv,
} from "@/lib/provisioner/host-transport";
import {
  buildPrototypeWorkspaceRef,
  prototypeRuntimeStatus,
  statusToWorkspace,
} from "@/lib/provisioner/status-adapter";

type ConfiguredOwner = {
  userId: string;
  email?: string;
};

function configuredOwner(actor: ActorContext): ConfiguredOwner | undefined {
  const subject = process.env.INCUS_WEB_WORKSPACE_OWNER_SUBJECT?.trim();
  if (subject) return { userId: `oidc:${subject}` };

  const email = process.env.INCUS_WEB_WORKSPACE_OWNER_EMAIL?.trim();
  if (email) return { userId: `oidc:${email}`, email: email.toLowerCase() };

  const ownerMode = process.env.INCUS_WEB_WORKSPACE_OWNER_MODE ?? "none";
  if (ownerMode === "authenticated") {
    if (process.env.INCUS_WEB_ALLOW_SHARED_PROTOTYPE !== "1") {
      throw new Error(
        "INCUS_WEB_WORKSPACE_OWNER_MODE=authenticated requires INCUS_WEB_ALLOW_SHARED_PROTOTYPE=1",
      );
    }
    return {
      userId: actor.userId,
      email: actor.email.toLowerCase(),
    };
  }
  if (ownerMode === "none") {
    return undefined;
  }

  throw new Error(
    "INCUS_WEB_WORKSPACE_OWNER_MODE must be authenticated or none",
  );
}

function actorMatchesOwner(actor: ActorContext, owner: ConfiguredOwner) {
  return (
    actor.userId === owner.userId ||
    (owner.email !== undefined && actor.email.toLowerCase() === owner.email)
  );
}

function defaultProvisionerClient(ownerUserId: string): ProvisionerClient {
  let workspace;
  try {
    workspace = buildPrototypeWorkspaceRef(ownerUserId);
  } catch (error) {
    return failedProvisionerClient(
      "invalid_input",
      error instanceof Error ? error.message : "invalid workspace metadata",
      "unknown",
    );
  }
  const mode = process.env.INCUS_WEB_PROVISIONER_MODE ?? "host-local";
  if (mode === "prototype-static") {
    if (process.env.NODE_ENV === "production") {
      return failedProvisionerClient(
        "invalid_state",
        "prototype-static provisioner mode is not allowed in production",
        workspace.id,
      );
    }
    try {
      return createStaticPrototypeStatusClient(prototypeRuntimeStatus(workspace));
    } catch (error) {
      return failedProvisionerClient(
        "invalid_input",
        error instanceof Error ? error.message : "invalid prototype config",
        workspace.id,
      );
    }
  }
  if (mode !== "host-local") {
    return failedProvisionerClient(
      "invalid_input",
      `unsupported provisioner mode: ${mode}`,
      workspace.id,
    );
  }

  try {
    const config = hostProvisionerConfigFromEnv();
    if (config) {
      return createHostProvisionerClient(config);
    }
  } catch (error) {
    return failedProvisionerClient(
      "invalid_input",
      error instanceof Error ? error.message : "invalid host provisioner config",
      workspace.id,
    );
  }

  return failedProvisionerClient(
    "unauthenticated_service",
    "host provisioner transport is not configured",
    workspace.id,
  );
}

function ownerForActor(actor: ActorContext) {
  const owner = configuredOwner(actor);
  if (!owner || !actorMatchesOwner(actor, owner)) {
    return undefined;
  }
  return owner;
}

function commandActor(actor: ActorContext) {
  return {
    userId: actor.userId,
    oidcSubject: actor.oidcSubject,
    email: actor.email,
    displayName: actor.displayName,
  };
}

function commandFor<TType extends ProvisionerCommandType>(
  type: TType,
  actor: ActorContext,
  ownerUserId: string,
  payload: ProvisionerCommand<TType>["payload"],
): ProvisionerCommand<TType> {
  return {
    version: PROVISIONER_CONTRACT_VERSION,
    requestId: actor.requestId,
    type,
    actor: commandActor(actor),
    workspace: buildPrototypeWorkspaceRef(ownerUserId),
    payload,
  } as ProvisionerCommand<TType>;
}

export function getWorkspaceRefForActor(
  actor: ActorContext,
):
  | { ok: true; workspace: ProvisionerWorkspaceRef }
  | { ok: false; error: ProvisionerError } {
  let owner;
  try {
    owner = ownerForActor(actor);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message:
          error instanceof Error ? error.message : "invalid workspace owner config",
        retryable: false,
      },
    };
  }
  if (!owner) {
    return {
      ok: false,
      error: {
        code: "unauthenticated_service",
        message: "authenticated actor is not assigned to this workspace",
        retryable: false,
      },
    };
  }
  try {
    return {
      ok: true,
      workspace: buildPrototypeWorkspaceRef(owner.userId),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: error instanceof Error ? error.message : "invalid workspace metadata",
        retryable: false,
      },
    };
  }
}

// Intentionally empty today: no mutating (resource-limit/mount) command type
// exists yet in PROVISIONER_COMMAND_TYPES (contracts.ts). This registry and
// the routing in sendWorkspaceCommand below exist so that when one is added
// (e.g. SetWorkspaceLimits), registering it here is the ONLY step required —
// it cannot be added to the command dispatcher without also going through
// getMutableWorkspaceRefForActor. This does not restrict existing lifecycle
// commands (Start/Stop/RestartWorkspace); those intentionally remain
// available to any actor getWorkspaceRefForActor authorizes, per the
// existing shared-prototype-mode design.
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

export async function getWorkspaceInventory(
  actor: ActorContext,
  client?: ProvisionerClient,
): Promise<WorkspaceInventory> {
  let owner;
  try {
    owner = ownerForActor(actor);
  } catch (error) {
    return inventoryFailure(actor, "unknown", actor.requestId, {
      code: "invalid_input",
      message:
        error instanceof Error ? error.message : "invalid workspace owner config",
      retryable: false,
    });
  }
  if (!owner) {
    return { actor, workspaces: [] };
  }

  let workspace;
  try {
    workspace = buildPrototypeWorkspaceRef(owner.userId);
  } catch (error) {
    return inventoryFailure(actor, "unknown", actor.requestId, {
      code: "invalid_input",
      message: error instanceof Error ? error.message : "invalid workspace metadata",
      retryable: false,
    });
  }
  const provisioner = client ?? defaultProvisionerClient(owner.userId);
  const command = commandFor("GetWorkspaceStatus", actor, owner.userId, {});
  const operation = await provisioner.send(command);

  const validated = validateProvisionerOperation(
    operation,
    workspace,
    "GetWorkspaceStatus",
  );
  if (!validated.ok) {
    return inventoryFailure(actor, workspace.id, command.requestId, validated.error);
  }
  if (validated.value.status !== "succeeded") {
    return inventoryFailure(
      actor,
      workspace.id,
      validated.value.requestId,
      validated.value.error ?? {
        code: "invalid_state",
        message: `provisioner operation is ${validated.value.status}`,
        retryable: true,
      },
      validated.value.id,
    );
  }
  if (!validated.value.result) {
    return inventoryFailure(actor, workspace.id, validated.value.requestId, {
      code: "invalid_state",
      message: "provisioner succeeded without a workspace status result",
      retryable: false,
    });
  }

  try {
    return {
      actor,
      workspaces: [statusToWorkspace(validated.value.result, owner.userId)],
    };
  } catch (error) {
    return inventoryFailure(
      actor,
      workspace.id,
      validated.value.requestId,
      {
        code: "invalid_input",
        message:
          error instanceof Error ? error.message : "invalid workspace dashboard config",
        retryable: false,
      },
      validated.value.id,
    );
  }
}

function failedProvisionerClient(
  code: ProvisionerError["code"],
  message: string,
  workspaceId: string,
): ProvisionerClient {
  return {
    async send(command) {
      const context = provisionerCommandContext(command);
      return {
        id: `failed-${context.requestId}`,
        requestId: context.requestId,
        type: context.type,
        workspaceId,
        status: "failed",
        error: {
          code,
          message,
          retryable: false,
        },
        completedAt: new Date().toISOString(),
      };
    },
  };
}

function inventoryFailure(
  actor: ActorContext,
  workspaceId: string,
  requestId: string,
  error: ProvisionerError,
  operationId?: string,
): WorkspaceInventory {
  console.warn("workspace provisioner failed", {
    requestId,
    actor: actor.userId,
    workspaceId,
    operationId,
    code: error.code,
  });
  return {
    actor,
    workspaces: [],
    provisionerError: {
      code: error.code,
      message: error.message,
      requestId,
      workspaceId,
      operationId,
    },
  };
}

function failedCommandOperation<TType extends ProvisionerCommandType>(
  actor: ActorContext,
  type: TType,
  workspaceId: string,
  error: ProvisionerError,
): ProvisionerOperation<TType> {
  return {
    id: `failed-${actor.requestId}`,
    requestId: actor.requestId,
    type,
    workspaceId,
    status: "failed",
    error,
    completedAt: new Date().toISOString(),
  } as ProvisionerOperation<TType>;
}

function provisionerCommandContext(command: unknown) {
  if (typeof command !== "object" || command === null) {
    return {
      requestId: "unknown",
      type: "GetWorkspaceStatus" as const,
    };
  }
  return {
    requestId:
      "requestId" in command && typeof command.requestId === "string"
        ? command.requestId
        : "unknown",
    type:
      "type" in command && isProvisionerCommandType(command.type)
        ? command.type
        : "GetWorkspaceStatus",
  };
}
