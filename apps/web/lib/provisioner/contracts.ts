export const PROVISIONER_CONTRACT_VERSION = "provisioner.v1" as const;

export const PROVISIONER_COMMAND_TYPES = [
  "CreateWorkspace",
  "StartWorkspace",
  "StopWorkspace",
  "RestartWorkspace",
  "GetWorkspaceStatus",
  "RunSetup",
  "DispatchAgentRun",
  "ListAgentRuns",
] as const;

// Command types that mutate workspace configuration (resource limits,
// mounts) rather than just lifecycle state or agent-run scheduling. These
// route through the stricter apps/web/lib/workspaces/provisioner.ts
// getMutableWorkspaceRefForActor authorization check instead of the plain
// owner check, requiring INCUS_WEB_ALLOW_SHARED_CONFIG_MUTATION=1 in
// shared-prototype mode. Empty today -- no such command exists yet in
// PROVISIONER_COMMAND_TYPES above (e.g. a future "SetWorkspaceLimits").
// `satisfies` ties every entry to a real command type at compile time, so
// a typo or a since-removed command type here is a build error, not a
// silent runtime gap.
export const MUTATING_COMMAND_TYPES = [] as const satisfies readonly (typeof PROVISIONER_COMMAND_TYPES)[number][];

const PROVISIONER_WORKSPACE_STATES = [
  "creating",
  "stopped",
  "starting",
  "running",
  "stopping",
  "restarting",
  "setting_up",
  "degraded",
  "failed",
] as const;

const PROVISIONER_SETUP_PHASES = [
  "not_configured",
  "queued",
  "installing_mise",
  "applying_dotfiles",
  "checking_tools",
  "ready",
  "failed",
] as const;

const OPERATION_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
const AGENT_RUN_AGENTS = ["codex", "claude"] as const;
const AGENT_RUN_CONTAINER_STATES = [
  "planned",
  "cloning",
  "stopped",
  "starting",
  "running",
  "failed",
  "deleted",
] as const;
const AGENT_RUN_PHASES = [
  "queued",
  "cloning_container",
  "starting_container",
  "cloning_repo",
  "injecting_credentials",
  "attaching_agent",
  "running",
  "succeeded",
  "failed",
] as const;
const AGENT_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
const AGENT_CONTROLLER_KINDS = ["codex-app-server", "claude-cli"] as const;

export type ProvisionerContractVersion = typeof PROVISIONER_CONTRACT_VERSION;
export type ProvisionerCommandType = (typeof PROVISIONER_COMMAND_TYPES)[number];

export type RequestId = string;
export type UserId = string;
export type WorkspaceId = string;
export type OperationId = string;
export type IncusProjectName = string;
export type IncusContainerName = string;
export type ResourceProfileId = "local-dev";
export type AgentRunAgent = (typeof AGENT_RUN_AGENTS)[number];
export type AgentRunContainerState =
  (typeof AGENT_RUN_CONTAINER_STATES)[number];
export type AgentRunPhase = (typeof AGENT_RUN_PHASES)[number];
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export type AgentControllerKind = (typeof AGENT_CONTROLLER_KINDS)[number];

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

export type ProvisionerError = {
  code: ProvisionerErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProvisionerError };

export type ProvisionerActor = {
  userId: UserId;
  oidcSubject: string;
  email: string;
  displayName?: string;
};

export type ProvisionerWorkspaceRef = {
  id: WorkspaceId;
  ownerUserId: UserId;
  incusProject: IncusProjectName;
  incusContainer: IncusContainerName;
};

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export type ProvisionerWorkspaceState =
  (typeof PROVISIONER_WORKSPACE_STATES)[number];

export type ProvisionerSetupPhase = (typeof PROVISIONER_SETUP_PHASES)[number];

export type WorkspaceRuntimeStatus = {
  workspaceId: WorkspaceId;
  state: ProvisionerWorkspaceState;
  incusProject: IncusProjectName;
  incusContainer: IncusContainerName;
  cpuCount?: number;
  memoryUsedBytes?: number;
  memoryLimitBytes?: number;
  rootDiskUsedBytes?: number;
  rootDiskLimitBytes?: number;
  loadAverage?: [number, number, number];
  setupPhase?: ProvisionerSetupPhase;
  lastCheckedAt: string;
};

export type CreateWorkspacePayload = {
  templateVersion: string;
  resourceProfileId: ResourceProfileId;
  autoStart: boolean;
};

