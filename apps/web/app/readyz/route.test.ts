import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const provisionerReadiness = vi.fn();
vi.mock("@/lib/provisioner/readiness", () => ({
  provisionerReadiness: () => provisionerReadiness(),
}));

describe("readyz route", () => {
  beforeEach(() => provisionerReadiness.mockResolvedValue({ ok: true, configured: true }));

  it("reports dependency readiness", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("fails when the provisioner is unavailable", async () => {
    provisionerReadiness.mockResolvedValue({ ok: false, configured: true, message: "offline" });
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
