import { sendWorkspaceCommand } from "@/lib/workspaces/provisioner";
import { recordWorkspaceActivity } from "@/lib/workspaces/activity";
import {
  jsonError,
  requireWorkspaceActor,
  statusForProvisionerError,
} from "@/lib/workspaces/route-helpers";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const route = await requireWorkspaceActor(context, { mutable: true });
  if (!route.ok) return route.response;
  const { actor, workspaceId } = route;

  const body = await request.json().catch(() => undefined);
  if (!isRecord(body) || typeof body.action !== "string") {
    return jsonError("invalid_action", "action is required", 400);
  }

  const operation = await runConfigAction(actor, body);

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

function runConfigAction(
  actor: Parameters<typeof sendWorkspaceCommand>[0],
  body: Record<string, unknown>,
) {
  switch (body.action) {
    case "setLimits": {
      const cpu = trimmedString(body.cpu);
      const memory = trimmedString(body.memory);
      return sendWorkspaceCommand(actor, "SetWorkspaceLimits", {
        ...(cpu ? { cpu } : {}),
        ...(memory ? { memory } : {}),
      });
    }
    case "setMount":
      return sendWorkspaceCommand(actor, "SetWorkspaceMount", {
        hostPath: trimmedString(body.hostPath) ?? "",
      });
    case "clearMount":
      return sendWorkspaceCommand(actor, "ClearWorkspaceMount", {});
    default:
      return undefined;
  }
}

function trimmedString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
