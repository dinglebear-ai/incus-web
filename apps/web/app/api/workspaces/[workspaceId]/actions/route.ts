import { headers } from "next/headers";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import {
  getWorkspaceRefForActor,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";

type WorkspaceAction = "start" | "stop" | "restart";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
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
  const body = await readActionBody(request);
  if (!body.ok) {
    return jsonError("invalid_action", body.message, 400);
  }
  const access = getWorkspaceRefForActor(actor);
  if (!access.ok) {
    return provisionerError(access.error);
  }
  if (access.workspace.id !== workspaceId) {
    return jsonError("workspace_not_found", "workspace was not found", 404);
  }

  const operation =
    body.action === "start"
      ? await sendWorkspaceCommand(actor, "StartWorkspace", {})
      : body.action === "stop"
        ? await sendWorkspaceCommand(actor, "StopWorkspace", {
            force: false,
            timeoutSeconds: 30,
          })
        : await sendWorkspaceCommand(actor, "RestartWorkspace", {
            timeoutSeconds: 30,
          });

  if (operation.status !== "succeeded") {
    return Response.json(
      {
        ok: false,
        operation,
      },
      { status: statusForProvisionerError(operation.error) },
    );
  }

  return Response.json({
    ok: true,
    operation,
  });
}

async function readActionBody(
  request: Request,
): Promise<{ ok: true; action: WorkspaceAction } | { ok: false; message: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, message: "request body must be JSON" };
  }
  if (!isRecord(body) || !isWorkspaceAction(body.action)) {
    return { ok: false, message: "action must be start, stop, or restart" };
  }
  return { ok: true, action: body.action };
}

function isWorkspaceAction(value: unknown): value is WorkspaceAction {
  return value === "start" || value === "stop" || value === "restart";
}

function jsonError(code: string, message: string, status: number) {
  return Response.json(
    {
      ok: false,
      error: {
        code,
        message,
      },
    },
    { status },
  );
}

function provisionerError(error: {
  code: string;
  message: string;
  retryable: boolean;
}) {
  return Response.json(
    {
      ok: false,
      error,
    },
    { status: statusForProvisionerError(error) },
  );
}

function statusForProvisionerError(
  error: { code: string; retryable: boolean } | undefined,
) {
  if (!error) return 409;
  if (error.retryable) return 503;
  if (
    error.code === "unauthenticated_service" ||
    error.code === "mutation_not_authorized"
  ) {
    return 403;
  }
  if (error.code === "invalid_input" || error.code === "metadata_mismatch") {
    return 400;
  }
  return 409;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
