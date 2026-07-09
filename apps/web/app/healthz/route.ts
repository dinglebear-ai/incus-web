import { workspaceStateStoreStatus } from "@/lib/workspaces/state-store";

export const dynamic = "force-dynamic";

export function GET() {
  const stateStore = workspaceStateStoreStatus();
  if (!stateStore.ok) {
    return Response.json(
      { ok: false, stateStore },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
