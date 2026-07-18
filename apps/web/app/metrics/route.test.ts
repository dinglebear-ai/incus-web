import { beforeEach, describe, expect, it, vi } from "vitest";

const provisionerReadiness = vi.fn();
const workspaceStateStoreStatus = vi.fn();

vi.mock("@/lib/provisioner/readiness", () => ({ provisionerReadiness }));
vi.mock("@/lib/workspaces/state-store", () => ({ workspaceStateStoreStatus }));

describe("metrics route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workspaceStateStoreStatus.mockReturnValue({ ok: true });
    provisionerReadiness.mockResolvedValue({ ok: true });
  });

  it("exports dependency readiness as Prometheus gauges", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.text();
    expect(response.headers.get("content-type")).toContain("version=0.0.4");
    expect(body).toContain("incus_web_ready 1");
    expect(body).toContain("incus_web_state_store_ready 1");
    expect(body).toContain("incus_web_provisioner_ready 1");
  });
});
