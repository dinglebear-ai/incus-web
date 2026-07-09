import { headers } from "next/headers";

import { AuthenticationRequiredError, getActorFromHeaders } from "@/lib/auth/identity";
import {
  BUILD_WORKER_CONTRACT_VERSION,
  type BuildWorkerCommand,
} from "@/lib/build-worker/contracts";
import { jsonError } from "@/lib/workspaces/route-helpers";

export async function buildWorkerRouteActor() {
  try {
    return { ok: true as const, actor: getActorFromHeaders(await headers()) };
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return { ok: false as const, response: jsonError("authentication_required", error.message, 401) };
    }
    throw error;
  }
}

export function buildWorkerCommand<TType extends BuildWorkerCommand["type"]>(
  type: TType,
  actor: { userId: string; email: string; displayName?: string; requestId: string },
  payload: Extract<BuildWorkerCommand, { type: TType }>["payload"],
): Extract<BuildWorkerCommand, { type: TType }> {
  return {
    version: BUILD_WORKER_CONTRACT_VERSION,
    requestId: actor.requestId,
    type,
    actor: buildWorkerActor(actor),
    payload,
  } as Extract<BuildWorkerCommand, { type: TType }>;
}

function buildWorkerActor(actor: { userId: string; email: string; displayName?: string }) {
  return {
    userId: actor.userId,
    email: actor.email,
    displayName: actor.displayName,
  };
}
