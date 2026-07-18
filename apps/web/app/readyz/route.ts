import { provisionerReadiness } from "@/lib/provisioner/readiness";
import { workspaceStateStoreStatus } from "@/lib/workspaces/state-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const stateStore = workspaceStateStoreStatus();
  const provisioner = await provisionerReadiness();
  const ok = stateStore.ok && provisioner.ok;
  return Response.json(
    {
      ok,
      dependencies: {
        stateStore: { ok: stateStore.ok },
        provisioner: {
          ok: provisioner.ok,
          configured: provisioner.configured,
        },
      },
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
