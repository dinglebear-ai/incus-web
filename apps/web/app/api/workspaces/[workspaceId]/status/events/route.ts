import { sendWorkspaceCommand } from "@/lib/workspaces/provisioner";
import { statusToWorkspace } from "@/lib/provisioner/status-adapter";
import { requireWorkspaceActor } from "@/lib/workspaces/route-helpers";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const route = await requireWorkspaceActor(context);
  if (!route.ok) return route.response;
  const { actor, workspace } = route;

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const tick = async () => {
        if (closed) return;
        const operation = await sendWorkspaceCommand(actor, "GetWorkspaceStatus", {});
        if (operation.status === "succeeded" && operation.result) {
          const status = statusToWorkspace(operation.result, workspace.ownerUserId);
          controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(status)}\n\n`));
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
