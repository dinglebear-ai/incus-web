import { sendBuildWorkerCommand } from "@/lib/build-worker/client";
import { buildWorkerCommand, buildWorkerRouteActor } from "@/lib/build-worker/route-helpers";

type RouteContext = {
  params: Promise<{ buildId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const actor = await buildWorkerRouteActor();
  if (!actor.ok) return actor.response;
  const { buildId } = await context.params;
  const offset = Number(new URL(request.url).searchParams.get("offset") ?? "0");
  const operation = await sendBuildWorkerCommand(
    buildWorkerCommand("GetBuildStatus", actor.actor, {
      buildId,
      logOffset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
    }),
  );
  return Response.json({ ok: operation.status === "succeeded", operation });
}
