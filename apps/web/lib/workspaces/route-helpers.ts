import { headers } from "next/headers";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import type { ProvisionerError } from "@/lib/provisioner/contracts";
import {
  getMutableWorkspaceRefForActor,
  getWorkspaceRefForActor,
} from "@/lib/workspaces/provisioner";

type WorkspaceRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function requireWorkspaceActor(
  context: WorkspaceRouteContext,
  { mutable = false }: { mutable?: boolean } = {},
) {
  let actor;
  try {
    actor = getActorFromHeaders(await headers());
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return { ok: false as const, response: jsonError("authentication_required", error.message, 401) };
    }
    throw error;
  }

  const { workspaceId } = await context.params;
  const access = mutable ? getMutableWorkspaceRefForActor(actor) : getWorkspaceRefForActor(actor);
  if (!access.ok) return { ok: false as const, response: provisionerError(access.error) };
  if (access.workspace.id !== workspaceId) {
    return { ok: false as const, response: jsonError("workspace_not_found", "workspace was not found", 404) };
  }
  return { ok: true as const, actor, workspace: access.workspace, workspaceId };
}

export function jsonError(code: string, message: string, status: number) {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

export function provisionerError(error: ProvisionerError) {
  return Response.json({ ok: false, error }, { status: statusForProvisionerError(error) });
}

export function statusForProvisionerError(error: ProvisionerError | undefined) {
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
  if (error.code === "missing_controller_config") return 424;
  if (error.code === "not_implemented") return 501;
  return 409;
}
