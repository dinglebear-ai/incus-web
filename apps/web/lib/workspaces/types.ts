export type UserId = string;
export type WorkspaceId = string;
export type ResourceProfileId = string;

export type ActorContext = {
  userId: UserId;
  oidcSubject: string;
  email: string;
  displayName?: string;
  requestId: string;
  ipAddress?: string;
  userAgent?: string;
};

export type WorkspaceState =
  | "creating"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "restarting"
  | "setting_up"
  | "degraded"
  | "deleting"
  | "deleted"
  | "failed";

export type CheckStatus = "ok" | "warn" | "missing" | "unknown";

export type SetupPhase =
  | "not_configured"
  | "queued"
  | "installing_mise"
  | "applying_dotfiles"
  | "checking_tools"
  | "ready"
  | "failed";

export type WorkspaceSetupSummary = {
  phase: SetupPhase;
  dotfilesRepo?: string;
  dotfilesStatus: CheckStatus;
  miseStatus: CheckStatus;
  commandStatus: CheckStatus;
  packageStatus: CheckStatus;
  lastLogExcerpt?: string;
  updatedAt?: string;
};

export type WorkspaceResources = {
  cpu: string;
  memory: string;
  storage: string;
};

// Raw numeric metrics behind the formatted `WorkspaceResources` strings above.
// Kept separate (rather than replacing the formatted fields) so existing
// consumers of `resources.cpu`/`memory`/`storage` are unaffected; the
// dashboard's live telemetry view uses these for progress bars and
// sparklines, which need actual numbers rather than pre-formatted text.
export type WorkspaceMetrics = {
  cpuCount?: number;
  memoryUsedBytes?: number;
  memoryLimitBytes?: number;
  rootDiskUsedBytes?: number;
  rootDiskLimitBytes?: number;
  loadAverage?: [number, number, number];
};

export type Workspace = {
  id: WorkspaceId;
  ownerUserId: UserId;
  name: string;
  slug: string;
  incusProject: string;
  incusContainer: string;
  templateVersion: string;
  state: WorkspaceState;
  resourceProfileId: ResourceProfileId;
  resources: WorkspaceResources;
  metrics: WorkspaceMetrics;
  setup: WorkspaceSetupSummary;
  terminalUrl?: string;
  accessNote?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceInventory = {
  actor: ActorContext;
  workspaces: Workspace[];
  provisionerError?: {
    code: string;
    message: string;
    requestId: string;
    workspaceId?: string;
    operationId?: string;
  };
};
