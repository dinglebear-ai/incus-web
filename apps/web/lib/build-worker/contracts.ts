export const BUILD_WORKER_CONTRACT_VERSION = "build-worker.v1" as const;

export const BUILD_WORKER_COMMAND_TYPES = [
  "DispatchBuildImage",
  "GetBuildStatus",
  "ListBuildImages",
  "SetBuildImageMaster",
  "ListBuildPresets",
  "SaveBuildPreset",
] as const;

export type BuildWorkerCommandType = (typeof BUILD_WORKER_COMMAND_TYPES)[number];
export type BuildStatus = "queued" | "running" | "succeeded" | "failed";

export type BuildCommandActor = {
  userId: string;
  email: string;
  displayName?: string;
};

export type BuilderPreset = {
  id: string;
  ownerUserId: string;
  name: string;
  distro: string;
  release: string;
  packages: string[];
  postInstallCommands: string[];
  updatedAt: string;
};

export type BuiltImageRecord = {
  imageAlias: string;
  ownerUserId: string;
  buildId: string;
  distro: string;
  release: string;
  basedOn?: string;
  isMaster: boolean;
  createdAt: string;
};

export type DispatchBuildImagePayload = {
  distro: string;
  release: string;
  packages: string[];
  postInstallCommands: string[];
  definitionYaml: string;
  imageAlias: string;
  idempotencyKey: string;
  basedOn?: string;
};

export type DispatchBuildImageResult = {
  buildId: string;
};

export type GetBuildStatusPayload = {
  buildId: string;
  logOffset: number;
};

