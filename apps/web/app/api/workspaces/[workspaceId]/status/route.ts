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
import {
  jsonError,
  provisionerError,
  statusForProvisionerError,
} from "@/lib/workspaces/route-helpers";
import type { ActorContext } from "@/lib/workspaces/types";
import type { ProvisionerOperation } from "@/lib/provisioner/contracts";
import { appendTelemetry } from "@/lib/workspaces/state-store";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

// Coalesces genuinely concurrent `GetWorkspaceStatus` polls for the same
// workspace into a single provisioner round trip — e.g. multiple open
// dashboard tabs (or, later, multiple visible cards) polling the same
// workspace at the same moment. This intentionally does NOT cache the
// result past the in-flight request: it's removed from the map as soon as
// it settles, so every poll after that still gets a fresh provisioner call
// and no request is ever served stale data from a prior tick.
const inFlightStatusRequests = new Map<
  string,
  Promise<ProvisionerOperation<"GetWorkspaceStatus">>
>();
function cachedWorkspaceStatus(actor: ActorContext, workspaceId: string) {
  const existing = inFlightStatusRequests.get(workspaceId);
  if (existing) return existing;

  const promise = sendWorkspaceCommand(actor, "GetWorkspaceStatus", {}).finally(() => {
    inFlightStatusRequests.delete(workspaceId);
  });
  inFlightStatusRequests.set(workspaceId, promise);
  return promise;
}

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

  const operation = await cachedWorkspaceStatus(actor, workspaceId);
  if (operation.status !== "succeeded" || !operation.result) {
    return Response.json(
      { ok: false, operation },
      { status: statusForProvisionerError(operation.error) },
    );
  }

  const workspace = statusToWorkspace(operation.result, access.workspace.ownerUserId);
  let history;
  try {
    history = appendTelemetrySample(workspaceId, workspace);
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "workspace_state_unavailable",
          message: error instanceof Error ? error.message : "workspace state database unavailable",
        },
      },
      { status: 503 },
    );
  }
  return Response.json({ ok: true, workspace, history });
}

function appendTelemetrySample(
  workspaceId: string,
  workspace: ReturnType<typeof statusToWorkspace>,
) {
  const memoryPercent = percentOf(
    workspace.metrics.memoryUsedBytes,
    workspace.metrics.memoryLimitBytes,
  );
  const cpuPercent = percentOf(
    workspace.metrics.loadAverage?.[0],
    workspace.metrics.cpuCount,
  );
  return appendTelemetry(workspaceId, { cpuPercent, memoryPercent });
}

function percentOf(value: number | undefined, total: number | undefined) {
  if (value === undefined || total === undefined || total <= 0) return undefined;
  return Math.min(100, Math.round((value / total) * 100));
}
