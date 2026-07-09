import { sendWorkspaceCommand } from "@/lib/workspaces/provisioner";
import { recordWorkspaceActivity } from "@/lib/workspaces/activity";
import {
  requireWorkspaceActor,
  statusForProvisionerError,
} from "@/lib/workspaces/route-helpers";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const route = await requireWorkspaceActor(context);
  if (!route.ok) return route.response;
  const { actor } = route;

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
  const route = await requireWorkspaceActor(context, { mutable: true });
  if (!route.ok) return route.response;
  const { actor, workspaceId } = route;

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
