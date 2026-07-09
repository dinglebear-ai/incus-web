import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceSettingsPanel } from "@/components/workspace-settings-panel";
import type { Workspace } from "@/lib/workspaces/types";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh,
  }),
}));

const workspace: Workspace = {
  id: "workspace-incus-web",
  ownerUserId: "oidc:test@example.com",
  name: "incus-web",
  slug: "incus-web",
  incusProject: "incus-web",
  incusContainer: "incus-web",
  workspaceHostPath: "/srv/incus-web",
  templateVersion: "ubuntu-24.04-code-v1",
  state: "running",
  resourceProfileId: "local-dev",
  resources: {
    cpu: "2 vCPU",
    memory: "96 MiB / 4 GiB",
    storage: "5 GiB / 20 GiB",
    effectiveCpu: "2",
    effectiveMemory: "4GiB",
  },
  metrics: {},
  setup: {
    phase: "ready",
    dotfilesStatus: "ok",
    miseStatus: "ok",
    commandStatus: "ok",
    packageStatus: "ok",
  },
  createdAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:00.000Z",
};

describe("WorkspaceSettingsPanel", () => {
  beforeEach(() => {
    refresh.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith("/snapshots") && init?.method !== "POST") {
          return response({ ok: true, snapshots: [] });
        }
        return response({ ok: true });
      }),
    );
  });

  it("resynchronizes fields from refreshed workspace props", () => {
    const { rerender } = render(<WorkspaceSettingsPanel workspace={workspace} />);

    expect(screen.getByLabelText(/CPU limit/i)).toHaveValue("2");
    expect(screen.getByLabelText(/Memory limit/i)).toHaveValue("4GiB");
    expect(screen.getByLabelText(/Workspace host path/i)).toHaveValue("/srv/incus-web");

    rerender(
      <WorkspaceSettingsPanel
        workspace={{
          ...workspace,
          workspaceHostPath: "/srv/updated",
          resources: {
            ...workspace.resources,
            effectiveCpu: "6",
            effectiveMemory: "12GiB",
          },
        }}
      />,
    );

    expect(screen.getByLabelText(/CPU limit/i)).toHaveValue("6");
    expect(screen.getByLabelText(/Memory limit/i)).toHaveValue("12GiB");
    expect(screen.getByLabelText(/Workspace host path/i)).toHaveValue("/srv/updated");
  });

  it("clears the mount field after a successful reset", async () => {
    render(<WorkspaceSettingsPanel workspace={workspace} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Workspace host path/i)).toHaveValue("");
    });
    expect(refresh).toHaveBeenCalled();
  });
});

function response(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}
