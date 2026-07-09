import { headers } from "next/headers";

import { BUILD_WORKER_CONTRACT_VERSION } from "@/lib/build-worker/contracts";
import { sendBuildWorkerCommand } from "@/lib/build-worker/client";
import { AuthenticationRequiredError, getActorFromHeaders } from "@/lib/auth/identity";
import { jsonError } from "@/lib/workspaces/route-helpers";

type RouteContext = {
  params: Promise<{ buildId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  let actor;
  try {
    actor = getActorFromHeaders(await headers());
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return jsonError("authentication_required", error.message, 401);
    }
    throw error;
  }
  const { buildId } = await context.params;
  const offset = Number(new URL(request.url).searchParams.get("offset") ?? "0");
  const operation = await sendBuildWorkerCommand({
    version: BUILD_WORKER_CONTRACT_VERSION,
    requestId: actor.requestId,
    type: "GetBuildStatus",
    actor: {
      userId: actor.userId,
      email: actor.email,
      displayName: actor.displayName,
    },
    payload: {
      buildId,
      logOffset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
    },
  });
  return Response.json({ ok: operation.status === "succeeded", operation });
}
