import { headers } from "next/headers";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import {
  getWorkspaceRefForActor,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";
import { recordWorkspaceActivity } from "@/lib/workspaces/activity";
import {
  jsonError,
  provisionerError,
  statusForProvisionerError,
} from "@/lib/workspaces/route-helpers";

type WorkspaceAction = "start" | "stop" | "restart";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
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
  const body = await readActionBody(request);
  if (!body.ok) {
    return jsonError("invalid_action", body.message, 400);
  }
  const access = getWorkspaceRefForActor(actor);
  if (!access.ok) {
    return provisionerError(access.error);
  }
  if (access.workspace.id !== workspaceId) {
    return jsonError("workspace_not_found", "workspace was not found", 404);
  }

  const operation =
    body.action === "start"
      ? await sendWorkspaceCommand(actor, "StartWorkspace", {})
      : body.action === "stop"
        ? await sendWorkspaceCommand(actor, "StopWorkspace", {
            force: false,
            timeoutSeconds: 30,
          })
        : await sendWorkspaceCommand(actor, "RestartWorkspace", {
            timeoutSeconds: 30,
          });

  if (operation.status !== "succeeded") {
    recordWorkspaceActivity(workspaceId, actor, body.action, "failed");
    return Response.json(
      {
        ok: false,
        operation,
      },
      { status: statusForProvisionerError(operation.error) },
    );
  }

  recordWorkspaceActivity(workspaceId, actor, body.action, "succeeded");
  return Response.json({
    ok: true,
    operation,
  });
}

async function readActionBody(
  request: Request,
): Promise<{ ok: true; action: WorkspaceAction } | { ok: false; message: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, message: "request body must be JSON" };
  }
  if (!isRecord(body) || !isWorkspaceAction(body.action)) {
    return { ok: false, message: "action must be start, stop, or restart" };
  }
  return { ok: true, action: body.action };
}

function isWorkspaceAction(value: unknown): value is WorkspaceAction {
  return value === "start" || value === "stop" || value === "restart";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
