import { listWorkspaceActivity } from "@/lib/workspaces/activity";
import { requireWorkspaceActor } from "@/lib/workspaces/route-helpers";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const route = await requireWorkspaceActor(context);
  if (!route.ok) return route.response;
  const { workspaceId } = route;
  try {
    return Response.json({ ok: true, activity: listWorkspaceActivity(workspaceId) });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "workspace_state_unavailable",
          message: error instanceof Error ? error.message : "workspace state database unavailable",
        },
      },
      { status: 503 },
    );
  }
}
