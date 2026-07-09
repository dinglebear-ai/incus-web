import type { ActorContext } from "@/lib/workspaces/types";
import {
  listActivity,
  recordActivity,
  type WorkspaceActivityEntry,
} from "@/lib/workspaces/state-store";

export type { WorkspaceActivityEntry };

export function recordWorkspaceActivity(
  workspaceId: string,
  actor: ActorContext,
  action: string,
  status: "succeeded" | "failed",
) {
  recordActivity({
    at: new Date().toISOString(),
    workspaceId,
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action,
    status,
  });
}

export function listWorkspaceActivity(workspaceId: string) {
  return listActivity(workspaceId);
}