export type StartWorkspacePayload = Record<string, never>;
export type GetWorkspaceStatusPayload = Record<string, never>;

export type StopWorkspacePayload = {
  force: boolean;
  timeoutSeconds: number;
};

export type RestartWorkspacePayload = {
  timeoutSeconds: number;
};

export type RunSetupPayload = {
  dotfilesRepo?: string;
  ageKey?: {
    value: string;
    persistEncrypted: boolean;
  };
  skipAptScripts: boolean;
};

export type AgentRunContainer = {
  name: string;
  project: string;
  sourceContainer: string;
  sourceProject: string;
  createdFrom: "golden";
  state: AgentRunContainerState;
};

export type AgentRunController = {
  kind: AgentControllerKind;
  sessionId?: string;
  turnId?: string;
  url?: string;
};

export type AgentRun = {
  id: string;
  workspaceId: WorkspaceId;
  ownerUserId: UserId;
  container: AgentRunContainer;
  agent: AgentRunAgent;
  repoUrl: string;
  ref?: string;
  task: string;
  phase: AgentRunPhase;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  controller?: AgentRunController;
  logs?: AgentRunLogEntry[];
  lastLogExcerpt?: string;
  error?: string;
};

export type AgentRunLogEntry = {
  at: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
};

export type DispatchAgentRunPayload = {
  agent: AgentRunAgent;
  repoUrl: string;
  ref?: string;
  task: string;
};

export type DispatchAgentRunResult = {
  run: AgentRun;
};

export type ListAgentRunsPayload = {
  limit: number;
};

export type ListAgentRunsResult = {
  runs: AgentRun[];
};

export type SetupValidationPolicy = {
  allowAgeKeyPersistence?: boolean;
};

export type CreateWorkspaceResult = {
  workspaceId: WorkspaceId;
  incusProject: IncusProjectName;
  incusContainer: IncusContainerName;
  state: "stopped" | "running";
  templateVersion: string;
  resourceProfileId: ResourceProfileId;
};

export type LifecycleWorkspaceResult = {
  workspaceId: WorkspaceId;
  state: "running" | "stopped";
  status?: WorkspaceRuntimeStatus;
};

export type RunSetupResult = {
  workspaceId: WorkspaceId;
  setup: ProvisionerSetupSummary;
};

export type ProvisionerCheckStatus = "ok" | "warn" | "missing" | "unknown";

export type ProvisionerSetupSummary = {
  phase?: ProvisionerSetupPhase;
  dotfilesStatus?: ProvisionerCheckStatus;
  miseStatus?: ProvisionerCheckStatus;
  commandStatus?: ProvisionerCheckStatus;
  packageStatus?: ProvisionerCheckStatus;
  lastLogExcerpt?: string;
};

export type ProvisionerCommandPayloadMap = {
  CreateWorkspace: CreateWorkspacePayload;
  StartWorkspace: StartWorkspacePayload;
  StopWorkspace: StopWorkspacePayload;
  RestartWorkspace: RestartWorkspacePayload;
  GetWorkspaceStatus: GetWorkspaceStatusPayload;
  RunSetup: RunSetupPayload;
  DispatchAgentRun: DispatchAgentRunPayload;
  ListAgentRuns: ListAgentRunsPayload;
};

export type ProvisionerCommandResultMap = {
  CreateWorkspace: CreateWorkspaceResult;
  StartWorkspace: LifecycleWorkspaceResult;
  StopWorkspace: LifecycleWorkspaceResult;
  RestartWorkspace: LifecycleWorkspaceResult;
  GetWorkspaceStatus: WorkspaceRuntimeStatus;
  RunSetup: RunSetupResult;
  DispatchAgentRun: DispatchAgentRunResult;
  ListAgentRuns: ListAgentRunsResult;
};

export type ProvisionerCommand<
  TType extends ProvisionerCommandType = ProvisionerCommandType,
> = {
  [K in TType]: {
    version: ProvisionerContractVersion;
    requestId: RequestId;
    type: K;
    actor: ProvisionerActor;
    workspace: ProvisionerWorkspaceRef;
    payload: ProvisionerCommandPayloadMap[K];
  };
}[TType];

export type ProvisionerOperation<
  TType extends ProvisionerCommandType = ProvisionerCommandType,
