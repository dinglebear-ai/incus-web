import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const workspace = {
  id: "workspace-incus-web",
  ownerUserId: "oidc:test@example.com",
  incusProject: "default",
  incusContainer: "incus-web",
};

const sendWorkspaceCommand = vi.fn();
const getWorkspaceRefForActor = vi.fn();
const headersMock = vi.fn(
  async () => new Headers({ "x-auth-request-email": "test@example.com" }),
);

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

vi.mock("@/lib/workspaces/provisioner", () => ({
  getWorkspaceRefForActor: (...args: unknown[]) => getWorkspaceRefForActor(...args),
  sendWorkspaceCommand: (...args: unknown[]) => sendWorkspaceCommand(...args),
}));

function postAction(action: unknown, workspaceId = workspace.id) {
  return POST(
    new Request("http://localhost/api", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ workspaceId }) },
  );
}

describe("workspace actions route", () => {
  beforeEach(() => {
    getWorkspaceRefForActor.mockReturnValue({ ok: true, workspace });
    sendWorkspaceCommand.mockReset();
    headersMock.mockResolvedValue(
      new Headers({ "x-auth-request-email": "test@example.com" }),
    );
  });

  it("rejects requests missing a matching trusted proxy secret before calling the provisioner", async () => {
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");

    const response = await postAction("start");

    expect(response.status).toBe(401);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it("rejects an invalid action before calling the provisioner", async () => {
    const response = await postAction("delete");

    expect(response.status).toBe(400);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body before calling the provisioner", async () => {
    const response = await POST(
      new Request("http://localhost/api", { method: "POST", body: "not json" }),
      { params: Promise.resolve({ workspaceId: workspace.id }) },
    );

    expect(response.status).toBe(400);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("rejects workspace mismatches before calling the provisioner", async () => {
    const response = await postAction("start", "other-workspace");

    expect(response.status).toBe(404);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("dispatches a start action", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "StartWorkspace",
      workspaceId: workspace.id,
      status: "succeeded",
    });

    const response = await postAction("start");

    expect(response.status).toBe(200);
    expect(sendWorkspaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({ email: "test@example.com" }),
      "StartWorkspace",
      {},
    );
  });

  it("dispatches a stop action with the expected payload", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "StopWorkspace",
      workspaceId: workspace.id,
      status: "succeeded",
    });

    await postAction("stop");

    expect(sendWorkspaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({ email: "test@example.com" }),
      "StopWorkspace",
      { force: false, timeoutSeconds: 30 },
    );
  });

  it("dispatches a restart action with the expected payload", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "RestartWorkspace",
      workspaceId: workspace.id,
      status: "succeeded",
    });

    await postAction("restart");

    expect(sendWorkspaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({ email: "test@example.com" }),
      "RestartWorkspace",
      { timeoutSeconds: 30 },
    );
  });

  it("surfaces provisioner failures with a mapped status code", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "StartWorkspace",
      workspaceId: workspace.id,
      status: "failed",
      error: { code: "incus_unavailable", message: "incusd is down", retryable: true },
    });

    const response = await postAction("start");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
