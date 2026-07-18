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

const TELEMETRY_SAMPLE_INTERVAL_MS = 5_000;
const MAX_STATUS_SNAPSHOTS = 256;

type WorkspaceSnapshot = {
  operation: ProvisionerOperation<"GetWorkspaceStatus">;
  workspace?: ReturnType<typeof statusToWorkspace>;
  history?: ReturnType<typeof appendTelemetry>;
};

// A dashboard can be open in several tabs whose polling intervals are offset.
// Cache the completed status and telemetry history for one short sampling
// interval so those viewers neither fan out provisioner calls nor persist a
// separate sample. The in-flight map covers viewers arriving during refresh.
const statusSnapshots = new Map<
  string,
  { expiresAt: number; snapshot: WorkspaceSnapshot }
>();
const inFlightStatusRequests = new Map<
  string,
  Promise<WorkspaceSnapshot>
>();
function cachedWorkspaceStatus(
  actor: ActorContext,
  workspaceId: string,
  ownerUserId: string,
): Promise<WorkspaceSnapshot> {
  const cached = statusSnapshots.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.snapshot);
  }
  statusSnapshots.delete(workspaceId);

  const existing = inFlightStatusRequests.get(workspaceId);
  if (existing) return existing;

  const promise: Promise<WorkspaceSnapshot> = sendWorkspaceCommand(actor, "GetWorkspaceStatus", {})
    .then((operation) => {
      if (operation.status !== "succeeded" || !operation.result) {
        return { operation };
      }
      const workspace = statusToWorkspace(operation.result, ownerUserId);
      const history = appendTelemetrySample(workspaceId, workspace);
      const snapshot = { operation, workspace, history };
      statusSnapshots.set(workspaceId, {
        expiresAt: Date.now() + TELEMETRY_SAMPLE_INTERVAL_MS,
        snapshot,
      });
      while (statusSnapshots.size > MAX_STATUS_SNAPSHOTS) {
        const oldestWorkspaceId = statusSnapshots.keys().next().value;
        if (oldestWorkspaceId === undefined) break;
        statusSnapshots.delete(oldestWorkspaceId);
      }
      return snapshot;
    })
    .finally(() => {
      inFlightStatusRequests.delete(workspaceId);
    });
  inFlightStatusRequests.set(workspaceId, promise);
  return promise;
}

export function resetWorkspaceStatusCacheForTests() {
  statusSnapshots.clear();
  inFlightStatusRequests.clear();
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

  let snapshot;
  try {
    snapshot = await cachedWorkspaceStatus(
      actor,
      workspaceId,
      access.workspace.ownerUserId,
    );
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
  const { operation } = snapshot;
  if (operation.status !== "succeeded" || !operation.result) {
    return Response.json(
      { ok: false, operation },
      { status: statusForProvisionerError(operation.error) },
    );
  }

  const { workspace, history } = snapshot;
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