> = {
  [K in TType]: {
    id: OperationId;
    requestId: RequestId;
    type: K;
    workspaceId: WorkspaceId;
    status: OperationStatus;
    result?: ProvisionerCommandResultMap[K];
    error?: ProvisionerError;
    startedAt?: string;
    completedAt?: string;
  };
}[TType];

export function isProvisionerCommandType(
  value: unknown,
): value is ProvisionerCommandType {
  return (
    typeof value === "string" &&
    PROVISIONER_COMMAND_TYPES.includes(value as ProvisionerCommandType)
  );
}

export function validateGeneratedName(
  value: string,
  prefix: "user" | "ws",
): boolean {
  if (value.length > 63) {
    return false;
  }
  return new RegExp(`^${prefix}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`).test(
    value,
  );
}

export function validateIncusProjectName(value: string): boolean {
  if (value === "default" || validateGeneratedName(value, "user")) {
    return true;
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,61}[A-Za-z0-9])?$/.test(value);
}

export function validateIncusContainerName(value: string): boolean {
  return value === "incus-web" || validateGeneratedName(value, "ws");
}

export function validateProvisionerCommand(
  command: unknown,
): ValidationResult<ProvisionerCommand> {
  if (!isRecord(command)) {
    return invalid("command must be an object");
  }
  if (command.version !== PROVISIONER_CONTRACT_VERSION) {
    return invalid("unsupported provisioner contract version");
  }
  if (!isProvisionerCommandType(command.type)) {
    return invalid("unsupported provisioner command type");
  }
  if (typeof command.requestId !== "string" || command.requestId.length === 0) {
    return invalid("requestId is required");
  }
  if (!isActor(command.actor)) {
    return invalid("actor is invalid");
  }
  if (!isWorkspaceRef(command.workspace)) {
    return invalid("workspace ref is invalid");
  }
  const payload = validateCommandPayload(command.type, command.payload);
  if (!payload.ok) {
    return payload;
  }
  return { ok: true, value: command as ProvisionerCommand };
}

export function validateSetupPayload(
  payload: unknown,
  policy: SetupValidationPolicy = {},
): ValidationResult<RunSetupPayload> {
  if (!isRecord(payload)) {
    return invalid("setup payload must be an object");
  }
  if (!hasOnlyKeys(payload, ["dotfilesRepo", "ageKey", "skipAptScripts"])) {
    return invalid("setup payload contains unsupported fields");
  }
  if (typeof payload.skipAptScripts !== "boolean") {
    return invalid("skipAptScripts must be a boolean");
  }
  if (
    payload.dotfilesRepo !== undefined &&
    (typeof payload.dotfilesRepo !== "string" ||
      payload.dotfilesRepo.length === 0 ||
      payload.dotfilesRepo.length > 512 ||
      !isAllowedGithubHttpsRepo(payload.dotfilesRepo))
  ) {
    return invalid("dotfilesRepo is invalid");
  }
  if (payload.ageKey !== undefined) {
    if (!isRecord(payload.ageKey)) {
      return invalid("ageKey is invalid");
    }
    if (!hasOnlyKeys(payload.ageKey, ["value", "persistEncrypted"])) {
      return invalid("ageKey contains unsupported fields");
    }
    if (
      typeof payload.ageKey.value !== "string" ||
      payload.ageKey.value.length > 200000 ||
      !isAgeIdentity(payload.ageKey.value)
    ) {
      return invalid("age key did not look like an age identity file");
    }
    if (typeof payload.ageKey.persistEncrypted !== "boolean") {
      return invalid("ageKey.persistEncrypted must be a boolean");
    }
    if (payload.ageKey.persistEncrypted && !policy.allowAgeKeyPersistence) {
      return invalid("age key persistence is not enabled by host policy");
    }
  }
  return { ok: true, value: payload as RunSetupPayload };
}

