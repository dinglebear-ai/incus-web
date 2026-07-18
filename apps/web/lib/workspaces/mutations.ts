import { apiErrorMessage } from "@/lib/api-error-message";
import type { WorkspaceState } from "@/lib/workspaces/types";

export type WorkspaceLifecycleAction = "start" | "stop" | "restart";

type MutationResult<T> = { started: false } | { started: true; value: T };
const pendingWorkspaces = new Set<string>();

async function runExclusive<T>(
  workspaceId: string,
  mutation: () => Promise<T>,
): Promise<MutationResult<T>> {
  if (pendingWorkspaces.has(workspaceId)) return { started: false };
  pendingWorkspaces.add(workspaceId);
  try {
    return { started: true, value: await mutation() };
  } finally {
    pendingWorkspaces.delete(workspaceId);
  }
}

export function lifecycleActionsFor(state: WorkspaceState): WorkspaceLifecycleAction[] {
  if (state === "running" || state === "degraded" || state === "setting_up") {
    return ["restart", "stop"];
  }
  if (state === "stopped" || state === "failed") return ["start"];
  return [];
}

export function lifecycleActionLabel(action: WorkspaceLifecycleAction) {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

export function dispatchWorkspaceLifecycle(
  workspaceId: string,
  action: WorkspaceLifecycleAction,
) {
  return runExclusive(workspaceId, async () => {
    const response = await fetch(`/api/workspaces/${workspaceId}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || body?.ok !== true) {
      throw new Error(apiErrorMessage(body, "workspace action failed"));
    }
    return body;
  });
}

export function createWorkspaceSnapshot(workspaceId: string, name?: string) {
  return runExclusive(workspaceId, async () => {
    const response = await fetch(`/api/workspaces/${workspaceId}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || undefined }),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || body?.ok !== true) {
      throw new Error(apiErrorMessage(body, "snapshot failed"));
    }
    return body;
  });
}
