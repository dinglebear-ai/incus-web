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
const IMAGE_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,118}$/;

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

export function validateBuildWorkerOperation<TType extends BuildWorkerCommandType>(
  operation: unknown,
  command: BuildWorkerCommand<TType>,
): { ok: true; value: BuildWorkerOperation<TType> } | { ok: false; message: string } {
  if (!isRecord(operation)) return { ok: false, message: "operation must be an object" };
  if (
    typeof operation.id !== "string" ||
    operation.requestId !== command.requestId ||
    operation.type !== command.type ||
    typeof operation.completedAt !== "string" ||
    !isIsoTimestamp(operation.completedAt) ||
    (operation.status !== "succeeded" && operation.status !== "failed")
  ) {
    return { ok: false, message: "operation envelope is invalid" };
  }
  if (operation.status === "failed") {
    return isOperationError(operation.error)
      ? { ok: true, value: operation as BuildWorkerOperation<TType> }
      : { ok: false, message: "operation error is invalid" };
  }
  if (!validateResult(operation.result, command.type)) {
    return { ok: false, message: "operation result is invalid" };
  }
  return { ok: true, value: operation as BuildWorkerOperation<TType> };
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
    !isBuildImageAlias(payload.imageAlias) ||
    !stringValue(payload.idempotencyKey, 160) ||
    !arrayOfStrings(payload.packages, 200, 100) ||
    !arrayOfStrings(payload.postInstallCommands, 50, 20_000) ||
    (payload.basedOn !== undefined && !isBuildImageAlias(payload.basedOn))
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
  if (!hasOnlyKeys(payload, ["imageAlias"]) || !isBuildImageAlias(payload.imageAlias)) {
    return { ok: false as const, message: "SetBuildImageMaster payload is invalid" };
  }
  return { ok: true as const, value: command as unknown as BuildWorkerCommand };
}

export function isBuildImageAlias(value: unknown): value is string {
  return typeof value === "string" && IMAGE_ALIAS_PATTERN.test(value);
}

function validateResult(result: unknown, type: BuildWorkerCommandType) {
  if (!isRecord(result)) return false;
  switch (type) {
    case "DispatchBuildImage":
      return hasOnlyKeys(result, ["buildId"]) && stringValue(result.buildId, 80);
    case "GetBuildStatus":
      return (
        hasOnlyKeys(result, [
          "buildId",
          "status",
          "imageAlias",
          "logOffset",
          "logChunk",
          "error",
          "startedAt",
          "completedAt",
        ]) &&
        stringValue(result.buildId, 80) &&
        isBuildStatus(result.status) &&
        isBuildImageAlias(result.imageAlias) &&
        typeof result.logOffset === "number" &&
        Number.isInteger(result.logOffset) &&
        result.logOffset >= 0 &&
        typeof result.logChunk === "string" &&
        (result.error === undefined || typeof result.error === "string") &&
        (result.startedAt === undefined || isIsoTimestamp(result.startedAt)) &&
        (result.completedAt === undefined || isIsoTimestamp(result.completedAt))
      );
    case "ListBuildImages":
      return hasOnlyKeys(result, ["images"]) && Array.isArray(result.images) && result.images.every(isBuiltImageRecord);
    case "SetBuildImageMaster":
      return hasOnlyKeys(result, ["imageAlias"]) && isBuildImageAlias(result.imageAlias);
    case "ListBuildPresets":
      return hasOnlyKeys(result, ["presets"]) && Array.isArray(result.presets) && result.presets.every(isBuilderPreset);
    case "SaveBuildPreset":
      return hasOnlyKeys(result, ["preset"]) && isBuilderPreset(result.preset);
  }
}

function isBuildStatus(value: unknown): value is BuildStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed";
}

function isBuiltImageRecord(value: unknown): value is BuiltImageRecord {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["imageAlias", "ownerUserId", "buildId", "distro", "release", "basedOn", "isMaster", "createdAt"]) &&
    isBuildImageAlias(value.imageAlias) &&
    stringValue(value.ownerUserId, 200) &&
    stringValue(value.buildId, 80) &&
    stringValue(value.distro, 40) &&
    stringValue(value.release, 80) &&
    (value.basedOn === undefined || isBuildImageAlias(value.basedOn)) &&
    typeof value.isMaster === "boolean" &&
    isIsoTimestamp(value.createdAt)
  );
}

function isBuilderPreset(value: unknown): value is BuilderPreset {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "ownerUserId", "name", "distro", "release", "packages", "postInstallCommands", "updatedAt"]) &&
    stringValue(value.id, 120) &&
    stringValue(value.ownerUserId, 200) &&
    stringValue(value.name, 80) &&
    stringValue(value.distro, 40) &&
    stringValue(value.release, 80) &&
    arrayOfStrings(value.packages, 200, 100) &&
    arrayOfStrings(value.postInstallCommands, 50, 20_000) &&
    isIsoTimestamp(value.updatedAt)
  );
}

function isOperationError(value: unknown) {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["code", "message", "retryable"]) &&
    (value.code === "invalid_input" ||
      value.code === "unauthenticated_service" ||
      value.code === "operation_failed" ||
      value.code === "not_found") &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean"
  );
}

function isIsoTimestamp(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
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