export function validateDispatchAgentRunPayload(
  payload: unknown,
): ValidationResult<DispatchAgentRunPayload> {
  if (!isRecord(payload)) {
    return invalid("DispatchAgentRun payload must be an object");
  }
  if (!hasOnlyKeys(payload, ["agent", "repoUrl", "ref", "task"])) {
    return invalid("DispatchAgentRun payload contains unsupported fields");
  }
  if (!isAgentRunAgent(payload.agent)) {
    return invalid("agent must be codex or claude");
  }
  if (
    typeof payload.repoUrl !== "string" ||
    payload.repoUrl.length > 512 ||
    !isAllowedAgentRepo(payload.repoUrl)
  ) {
    return invalid("repoUrl is invalid");
  }
  if (
    typeof payload.task !== "string" ||
    payload.task.trim().length === 0 ||
    payload.task.length > 12000
  ) {
    return invalid("task is invalid");
  }
  if (
    payload.ref !== undefined &&
    (typeof payload.ref !== "string" ||
      payload.ref.length === 0 ||
      payload.ref.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(payload.ref) ||
      payload.ref.includes("..") ||
      payload.ref.includes("//") ||
      payload.ref.endsWith("/"))
  ) {
    return invalid("ref is invalid");
  }
  return { ok: true, value: payload as DispatchAgentRunPayload };
}

export function normalizeAgentRepoInput(value: string): string {
  const trimmed = value.trim();
  const shorthand = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
    trimmed,
  );
  if (
    shorthand &&
    shorthand[2].length <= 100 &&
    /^[A-Za-z0-9_.-]*[A-Za-z0-9]$/.test(shorthand[2]) &&
    !shorthand[2].includes("..")
  ) {
    return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  }

  const githubPath = /^github\.com\/(.+)$/i.exec(trimmed);
  if (githubPath) {
    return normalizeAgentRepoInput(githubPath[1]);
  }

  return trimmed;
}

export function validateListAgentRunsPayload(
  payload: unknown,
): ValidationResult<ListAgentRunsPayload> {
  if (!isRecord(payload)) {
    return invalid("ListAgentRuns payload must be an object");
  }
  if (!hasOnlyKeys(payload, ["limit"])) {
    return invalid("ListAgentRuns payload contains unsupported fields");
  }
  if (
    typeof payload.limit !== "number" ||
    !Number.isInteger(payload.limit) ||
    payload.limit < 1 ||
    payload.limit > 100
  ) {
    return invalid("limit must be an integer from 1 to 100");
  }
  return { ok: true, value: payload as ListAgentRunsPayload };
}

export function validateAgentRun(
  run: unknown,
  workspace: ProvisionerWorkspaceRef,
): ValidationResult<AgentRun> {
  if (!isRecord(run)) {
    return invalid("agent run must be an object");
  }
  if (run.workspaceId !== workspace.id || run.ownerUserId !== workspace.ownerUserId) {
    return metadataMismatch("agent run workspace tuple did not match request");
  }
  if (typeof run.id !== "string" || !/^run_\d{14}_[a-z0-9]+$/.test(run.id)) {
    return invalid("agent run id is invalid");
  }
  if (!isAgentRunContainer(run.container)) {
    return invalid("agent run container is invalid");
  }
  if (!isAgentRunAgent(run.agent)) {
    return invalid("agent run agent is invalid");
  }
  if (typeof run.repoUrl !== "string" || !isAllowedAgentRepo(run.repoUrl)) {
    return invalid("agent run repoUrl is invalid");
  }
  if (typeof run.task !== "string" || run.task.trim().length === 0) {
    return invalid("agent run task is invalid");
  }
  if (run.ref !== undefined && typeof run.ref !== "string") {
    return invalid("agent run ref is invalid");
  }
  if (!isAgentRunPhase(run.phase) || !isAgentRunStatus(run.status)) {
    return invalid("agent run status is invalid");
  }
  if (!isIsoTimestamp(run.createdAt) || !isIsoTimestamp(run.updatedAt)) {
    return invalid("agent run timestamps are invalid");
  }
  if (run.completedAt !== undefined && !isIsoTimestamp(run.completedAt)) {
    return invalid("agent run completedAt is invalid");
  }
  if (run.controller !== undefined && !isAgentRunController(run.controller)) {
    return invalid("agent run controller is invalid");
  }
  if (run.logs !== undefined && !isAgentRunLogs(run.logs)) {
    return invalid("agent run logs are invalid");
  }
  if (run.lastLogExcerpt !== undefined && typeof run.lastLogExcerpt !== "string") {
    return invalid("agent run lastLogExcerpt is invalid");
  }
  if (run.error !== undefined && typeof run.error !== "string") {
    return invalid("agent run error is invalid");
  }
  return { ok: true, value: run as AgentRun };
}

