import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";
import type { ActorContext } from "@/lib/workspaces/types";

const actor: ActorContext = {
  userId: "oidc:test@example.com",
  oidcSubject: "test@example.com",
  email: "test@example.com",
  displayName: "Test User",
  requestId: "req-test",
};

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

describe("agent-runs route", () => {
  beforeEach(() => {
    getWorkspaceRefForActor.mockReturnValue({ ok: true, workspace });
    sendWorkspaceCommand.mockReset();
    headersMock.mockResolvedValue(
      new Headers({ "x-auth-request-email": "test@example.com" }),
    );
  });

  it("rejects requests missing a matching trusted proxy secret before calling the provisioner", async () => {
    // A missing/mismatched proxy secret is an identity failure that's
    // independent of NODE_ENV/dev-identity fallback, so it's the reliable
    // way to exercise the route's 401 mapping at this layer without
    // fighting the dev-identity escape hatch.
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");
    headersMock.mockResolvedValue(
      new Headers({ "x-auth-request-email": "test@example.com" }),
    );

    const response = await GET(new Request("http://localhost/api"), {
      params: Promise.resolve({ workspaceId: workspace.id }),
    });

    expect(response.status).toBe(401);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it("rejects invalid dispatch bodies before calling the provisioner", async () => {
    const response = await POST(
      new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify({ agent: "codex", repoUrl: "file:///tmp/repo", task: "" }),
      }),
      { params: Promise.resolve({ workspaceId: workspace.id }) },
    );

    expect(response.status).toBe(400);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("rejects limit values above the maximum before calling the provisioner", async () => {
    const response = await GET(
      new Request("http://localhost/api?limit=101"),
      { params: Promise.resolve({ workspaceId: workspace.id }) },
    );

    expect(response.status).toBe(400);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("rejects limit values below the minimum before calling the provisioner", async () => {
    const response = await GET(
      new Request("http://localhost/api?limit=0"),
      { params: Promise.resolve({ workspaceId: workspace.id }) },
    );

    expect(response.status).toBe(400);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("rejects non-numeric limit values before calling the provisioner", async () => {
    const response = await GET(
      new Request("http://localhost/api?limit=abc"),
      { params: Promise.resolve({ workspaceId: workspace.id }) },
    );

    expect(response.status).toBe(400);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("rejects workspace mismatches", async () => {
    const response = await GET(new Request("http://localhost/api"), {
      params: Promise.resolve({ workspaceId: "other-workspace" }),
    });

    expect(response.status).toBe(404);
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("dispatches validated agent run payloads", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "DispatchAgentRun",
      workspaceId: workspace.id,
      status: "succeeded",
      result: {
        run: {
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
        },
      },
    });

    const response = await POST(
      new Request("http://localhost/api", {
        method: "POST",
        body: JSON.stringify({
          agent: "codex",
          repoUrl: "jmagar/incus-web",
          task: "Run tests",
        }),
      }),
      { params: Promise.resolve({ workspaceId: workspace.id }) },
    );

    expect(response.status).toBe(200);
    expect(sendWorkspaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({ email: actor.email }),
      "DispatchAgentRun",
      {
        agent: "codex",
        repoUrl: "https://github.com/jmagar/incus-web",
        task: "Run tests",
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      run: { id: "run_20260702000102_ab12cd34" },
    });
  });
});
