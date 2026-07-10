import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceDashboard } from "@/components/workspace-dashboard";
import type { WorkspaceInventory } from "@/lib/workspaces/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

const inventory: WorkspaceInventory = {
  actor: {
    userId: "oidc:test@example.com",
    oidcSubject: "test@example.com",
    email: "test@example.com",
    displayName: "Test User",
    requestId: "req-test",
  },
  workspaces: [
    {
      id: "workspace-incus-web",
      ownerUserId: "oidc:test@example.com",
      name: "incus-web",
      slug: "incus-web",
      incusProject: "incus-web",
      incusContainer: "incus-web",
      templateVersion: "ubuntu-24.04-code-v1",
      state: "running",
      resourceProfileId: "local-dev",
      resources: {
        cpu: "2 vCPU",
        memory: "96 MiB / 4 GiB",
        storage: "5 GiB / 20 GiB",
      },
      metrics: {
        cpuCount: 2,
        memoryUsedBytes: 96 * 1024 * 1024,
        memoryLimitBytes: 4 * 1024 * 1024 * 1024,
        rootDiskUsedBytes: 5 * 1024 * 1024 * 1024,
        rootDiskLimitBytes: 20 * 1024 * 1024 * 1024,
        loadAverage: [0.12, 0.2, 0.18],
      },
      setup: {
        phase: "ready",
        dotfilesStatus: "ok",
        miseStatus: "ok",
        commandStatus: "ok",
        packageStatus: "ok",
      },
      terminalUrl: "/terminal/",
      accessNote:
        "Private workspace. Sharing requires an explicit user or org grant.",
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    },
  ],
};