export function validateWorkspaceRuntimeStatus(
  status: unknown,
  workspace: ProvisionerWorkspaceRef,
): ValidationResult<WorkspaceRuntimeStatus> {
  if (!isRecord(status)) {
    return invalid("workspace status must be an object");
  }
  if (!matchesWorkspaceTuple(status, workspace)) {
    return metadataMismatch("workspace status tuple did not match request");
  }
  if (!isWorkspaceState(status.state)) {
    return invalid("workspace state is invalid");
  }
  if (
    typeof status.lastCheckedAt !== "string" ||
    Number.isNaN(Date.parse(status.lastCheckedAt))
  ) {
    return invalid("lastCheckedAt is invalid");
  }
  if (
    status.setupPhase !== undefined &&
    !isProvisionerSetupPhase(status.setupPhase)
  ) {
    return invalid("setupPhase is invalid");
  }
  if (
    !hasOptionalNonNegativeNumber(status.cpuCount) ||
    !hasOptionalNonNegativeNumber(status.memoryUsedBytes) ||
    !hasOptionalNonNegativeNumber(status.memoryLimitBytes) ||
    !hasOptionalNonNegativeNumber(status.rootDiskUsedBytes) ||
    !hasOptionalNonNegativeNumber(status.rootDiskLimitBytes)
  ) {
    return invalid("workspace status metrics are invalid");
  }
  if (status.loadAverage !== undefined && !isLoadAverage(status.loadAverage)) {
    return invalid("workspace status load average is invalid");
  }
  return { ok: true, value: status as WorkspaceRuntimeStatus };
}

export function validateProvisionerOperation<TType extends ProvisionerCommandType>(
  operation: unknown,
  workspace: ProvisionerWorkspaceRef,
  type: TType,
): ValidationResult<ProvisionerOperation<TType>> {
  if (!isRecord(operation)) {
    return invalid("operation must be an object");
  }
  if (
    typeof operation.id !== "string" ||
    operation.id.length === 0 ||
    typeof operation.requestId !== "string" ||
    operation.requestId.length === 0
  ) {
    return invalid("operation identity is invalid");
  }
  if (operation.type !== type || operation.workspaceId !== workspace.id) {
    return metadataMismatch("operation tuple did not match request");
  }
  if (!isOperationStatus(operation.status)) {
    return invalid("operation status is invalid");
  }
  if (
    operation.startedAt !== undefined &&
    !isIsoTimestamp(operation.startedAt)
  ) {
    return invalid("operation startedAt is invalid");
  }
  if (
    operation.completedAt !== undefined &&
    !isIsoTimestamp(operation.completedAt)
  ) {
    return invalid("operation completedAt is invalid");
  }
  if (operation.status === "succeeded") {
    if (operation.result === undefined || operation.error !== undefined) {
      return invalid("succeeded operation must include only a result");
    }
    const result = validateOperationResult(type, operation.result, workspace);
    if (!result.ok) {
      return result;
    }
  } else if (operation.status === "failed") {
    if (operation.error === undefined || operation.result !== undefined) {
      return invalid("failed operation must include only an error");
    }
    if (!isProvisionerError(operation.error)) {
      return invalid("operation error is invalid");
    }
  } else if (operation.result !== undefined || operation.error !== undefined) {
    return invalid("pending operation must not include result or error");
  }
  return { ok: true, value: operation as ProvisionerOperation<TType> };
}

export function redactProvisionerCommand(command: ProvisionerCommand): unknown {
  if (command.type !== "RunSetup" || !isRecord(command.payload)) {
    return command;
  }
  const payload: Record<string, unknown> = { ...command.payload };
  if (isRecord(payload.ageKey)) {
    payload.ageKey = {
      ...payload.ageKey,
      value: "[REDACTED]",
    };
  }
  return {
    ...command,
    payload,
  };
}

export function redactProvisionerOperation(operation: ProvisionerOperation): unknown {
  const error = operation.error
    ? {
        ...operation.error,
        message: redactSetupExcerpt(operation.error.message),
        details: operation.error.details
          ? sanitizeDetails(operation.error.details)
          : undefined,
      }
    : undefined;
  return {
    ...operation,
    result: sanitizeValue(operation.result),
    error,
  };
}

export function redactSetupExcerpt(value: string): string {
  const truncated =
    value.length > MAX_REDACTED_STRING_LENGTH
      ? `${value.slice(0, MAX_REDACTED_STRING_LENGTH)}[TRUNCATED]`
      : value;
  return truncated
    .replace(/AGE-SECRET-KEY-[A-Z0-9-]+/gi, "[REDACTED_AGE_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_TOKEN]")
    .replace(
      /\/(?:home|srv|mnt|var\/lib\/incus|var\/snap\/lxd)[^\s]*/g,
      "[REDACTED_PATH]",
    );
}

