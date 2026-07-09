import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const workspace = {
  id: "workspace-incus-web",
  ownerUserId: "oidc:test@example.com",
  incusProject: "default",
  incusContainer: "incus-web",
};

const run = {
  id: "run_20260702000102_ab12cd34",
  workspaceId: workspace.id,
  ownerUserId: workspace.ownerUserId,
  container: {
    name: "agent-run-ab12cd34",
    project: "default",
    sourceContainer: "incus-web-agent-golden",
    sourceProject: "default",
    createdFrom: "golden",
    state: "planned",
  },
  agent: "codex",
  repoUrl: "https://github.com/jmagar/incus-web",
  task: "Run tests",
  phase: "queued",
  status: "queued",
  createdAt: "2026-07-02T00:01:02.000Z",
  updatedAt: "2026-07-02T00:01:02.000Z",
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

function getRun(runId: string, workspaceId = workspace.id) {
  return GET(new Request("http://localhost/api"), {
    params: Promise.resolve({ workspaceId, runId }),
  });
}

describe("agent-runs/[runId] route", () => {
  beforeEach(() => {
    getWorkspaceRefForActor.mockReturnValue({ ok: true, workspace });
    sendWorkspaceCommand.mockReset();
    headersMock.mockResolvedValue(
      new Headers({ "x-auth-request-email": "test@example.com" }),
    );
  });

  it("rejects requests missing a matching trusted proxy secret before calling the provisioner", async () => {
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");

    const response = await getRun(run.id);

    expect(response.status).toBe(401);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it("rejects workspace mismatches before calling the provisioner", async () => {
    const response = await getRun(run.id, "other-workspace");

    expect(response.status).toBe(404);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("returns the matching run", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "ListAgentRuns",
      workspaceId: workspace.id,
      status: "succeeded",
      result: { runs: [run] },
    });

    const response = await getRun(run.id);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      run: { id: run.id },
    });
  });

  it("returns 404 when the run id is not found in the list", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "ListAgentRuns",
      workspaceId: workspace.id,
      status: "succeeded",
      result: { runs: [] },
    });

    const response = await getRun("run_does_not_exist");

    expect(response.status).toBe(404);
  });

  it("surfaces provisioner failures with a mapped status code", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "ListAgentRuns",
      workspaceId: workspace.id,
      status: "failed",
      error: { code: "incus_unavailable", message: "incusd is down", retryable: true },
    });

    const response = await getRun(run.id);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
