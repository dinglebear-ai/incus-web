import { headers } from "next/headers";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import {
  getWorkspaceRefForActor,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";
import { validateListAgentRunsPayload } from "@/lib/provisioner/contracts";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
    runId: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const prepared = await prepareRequest(context);
  if (!prepared.ok) return prepared.response;

  const payload = validateListAgentRunsPayload({ limit: 100 });
  if (!payload.ok) {
    return provisionerError(payload.error);
  }

  const operation = await sendWorkspaceCommand(
    prepared.actor,
    "ListAgentRuns",
    payload.value,
  );
  if (operation.status !== "succeeded") {
    return Response.json(
      { ok: false, operation },
      { status: statusForProvisionerError(operation.error) },
    );
  }

  const run = operation.result?.runs.find((candidate) => candidate.id === prepared.runId);
  if (!run) {
    return jsonError("agent_run_not_found", "agent run was not found", 404);
  }
  return Response.json({ ok: true, operation, run });
}

async function prepareRequest(context: RouteContext) {
  let actor;
  try {
    actor = getActorFromHeaders(await headers());
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return {
        ok: false as const,
        response: jsonError("authentication_required", error.message, 401),
      };
    }
    throw error;
  }

  const { workspaceId, runId } = await context.params;
  const access = getWorkspaceRefForActor(actor);
  if (!access.ok) {
    return { ok: false as const, response: provisionerError(access.error) };
  }
  if (access.workspace.id !== workspaceId) {
    return {
      ok: false as const,
      response: jsonError("workspace_not_found", "workspace was not found", 404),
    };
  }
  return { ok: true as const, actor, runId };
}

function jsonError(code: string, message: string, status: number) {
  return Response.json({ ok: false, error: { code, message } }, { status });
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
  if (error.code === "unauthenticated_service") return 403;
  if (error.code === "invalid_input" || error.code === "metadata_mismatch") {
    return 400;
  }
  if (error.code === "missing_controller_config") return 424;
  if (error.code === "not_implemented") return 501;
  return 409;
}