const MAX_REDACTED_STRING_LENGTH = 4096;
const MAX_REDACTION_DEPTH = 4;
const MAX_REDACTION_ENTRIES = 32;

function isActor(value: unknown): value is ProvisionerActor {
  return (
    isRecord(value) &&
    typeof value.userId === "string" &&
    value.userId.length > 0 &&
    typeof value.oidcSubject === "string" &&
    value.oidcSubject.length > 0 &&
    typeof value.email === "string" &&
    value.email.length > 0 &&
    (value.displayName === undefined || typeof value.displayName === "string")
  );
}

function isWorkspaceRef(value: unknown): value is ProvisionerWorkspaceRef {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.ownerUserId === "string" &&
    value.ownerUserId.length > 0 &&
    typeof value.incusProject === "string" &&
    validateIncusProjectName(value.incusProject) &&
    typeof value.incusContainer === "string" &&
    validateIncusContainerName(value.incusContainer)
  );
}

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
  }
}

function validateCreateWorkspacePayload(
  payload: unknown,
): ValidationResult<CreateWorkspacePayload> {
  if (!isRecord(payload)) {
    return invalid("CreateWorkspace payload must be an object");
  }
  if (!hasOnlyKeys(payload, ["templateVersion", "resourceProfileId", "autoStart"])) {
    return invalid("CreateWorkspace payload contains unsupported fields");
  }
  if (
    typeof payload.templateVersion !== "string" ||
    payload.templateVersion.length === 0 ||
    typeof payload.autoStart !== "boolean" ||
    payload.resourceProfileId !== "local-dev"
  ) {
    return invalid("CreateWorkspace payload is invalid");
  }
  return { ok: true, value: payload as CreateWorkspacePayload };
}

function validateStopWorkspacePayload(
  payload: unknown,
): ValidationResult<StopWorkspacePayload> {
  if (!isRecord(payload)) {
    return invalid("StopWorkspace payload must be an object");
  }
  if (!hasOnlyKeys(payload, ["force", "timeoutSeconds"])) {
    return invalid("StopWorkspace payload contains unsupported fields");
  }
  if (
    typeof payload.force !== "boolean" ||
    !isPositiveTimeout(payload.timeoutSeconds)
  ) {
    return invalid("StopWorkspace payload is invalid");
  }
  return { ok: true, value: payload as StopWorkspacePayload };
}

function validateRestartWorkspacePayload(
  payload: unknown,
): ValidationResult<RestartWorkspacePayload> {
  if (!isRecord(payload)) {
    return invalid("RestartWorkspace payload must be an object");
  }
  if (!hasOnlyKeys(payload, ["timeoutSeconds"])) {
    return invalid("RestartWorkspace payload contains unsupported fields");
  }
  if (!isPositiveTimeout(payload.timeoutSeconds)) {
    return invalid("RestartWorkspace payload is invalid");
  }
  return { ok: true, value: payload as RestartWorkspacePayload };
}

function validateEmptyPayload(
  payload: unknown,
): ValidationResult<StartWorkspacePayload | GetWorkspaceStatusPayload> {
  if (!isRecord(payload)) {
    return invalid("payload must be an object");
  }
  if (!hasOnlyKeys(payload, [])) {
    return invalid("payload contains unsupported fields");
  }
  return { ok: true, value: {} };
}

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
  }
}

function validateDispatchAgentRunResult(
  result: unknown,
  workspace: ProvisionerWorkspaceRef,
): ValidationResult<DispatchAgentRunResult> {
  if (!isRecord(result) || !hasOnlyKeys(result, ["run"])) {
    return invalid("DispatchAgentRun result must include a run");
  }
  const run = validateAgentRun(result.run, workspace);
  if (!run.ok) {
    return run;
  }
  return { ok: true, value: { run: run.value } };
}

function validateListAgentRunsResult(
  result: unknown,
  workspace: ProvisionerWorkspaceRef,
): ValidationResult<ListAgentRunsResult> {
  if (!isRecord(result) || !Array.isArray(result.runs)) {
    return invalid("ListAgentRuns result must include runs");
  }
  if (result.runs.length > 100) {
    return invalid("ListAgentRuns returned too many runs");
  }
  for (const runValue of result.runs) {
    const run = validateAgentRun(runValue, workspace);
    if (!run.ok) {
      return run;
    }
  }
  return { ok: true, value: result as ListAgentRunsResult };
}

