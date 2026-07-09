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
import type { ProvisionerError } from "@/lib/provisioner/contracts";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

// Lightweight per-workspace status poll used by the dashboard's live
// telemetry — the client polls this on an interval instead of doing a full
// page reload (`router.refresh()`), which would re-run the whole server
// component tree just to pick up new CPU/memory numbers.
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
  if (!access.ok) {
    return provisionerError(access.error);
  }
  if (access.workspace.id !== workspaceId) {
    return jsonError("workspace_not_found", "workspace was not found", 404);
  }

  const operation = await sendWorkspaceCommand(actor, "GetWorkspaceStatus", {});
  if (operation.status !== "succeeded" || !operation.result) {
    return Response.json(
      { ok: false, operation },
      { status: statusForProvisionerError(operation.error) },
    );
  }

  const workspace = statusToWorkspace(operation.result, access.workspace.ownerUserId);
  return Response.json({ ok: true, workspace });
}

function jsonError(code: string, message: string, status: number) {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

function provisionerError(error: ProvisionerError) {
  return Response.json({ ok: false, error }, { status: statusForProvisionerError(error) });
}

function statusForProvisionerError(error: ProvisionerError | undefined) {
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
