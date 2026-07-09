import type {
  ProvisionerSetupPhase,
  ProvisionerWorkspaceRef,
  WorkspaceRuntimeStatus,
} from "@/lib/provisioner/contracts";
import {
  validateIncusContainerName,
  validateIncusProjectName,
} from "@/lib/provisioner/contracts";
import type {
  SetupPhase,
  Workspace,
  WorkspaceSetupSummary,
} from "@/lib/workspaces/types";

const createdAt = "2026-01-01T00:00:00.000Z";
const gib = 1024 * 1024 * 1024;

export function buildPrototypeWorkspaceRef(
  ownerUserId: string,
): ProvisionerWorkspaceRef {
  const incusProject = stringEnv(
    "INCUS_WEB_INCUS_PROJECT",
    "default",
  );
  const incusContainer = stringEnv(
    "INCUS_WEB_INCUS_CONTAINER",
    process.env.CONTAINER_NAME?.trim() || "incus-web",
  );
  if (!validateIncusProjectName(incusProject)) {
    throw new Error("INCUS_WEB_INCUS_PROJECT is invalid");
  }
  if (!validateIncusContainerName(incusContainer)) {
    throw new Error("INCUS_WEB_INCUS_CONTAINER is invalid");
  }
  return {
    id: stringEnv("INCUS_WEB_WORKSPACE_ID", "workspace-incus-web"),
    ownerUserId,
    incusProject,
    incusContainer,
  };
}

export function prototypeRuntimeStatus(
  workspace: ProvisionerWorkspaceRef,
): WorkspaceRuntimeStatus {
  return {
    workspaceId: workspace.id,
    state: "running",
    incusProject: workspace.incusProject,
    incusContainer: workspace.incusContainer,
    image: stringEnv("INCUS_WEB_TEMPLATE_VERSION", "ubuntu-24.04-code-v1"),
    storagePool: stringEnv("INCUS_WEB_PROTOTYPE_STORAGE_POOL", "default"),
    networkBridge: stringEnv("INCUS_NETWORK", "agentbr0"),
    workspaceHostPath: stringEnv(
      "INCUS_WEB_PROTOTYPE_WORKSPACE_HOST_PATH",
      "/srv/incus-web/default-workspace",
    ),
    workspaceMountPath: "/workspace",
    effectiveLimits: {
      cpu: String(numberEnv("INCUS_WEB_PROTOTYPE_CPU", 2)),
      memory: formatBytes(numberEnv("INCUS_WEB_PROTOTYPE_MEMORY_BYTES", 4 * gib)),
      processes: "2048",
    },
    cpuCount: numberEnv("INCUS_WEB_PROTOTYPE_CPU", 2),
    memoryUsedBytes: numberEnv("INCUS_WEB_PROTOTYPE_MEMORY_USED_BYTES", 96 * 1024 * 1024),
    memoryLimitBytes: numberEnv("INCUS_WEB_PROTOTYPE_MEMORY_BYTES", 4 * gib),
    rootDiskUsedBytes: numberEnv("INCUS_WEB_PROTOTYPE_DISK_USED_BYTES", 5 * gib),
    rootDiskLimitBytes: numberEnv("INCUS_WEB_PROTOTYPE_DISK_BYTES", 20 * gib),
    setupPhase: "ready",
    lastCheckedAt: new Date().toISOString(),
  };
}

export function statusToWorkspace(
  status: WorkspaceRuntimeStatus,
  ownerUserId: string,
): Workspace {
  return {
    id: status.workspaceId,
    ownerUserId,
    name: "incus-web",
    slug: "incus-web",
    incusProject: status.incusProject,
    incusContainer: status.incusContainer,
    image: status.image,
    storagePool: status.storagePool,
    networkBridge: status.networkBridge,
    workspaceHostPath: status.workspaceHostPath,
    workspaceMountPath: status.workspaceMountPath,
    templateVersion: status.image ?? stringEnv(
      "INCUS_WEB_TEMPLATE_VERSION",
      "ubuntu-24.04-code-v1",
    ),
    state: status.state,
    resourceProfileId: "local-dev",
    resources: {
      cpu: status.cpuCount ? `${status.cpuCount} vCPU` : "unknown",
      memory: bytePair(status.memoryUsedBytes, status.memoryLimitBytes),
      storage: bytePair(status.rootDiskUsedBytes, status.rootDiskLimitBytes, {
        empty: "host quota pending",
      }),
      effectiveCpu: status.effectiveLimits?.cpu,
      effectiveMemory: status.effectiveLimits?.memory,
      effectiveProcesses: status.effectiveLimits?.processes,
    },
    metrics: {
      cpuCount: status.cpuCount,
      memoryUsedBytes: status.memoryUsedBytes,
      memoryLimitBytes: status.memoryLimitBytes,
      rootDiskUsedBytes: status.rootDiskUsedBytes,
      rootDiskLimitBytes: status.rootDiskLimitBytes,
      loadAverage: status.loadAverage,
    },
    setup: setupSummary(status),
    terminalUrl: optionalUrlEnv("INCUS_WEB_TERMINAL_URL"),
    accessNote:
      "Private workspace. Sharing requires an explicit user or org grant.",
    createdAt,
    updatedAt: status.lastCheckedAt,
  };
}

function bytePair(
  usedBytes: number | undefined,
  limitBytes: number | undefined,
  { empty = "unknown" }: { empty?: string } = {},
): string {
  if (usedBytes !== undefined && limitBytes !== undefined) {
    return `${formatBytes(usedBytes)} / ${formatBytes(limitBytes)}`;
  }
  if (limitBytes !== undefined) {
    return formatBytes(limitBytes);
  }
  if (usedBytes !== undefined) {
    return `${formatBytes(usedBytes)} used`;
  }
  return empty;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded =
    value >= 10 || unitIndex === 0 || Number.isInteger(value)
      ? Math.round(value).toString()
      : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

function setupSummary(status: WorkspaceRuntimeStatus): WorkspaceSetupSummary {
  const phase = setupPhase(status.setupPhase);
  if (phase === "ready") {
    return {
      phase,
      dotfilesStatus: "ok",
      miseStatus: "ok",
      commandStatus: "ok",
      packageStatus: "ok",
      updatedAt: status.lastCheckedAt,
    };
  }

  return {
    phase,
    dotfilesStatus: "unknown",
    miseStatus: "unknown",
    commandStatus: "unknown",
    packageStatus: "unknown",
    updatedAt: status.lastCheckedAt,
  };
}

function setupPhase(value: ProvisionerSetupPhase | undefined): SetupPhase {
  return value ?? "not_configured";
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function stringEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  return value;
}

function optionalUrlEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return value;
    }
  } catch {
    // Fall through to the config error below.
  }
  throw new Error(`${name} must be a relative path or http(s) URL`);
}
