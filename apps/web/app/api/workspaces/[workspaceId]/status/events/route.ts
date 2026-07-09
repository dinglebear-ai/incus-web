import { headers } from "next/headers";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import {
  getWorkspaceRefForActor,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";
import { statusToWorkspace } from "@/lib/provisioner/status-adapter";
import { jsonError, provisionerError } from "@/lib/workspaces/route-helpers";

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

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const tick = async () => {
        if (closed) return;
        const operation = await sendWorkspaceCommand(actor, "GetWorkspaceStatus", {});
        if (operation.status === "succeeded" && operation.result) {
          const workspace = statusToWorkspace(operation.result, access.workspace.ownerUserId);
          controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(workspace)}\n\n`));
        } else {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(operation.error)}\n\n`));
        }
      };
      await tick();
      timer = setInterval(() => void tick(), 4000);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    },
  });
}
