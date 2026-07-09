import { headers } from "next/headers";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import {
  getMutableWorkspaceRefForActor,
  getWorkspaceRefForActor,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";
import { recordWorkspaceActivity } from "@/lib/workspaces/activity";
import {
  jsonError,
  provisionerError,
  statusForProvisionerError,
} from "@/lib/workspaces/route-helpers";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
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
  const access = getWorkspaceRefForActor(actor);
  if (!access.ok) return provisionerError(access.error);
  if (access.workspace.id !== workspaceId) {
    return jsonError("workspace_not_found", "workspace was not found", 404);
  }

  const operation = await sendWorkspaceCommand(actor, "ListWorkspaceSnapshots", {});
  if (operation.status !== "succeeded") {
    return Response.json(
      { ok: false, operation },
      { status: statusForProvisionerError(operation.error) },
    );
  }
  return Response.json({ ok: true, operation, snapshots: operation.result?.snapshots ?? [] });
}

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
  const name = isRecord(body) && typeof body.name === "string" ? body.name.trim() : undefined;
  const operation = await sendWorkspaceCommand(actor, "CreateWorkspaceSnapshot", {
    ...(name ? { name } : {}),
  });
  if (operation.status !== "succeeded") {
    recordWorkspaceActivity(workspaceId, actor, "createSnapshot", "failed");
    return Response.json(
      { ok: false, operation },
      { status: statusForProvisionerError(operation.error) },
    );
  }
  recordWorkspaceActivity(workspaceId, actor, "createSnapshot", "succeeded");
  return Response.json({ ok: true, operation, snapshot: operation.result?.snapshot });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