function validateCreateWorkspaceResult(
  result: unknown,
  workspace: ProvisionerWorkspaceRef,
): ValidationResult<CreateWorkspaceResult> {
  if (!isRecord(result)) {
    return invalid("CreateWorkspace result must be an object");
  }
  if (!matchesWorkspaceTuple(result, workspace)) {
    return metadataMismatch("CreateWorkspace result tuple did not match request");
  }
  if (
    (result.state !== "stopped" && result.state !== "running") ||
    typeof result.templateVersion !== "string" ||
    result.templateVersion.length === 0 ||
    result.resourceProfileId !== "local-dev"
  ) {
    return invalid("CreateWorkspace result is invalid");
  }
  return { ok: true, value: result as CreateWorkspaceResult };
}

function validateLifecycleWorkspaceResult(
  result: unknown,
  workspace: ProvisionerWorkspaceRef,
  state: "running" | "stopped",
  requireStatus: boolean,
): ValidationResult<LifecycleWorkspaceResult> {
  if (!isRecord(result)) {
    return invalid("lifecycle result must be an object");
  }
  if (result.workspaceId !== workspace.id) {
    return metadataMismatch("lifecycle result workspace did not match request");
  }
  if (result.state !== state) {
    return invalid("lifecycle result state is invalid");
  }
  if (requireStatus && result.status === undefined) {
    return invalid("lifecycle result status is required");
  }
  if (result.status !== undefined) {
    const status = validateWorkspaceRuntimeStatus(result.status, workspace);
    if (!status.ok) {
      return status;
    }
  }
  return { ok: true, value: result as LifecycleWorkspaceResult };
}

function validateRunSetupResult(
  result: unknown,
  workspace: ProvisionerWorkspaceRef,
): ValidationResult<RunSetupResult> {
  if (!isRecord(result)) {
    return invalid("RunSetup result must be an object");
  }
  if (result.workspaceId !== workspace.id) {
    return metadataMismatch("RunSetup result workspace did not match request");
  }
  if (!isSetupSummary(result.setup)) {
    return invalid("RunSetup setup summary is invalid");
  }
  return { ok: true, value: result as RunSetupResult };
}

function isSetupSummary(value: unknown): value is ProvisionerSetupSummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "phase",
      "dotfilesStatus",
      "miseStatus",
      "commandStatus",
      "packageStatus",
      "lastLogExcerpt",
    ]) &&
    (value.phase === undefined || isProvisionerSetupPhase(value.phase)) &&
    hasOptionalCheckStatus(value.dotfilesStatus) &&
    hasOptionalCheckStatus(value.miseStatus) &&
    hasOptionalCheckStatus(value.commandStatus) &&
    hasOptionalCheckStatus(value.packageStatus) &&
    (value.lastLogExcerpt === undefined ||
      typeof value.lastLogExcerpt === "string")
  );
}

function isAgentRunLogs(value: unknown): value is AgentRunLogEntry[] {
  return (
    Array.isArray(value) &&
    value.length <= 200 &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ["at", "level", "message"]) &&
        typeof entry.at === "string" &&
        !Number.isNaN(Date.parse(entry.at)) &&
        (entry.level === "info" ||
          entry.level === "success" ||
          entry.level === "warn" ||
          entry.level === "error") &&
        typeof entry.message === "string" &&
        entry.message.length <= 20000,
    )
  );
}

function hasOptionalCheckStatus(value: unknown): boolean {
  return (
    value === undefined ||
    value === "ok" ||
    value === "warn" ||
    value === "missing" ||
    value === "unknown"
  );
}