describe("WorkspaceDashboard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, runs: [] }),
      }),
    );
  });

  it("renders actor, workspace, setup status, and terminal link", () => {
    render(<WorkspaceDashboard inventory={inventory} />);

    expect(screen.getByText("Test User")).toBeInTheDocument();
    expect(screen.getByText("test@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "incus-web" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Setup")).toBeInTheDocument();
    expect(screen.getByText("complete")).toBeInTheDocument();
    expect(screen.queryByText("Commands")).not.toBeInTheDocument();
    expect(screen.queryByText("Packages")).not.toBeInTheDocument();
    expect(screen.queryByText("mise")).not.toBeInTheDocument();
    expect(screen.getAllByText("Dotfiles").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("ubuntu-24.04-code-v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restart/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /stop/i })).toBeEnabled();
    expect(
      screen.getAllByRole("link", { name: /open terminal/i }).at(-1),
    ).toHaveAttribute("href", "/terminal/");
    expect(screen.getByRole("button", { name: "Agent runs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Image builder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Workspace settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspector" })).toBeInTheDocument();
  });

  it("shows setup details while provisioning is not complete", () => {
    render(
      <WorkspaceDashboard
        inventory={{
          ...inventory,
          workspaces: [
            {
              ...inventory.workspaces[0],
              setup: {
                ...inventory.workspaces[0].setup,
                phase: "checking_tools",
                commandStatus: "ok",
                packageStatus: "warn",
                miseStatus: "ok",
              },
            },
          ],
        }}
      />,
    );

    expect(
      screen.queryByText("Setup: complete", { selector: "p" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Setup" })).toBeInTheDocument();
    expect(screen.getByText("Commands")).toBeInTheDocument();
    expect(screen.getByText("Packages")).toBeInTheDocument();
    expect(screen.getByText("mise")).toBeInTheDocument();
  });

  it("renders an empty-access state when no workspace is visible", () => {
    render(<WorkspaceDashboard inventory={{ ...inventory, workspaces: [] }} />);

    expect(screen.getByText("No workspace access")).toBeInTheDocument();
  });

  it("submits an agent run and displays progress identity", async () => {
    const failedCodexRun = {
      id: "run_20260702000102_ab12cd34",
      workspaceId: "workspace-incus-web",
      ownerUserId: "oidc:test@example.com",
      container: {
        name: "agent-run-ab12cd34",
        project: "default",
        sourceContainer: "incus-web-agent-golden",
        sourceProject: "default",
        createdFrom: "golden",
        state: "planned",
      },
      agent: "codex",
      repoUrl: "https://github.com/jmagar/incus-web.git",
      task: "Run tests",
      phase: "failed",
      status: "failed",
      createdAt: "2026-07-02T00:01:02.000Z",
      updatedAt: "2026-07-02T00:01:03.000Z",
      completedAt: "2026-07-02T00:01:03.000Z",
      controller: {
        kind: "codex-app-server",
        sessionId: "019f2afd-7578-7652-9908-fe628cb04f69",
        turnId: "019f2afd-76f6-7810-bd2f-0efc7d3bb190",
        url: "ws://127.0.0.1:40721",
      },
      lastLogExcerpt:
        "Codex app-server controller is not configured for this host.\nFull diagnostic line stays visible.",
      logs: [
        {
          at: "2026-07-02T00:01:02.500Z",
          level: "info",
          message: "Cloning incus-web-agent-golden into agent-run-ab12cd34",
        },
        {
          at: "2026-07-02T00:01:02.600Z",
          level: "info",
          message: "runner",
        },
        {
          at: "2026-07-02T00:01:02.700Z",
          level: "info",
          message: ",",
        },
        {
          at: "2026-07-02T00:01:02.800Z",
          level: "info",
          message: "then",
        },
        {
          at: "2026-07-02T00:01:02.900Z",
          level: "info",
          message: "create",
        },
        {
          at: "2026-07-02T00:01:02.950Z",
          level: "info",
          message: "the",
        },
        {
          at: "2026-07-02T00:01:02.980Z",
          level: "info",
          message: "issue",
        },
        {
          at: "2026-07-02T00:01:03.000Z",
          level: "error",
          message:
            "Codex app-server controller is not configured for this host.\nFull diagnostic line stays visible.",
        },
      ],
    };
    let agentListCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/builds") {
        return okResponse({
          ok: true,
          images: { result: { images: [] } },
          presets: { result: { presets: [] } },
        });
      }
      if (target.includes("/agent-runs") && init?.method === "POST") {
        return okResponse({ ok: true, run: failedCodexRun });
      }
      if (target.includes("/agent-runs")) {
        agentListCalls += 1;
        return okResponse({
          ok: true,
          runs: agentListCalls === 1 ? [] : [failedCodexRun],
        });
      }
      return okResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceDashboard inventory={inventory} />);

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/agent-runs")),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Agent runs" }));
    await screen.findByRole("heading", { name: "Agent runs" }, { timeout: 5000 });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("/agent-runs"),
        ),
      ).toHaveLength(1);
    });

    fireEvent.change(screen.getByLabelText(/Repo URL/), {
      target: { value: "jmagar/incus-web" },
    });
    fireEvent.change(screen.getByLabelText(/Task/), {
      target: { value: "Run tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: /dispatch run/i }));

    await waitFor(() => {
      expect(
        screen.getAllByText(/run_20260702000102_ab12cd34/).length,
      ).toBeGreaterThan(0);
    });
    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse(String((postCall?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      repoUrl: "https://github.com/jmagar/incus-web",
      task: "Run tests",
    });
    expect(screen.getAllByText(/agent-run-ab12cd34/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/codex-app-server/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("019f2afd-76f6-7810-bd2f-0efc7d3bb190").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Full diagnostic line stays visible/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "Cloning incus-web-agent-golden into agent-run-ab12cd34",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("runner, then create the issue").length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getByRole("heading", { name: "Session viewer" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ws://127.0.0.1:40721")).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Open full session viewer for run_20260702000102_ab12cd34",
      }),
    ).toHaveAttribute(
      "href",
      "/workspaces/workspace-incus-web/agent-runs/run_20260702000102_ab12cd34",
    );
  });

  it("keeps command dock actions accessible and opens settings mutations from the dashboard", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/builds") {
        return okResponse({
          ok: true,
          images: { result: { images: [] } },
          presets: { result: { presets: [] } },
        });
      }
      if (target.endsWith("/config") && init?.method === "POST") {
        return okResponse({ ok: true });
      }
      return okResponse({ ok: true, snapshots: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkspaceDashboard inventory={inventory} />);

    for (const action of ["Agent runs", "Image builder", "Workspace settings", "Inspector"]) {
      expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: "Workspace settings" }));
    await screen.findByRole("heading", { name: "Settings" });

    fireEvent.change(screen.getByLabelText(/CPU limit/i), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText(/Memory limit/i), {
      target: { value: "8GiB" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save limits/i }));

    await waitFor(() => {
      const configCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith("/config") &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(configCall).toBeTruthy();
      expect(JSON.parse(String((configCall?.[1] as RequestInit).body))).toEqual({
        action: "setLimits",
        cpu: "4",
        memory: "8GiB",
      });
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });
});

function okResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}
