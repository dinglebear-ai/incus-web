import { listWorkspaceActivity } from "@/lib/workspaces/activity";
import { requireWorkspaceActor } from "@/lib/workspaces/route-helpers";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const route = await requireWorkspaceActor(context);
  if (!route.ok) return route.response;
  const { workspaceId } = route;
  return Response.json({ ok: true, activity: listWorkspaceActivity(workspaceId) });
}