function isAllowedGithubHttpsRepo(value: string): boolean {
  const match = value.match(
    /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  return Boolean(
    match &&
      match[2].length <= 100 &&
      /^[A-Za-z0-9_.-]*[A-Za-z0-9]$/.test(match[2]) &&
      !match[2].includes(".."),
  );
}

function isAllowedAgentRepo(value: string): boolean {
  if (value.length === 0 || value.length > 512 || /[\s\r\n]/.test(value)) {
    return false;
  }
  if (value.startsWith("https://") || value.startsWith("ssh://")) {
    try {
      const url = new URL(value);
      return Boolean(url.hostname && url.pathname.length > 1);
    } catch {
      return false;
    }
  }
  return /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/.test(value);
}

function isAgeIdentity(value: string): boolean {
  return value
    .split(/\r?\n/)
    .some((line) => /^AGE-SECRET-KEY-[A-Z0-9-]+$/i.test(line.trim()));
}

function isWorkspaceState(value: unknown): value is ProvisionerWorkspaceState {
  return (
    typeof value === "string" &&
    PROVISIONER_WORKSPACE_STATES.includes(value as ProvisionerWorkspaceState)
  );
}

function isProvisionerSetupPhase(
  value: unknown,
): value is ProvisionerSetupPhase {
  return (
    typeof value === "string" &&
    PROVISIONER_SETUP_PHASES.includes(value as ProvisionerSetupPhase)
  );
}

function isAgentRunAgent(value: unknown): value is AgentRunAgent {
  return (
    typeof value === "string" &&
    AGENT_RUN_AGENTS.includes(value as AgentRunAgent)
  );
}

function isAgentRunContainerState(
  value: unknown,
): value is AgentRunContainerState {
  return (
    typeof value === "string" &&
    AGENT_RUN_CONTAINER_STATES.includes(value as AgentRunContainerState)
  );
}

function isAgentRunPhase(value: unknown): value is AgentRunPhase {
  return (
    typeof value === "string" &&
    AGENT_RUN_PHASES.includes(value as AgentRunPhase)
  );
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return (
    typeof value === "string" &&
    AGENT_RUN_STATUSES.includes(value as AgentRunStatus)
  );
}

function isAgentRunContainer(value: unknown): value is AgentRunContainer {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    validateAgentRunContainerName(value.name) &&
    typeof value.project === "string" &&
    validateIncusProjectName(value.project) &&
    typeof value.sourceContainer === "string" &&
    validateIncusInstanceName(value.sourceContainer) &&
    typeof value.sourceProject === "string" &&
    validateIncusProjectName(value.sourceProject) &&
    value.createdFrom === "golden" &&
    isAgentRunContainerState(value.state)
  );
}

function isAgentRunController(value: unknown): value is AgentRunController {
  return (
    isRecord(value) &&
    AGENT_CONTROLLER_KINDS.includes(value.kind as AgentControllerKind) &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.turnId === undefined || typeof value.turnId === "string") &&
    (value.url === undefined || typeof value.url === "string")
  );
}

function validateAgentRunContainerName(value: string): boolean {
  return (
    value.length <= 63 &&
    /^agent-run-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  );
}

function validateIncusInstanceName(value: string): boolean {
  return (
    value.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)
  );
}

function isOperationStatus(value: unknown): value is OperationStatus {
  return (
    typeof value === "string" &&
    OPERATION_STATUSES.includes(value as OperationStatus)
  );
}

function isProvisionerError(value: unknown): value is ProvisionerError {
  return (
    isRecord(value) &&
    isProvisionerErrorCode(value.code) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    typeof value.retryable === "boolean" &&
    (value.details === undefined || isRecord(value.details))
  );
}

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

function hasOptionalNonNegativeNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function isLoadAverage(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (entry) =>
        typeof entry === "number" && Number.isFinite(entry) && entry >= 0,
    )
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function sanitizeDetails(
  details: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeRecord(details, 0);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return redactSetupExcerpt(value);
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return "[REDACTED_DEPTH_LIMIT]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_REDACTION_ENTRIES)
      .map((entry) => sanitizeValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    return sanitizeRecord(value, depth + 1);
  }
  return value;
}

function sanitizeRecord(
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_REDACTION_ENTRIES)
      .map(([key, entry]) => [key, sanitizeValue(entry, depth)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function matchesWorkspaceTuple(
  value: Record<string, unknown>,
  workspace: ProvisionerWorkspaceRef,
): boolean {
  return (
    value.workspaceId === workspace.id &&
    value.incusProject === workspace.incusProject &&
    value.incusContainer === workspace.incusContainer
  );
}

function isPositiveTimeout(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1200;
}

function metadataMismatch(message: string): ValidationResult<never> {
  return {
    ok: false,
    error: {
      code: "metadata_mismatch",
      message,
      retryable: false,
    },
  };
}

function invalid(message: string): ValidationResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_input",
      message,
      retryable: false,
    },
  };
}