export type GetBuildStatusResult = {
  buildId: string;
  status: BuildStatus;
  imageAlias: string;
  logOffset: number;
  logChunk: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

export type ListBuildImagesPayload = Record<string, never>;
export type ListBuildImagesResult = {
  images: BuiltImageRecord[];
};

export type SetBuildImageMasterPayload = {
  imageAlias: string;
};
export type SetBuildImageMasterResult = {
  imageAlias: string;
};

export type ListBuildPresetsPayload = Record<string, never>;
export type ListBuildPresetsResult = {
  presets: BuilderPreset[];
};

export type SaveBuildPresetPayload = {
  name: string;
  distro: string;
  release: string;
  packages: string[];
  postInstallCommands: string[];
};
export type SaveBuildPresetResult = {
  preset: BuilderPreset;
};

const DISPATCH_KEYS = [
  "distro",
  "release",
  "packages",
  "postInstallCommands",
  "definitionYaml",
  "imageAlias",
  "idempotencyKey",
  "basedOn",
] as const;
const SAVE_PRESET_KEYS = ["name", "distro", "release", "packages", "postInstallCommands"] as const;

export type BuildWorkerPayloadMap = {
  DispatchBuildImage: DispatchBuildImagePayload;
  GetBuildStatus: GetBuildStatusPayload;
  ListBuildImages: ListBuildImagesPayload;
  SetBuildImageMaster: SetBuildImageMasterPayload;
  ListBuildPresets: ListBuildPresetsPayload;
  SaveBuildPreset: SaveBuildPresetPayload;
};

export type BuildWorkerResultMap = {
  DispatchBuildImage: DispatchBuildImageResult;
  GetBuildStatus: GetBuildStatusResult;
  ListBuildImages: ListBuildImagesResult;
  SetBuildImageMaster: SetBuildImageMasterResult;
  ListBuildPresets: ListBuildPresetsResult;
  SaveBuildPreset: SaveBuildPresetResult;
};

export type BuildWorkerCommand<TType extends BuildWorkerCommandType = BuildWorkerCommandType> = {
  [K in TType]: {
    version: typeof BUILD_WORKER_CONTRACT_VERSION;
    requestId: string;
    type: K;
    actor: BuildCommandActor;
    payload: BuildWorkerPayloadMap[K];
  };
}[TType];

export type BuildWorkerOperation<TType extends BuildWorkerCommandType = BuildWorkerCommandType> = {
  [K in TType]: {
    id: string;
    requestId: string;
    type: K;
    status: "succeeded" | "failed";
    result?: BuildWorkerResultMap[K];
    error?: {
      code: "invalid_input" | "unauthenticated_service" | "operation_failed" | "not_found";
      message: string;
      retryable: boolean;
    };
    completedAt: string;
  };
}[TType];

export function isBuildWorkerCommandType(value: unknown): value is BuildWorkerCommandType {
  return (
    typeof value === "string" &&
    BUILD_WORKER_COMMAND_TYPES.includes(value as BuildWorkerCommandType)
  );
}

export function validateBuildWorkerCommand(
  command: unknown,
): { ok: true; value: BuildWorkerCommand } | { ok: false; message: string } {
  if (!isRecord(command)) return { ok: false, message: "command must be an object" };
  if (command.version !== BUILD_WORKER_CONTRACT_VERSION) {
    return { ok: false, message: "unsupported build worker contract version" };
  }
  if (!isBuildWorkerCommandType(command.type)) {
    return { ok: false, message: "unsupported build worker command type" };
  }
  if (typeof command.requestId !== "string" || command.requestId.length === 0) {
    return { ok: false, message: "requestId is required" };
  }
  if (
    !isRecord(command.actor) ||
    typeof command.actor.userId !== "string" ||
    typeof command.actor.email !== "string"
  ) {
    return { ok: false, message: "actor is invalid" };
  }
  if (!isRecord(command.payload)) return { ok: false, message: "payload must be an object" };

  switch (command.type) {
    case "DispatchBuildImage":
      return validateDispatch(command);
    case "GetBuildStatus":
      return validateGetStatus(command);
    case "SetBuildImageMaster":
      return validateSetMaster(command);
    case "SaveBuildPreset":
      return validateSavePreset(command);
    case "ListBuildImages":
    case "ListBuildPresets":
      return hasOnlyKeys(command.payload, [])
        ? { ok: true, value: command as BuildWorkerCommand }
        : { ok: false, message: "payload contains unsupported fields" };
  }
}

function validateDispatch(command: Record<string, unknown>) {
  const payload = command.payload as Record<string, unknown>;
  if (!hasOnlyKeys(payload, DISPATCH_KEYS)) {
    return { ok: false as const, message: "DispatchBuildImage payload contains unsupported fields" };
  }
  if (
    !stringValue(payload.distro, 40) ||
    !stringValue(payload.release, 80) ||
    !stringValue(payload.definitionYaml, 200_000) ||
    !stringValue(payload.imageAlias, 120) ||
    !stringValue(payload.idempotencyKey, 160) ||
    !arrayOfStrings(payload.packages, 200, 100) ||
    !arrayOfStrings(payload.postInstallCommands, 50, 20_000) ||
    (payload.basedOn !== undefined && !stringValue(payload.basedOn, 120))
  ) {
    return { ok: false as const, message: "DispatchBuildImage payload is invalid" };
  }
  return { ok: true as const, value: command as unknown as BuildWorkerCommand };
}

function validateGetStatus(command: Record<string, unknown>) {
  const payload = command.payload as Record<string, unknown>;
  if (!hasOnlyKeys(payload, ["buildId", "logOffset"])) {
    return { ok: false as const, message: "GetBuildStatus payload contains unsupported fields" };
  }
  if (
    !stringValue(payload.buildId, 80) ||
    typeof payload.logOffset !== "number" ||
    !Number.isInteger(payload.logOffset) ||
    payload.logOffset < 0
  ) {
    return { ok: false as const, message: "GetBuildStatus payload is invalid" };
  }
  return { ok: true as const, value: command as unknown as BuildWorkerCommand };
}

function validateSetMaster(command: Record<string, unknown>) {
  const payload = command.payload as Record<string, unknown>;
  if (!hasOnlyKeys(payload, ["imageAlias"]) || !stringValue(payload.imageAlias, 120)) {
    return { ok: false as const, message: "SetBuildImageMaster payload is invalid" };
  }
  return { ok: true as const, value: command as unknown as BuildWorkerCommand };
}

function validateSavePreset(command: Record<string, unknown>) {
  const payload = command.payload as Record<string, unknown>;
  if (
    !hasOnlyKeys(payload, SAVE_PRESET_KEYS) ||
    !stringValue(payload.name, 80) ||
    !stringValue(payload.distro, 40) ||
    !stringValue(payload.release, 80) ||
    !arrayOfStrings(payload.packages, 200, 100) ||
    !arrayOfStrings(payload.postInstallCommands, 50, 20_000)
  ) {
    return { ok: false as const, message: "SaveBuildPreset payload is invalid" };
  }
  return { ok: true as const, value: command as unknown as BuildWorkerCommand };
}

function stringValue(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function arrayOfStrings(value: unknown, maxItems: number, maxLength: number) {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((entry) => typeof entry === "string" && entry.length <= maxLength)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
