import { provisionerReadiness } from "@/lib/provisioner/readiness";
import { workspaceStateStoreStatus } from "@/lib/workspaces/state-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = workspaceStateStoreStatus();
  const provisioner = await provisionerReadiness();
  const ready = state.ok && provisioner.ok;
  const lines = [
    "# HELP incus_web_ready Whether the complete control plane is ready.",
    "# TYPE incus_web_ready gauge",
    `incus_web_ready ${ready ? 1 : 0}`,
    "# HELP incus_web_state_store_ready Whether durable workspace state is available.",
    "# TYPE incus_web_state_store_ready gauge",
    `incus_web_state_store_ready ${state.ok ? 1 : 0}`,
    "# HELP incus_web_provisioner_ready Whether the authenticated provisioner boundary is available.",
    "# TYPE incus_web_provisioner_ready gauge",
    `incus_web_provisioner_ready ${provisioner.ok ? 1 : 0}`,
    "# HELP incus_web_process_uptime_seconds Process uptime in seconds.",
    "# TYPE incus_web_process_uptime_seconds gauge",
    `incus_web_process_uptime_seconds ${process.uptime().toFixed(3)}`,
    "",
  ];

  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
