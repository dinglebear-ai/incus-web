import { headers } from "next/headers";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import {
  getWorkspaceRefForActor,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";
import {
  normalizeAgentRepoInput,
  validateDispatchAgentRunPayload,
  validateListAgentRunsPayload,
  type DispatchAgentRunPayload,
} from "@/lib/provisioner/contracts";
import {
  jsonError,
  provisionerError,
  statusForProvisionerError,
} from "@/lib/workspaces/route-helpers";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  const prepared = await prepareRequest(context);
  if (!prepared.ok) return prepared.response;

  const limit = limitFromUrl(request.url);
  const payload = validateListAgentRunsPayload({ limit });
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
  return Response.json({ ok: true, operation, runs: operation.result?.runs ?? [] });
}

export async function POST(request: Request, context: RouteContext) {
  const prepared = await prepareRequest(context);
  if (!prepared.ok) return prepared.response;

  const body = await readJsonBody(request);
  if (!body.ok) {
    return jsonError("invalid_agent_run", body.message, 400);
  }
  const payload = validateDispatchAgentRunPayload(normalizeDispatchInput(body.value));
  if (!payload.ok) {
    return provisionerError(payload.error);
  }

  const operation = await sendWorkspaceCommand(
    prepared.actor,
    "DispatchAgentRun",
    normalizeDispatchPayload(payload.value),
  );
  if (operation.status !== "succeeded") {
    return Response.json(
      { ok: false, operation },
      { status: statusForProvisionerError(operation.error) },
    );
  }
  return Response.json({ ok: true, operation, run: operation.result?.run });
}

function normalizeDispatchInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = value as Record<string, unknown>;
  return {
    ...payload,
    repoUrl:
      typeof payload.repoUrl === "string"
        ? normalizeAgentRepoInput(payload.repoUrl)
        : payload.repoUrl,
  };
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

  const { workspaceId } = await context.params;
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
  return { ok: true as const, actor };
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, message: "request body must be JSON" };
  }
}

function normalizeDispatchPayload(
  payload: DispatchAgentRunPayload,
): DispatchAgentRunPayload {
  return {
    agent: payload.agent,
    repoUrl: payload.repoUrl.trim(),
    task: payload.task.trim(),
    ...(payload.ref ? { ref: payload.ref.trim() } : {}),
  };
}

function limitFromUrl(url: string) {
  const raw = new URL(url).searchParams.get("limit");
  const parsed = raw ? Number(raw) : 20;
  if (!Number.isInteger(parsed)) return 20;
  return Math.min(100, Math.max(1, parsed));
}

