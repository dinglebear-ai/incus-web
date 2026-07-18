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

  const stream = createStatusEventStream(async () => {
    const operation = await sendWorkspaceCommand(actor, "GetWorkspaceStatus", {});
    if (operation.status === "succeeded" && operation.result) {
      return { event: "status", data: statusToWorkspace(operation.result, workspace.ownerUserId) };
    }
    return { event: "error", data: operation.error };
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    },
  });
}

export function createStatusEventStream(
  load: () => Promise<{ event: string; data: unknown }>,
  intervalMs = 4000,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  return new ReadableStream({
    start(controller) {
      const tick = async () => {
        if (closed) return;
        try {
          const message = await load();
          if (closed) return;
          controller.enqueue(
            encoder.encode(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`),
          );
        } catch (error) {
          if (closed) return;
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : "status request failed" })}\n\n`,
            ),
          );
        }
        if (!closed) timer = setTimeout(() => void tick(), intervalMs);
      };
      void tick();
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  });
}
