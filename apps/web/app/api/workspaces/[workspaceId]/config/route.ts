import { headers } from "next/headers";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import {
  getMutableWorkspaceRefForActor,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";
import { recordWorkspaceActivity } from "@/lib/workspaces/activity";
import {
  jsonError,
  provisionerError,
  statusForProvisionerError,
} from "@/lib/workspaces/route-helpers";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  let actor;
  try {
    actor = getActorFromHeaders(await headers());
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return jsonError("authentication_required", error.message, 401);
    }
    throw error;
  }

  const { workspaceId } = await context.params;
  const access = getMutableWorkspaceRefForActor(actor);
  if (!access.ok) return provisionerError(access.error);
  if (access.workspace.id !== workspaceId) {
    return jsonError("workspace_not_found", "workspace was not found", 404);
  }

  const body = await request.json().catch(() => undefined);
  if (!isRecord(body) || typeof body.action !== "string") {
    return jsonError("invalid_action", "action is required", 400);
  }

  const operation =
    body.action === "setLimits"
      ? await sendWorkspaceCommand(actor, "SetWorkspaceLimits", {
          ...(typeof body.cpu === "string" && body.cpu.trim()
            ? { cpu: body.cpu.trim() }
            : {}),
          ...(typeof body.memory === "string" && body.memory.trim()
            ? { memory: body.memory.trim() }
            : {}),
        })
      : body.action === "setMount"
        ? await sendWorkspaceCommand(actor, "SetWorkspaceMount", {
            hostPath: typeof body.hostPath === "string" ? body.hostPath.trim() : "",
          })
        : body.action === "clearMount"
          ? await sendWorkspaceCommand(actor, "ClearWorkspaceMount", {})
          : undefined;

  if (!operation) {
    return jsonError("invalid_action", "unsupported workspace config action", 400);
  }
  if (operation.status !== "succeeded") {
    recordWorkspaceActivity(workspaceId, actor, body.action, "failed");
    return Response.json(
      { ok: false, operation },
      { status: statusForProvisionerError(operation.error) },
    );
  }
  recordWorkspaceActivity(workspaceId, actor, body.action, "succeeded");
  return Response.json({ ok: true, operation });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
