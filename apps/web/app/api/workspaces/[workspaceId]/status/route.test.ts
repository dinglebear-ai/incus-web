import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const workspace = {
  id: "workspace-incus-web",
  ownerUserId: "oidc:test@example.com",
  incusProject: "default",
  incusContainer: "incus-web",
};

const sendWorkspaceCommand = vi.fn();
const getWorkspaceRefForActor = vi.fn();

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-auth-request-email": "test@example.com" })),
}));

vi.mock("@/lib/workspaces/provisioner", () => ({
  getWorkspaceRefForActor: (...args: unknown[]) => getWorkspaceRefForActor(...args),
  sendWorkspaceCommand: (...args: unknown[]) => sendWorkspaceCommand(...args),
}));

describe("workspace status route", () => {
  beforeEach(() => {
    getWorkspaceRefForActor.mockReturnValue({ ok: true, workspace });
    sendWorkspaceCommand.mockReset();
  });

  it("rejects workspace mismatches without calling the provisioner", async () => {
    const response = await GET(new Request("http://localhost/api"), {
      params: Promise.resolve({ workspaceId: "other-workspace" }),
    });

    expect(response.status).toBe(404);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("returns a mapped workspace on success", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "GetWorkspaceStatus",
      workspaceId: workspace.id,
      status: "succeeded",
      result: {
        workspaceId: workspace.id,
        state: "running",
        incusProject: workspace.incusProject,
        incusContainer: workspace.incusContainer,
        cpuCount: 2,
        memoryUsedBytes: 100,
        memoryLimitBytes: 200,
        loadAverage: [0.1, 0.2, 0.3],
        setupPhase: "ready",
        lastCheckedAt: "2026-07-08T00:00:00.000Z",
      },
    });

    const response = await GET(new Request("http://localhost/api"), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      workspace: {
        id: workspace.id,
        state: "running",
        resources: { cpu: "2 vCPU" },
      },
    });
  });

  it("surfaces provisioner failures with a mapped status code", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "GetWorkspaceStatus",
      workspaceId: workspace.id,
      status: "failed",
      error: { code: "incus_unavailable", message: "incusd is down", retryable: true },
    });

    const response = await GET(new Request("http://localhost/api"), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
