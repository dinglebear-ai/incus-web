import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GoldenConfigImport } from "@/components/golden-config-import";
import type { Workspace } from "@/lib/workspaces/types";

const workspace = {
  id: "workspace-incus-web",
  ownerUserId: "oidc:test@example.com",
  name: "incus-web",
  slug: "incus-web",
  incusProject: "incus-web",
  incusContainer: "incus-web",
  templateVersion: "ubuntu-24.04-code-v1",
  state: "running",
  resourceProfileId: "local-dev",
  resources: { cpu: "2 vCPU", memory: "96 MiB / 4 GiB", storage: "5 GiB / 20 GiB" },
  metrics: {
    cpuCount: 2,
    memoryUsedBytes: 1,
    memoryLimitBytes: 1,
    rootDiskUsedBytes: 1,
    rootDiskLimitBytes: 1,
    loadAverage: [0, 0, 0] as [number, number, number],
  },
  setup: {
    phase: "ready",
    dotfilesStatus: "ok",
    miseStatus: "ok",
    commandStatus: "ok",
    packageStatus: "ok",
  },
  createdAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:00.000Z",
} satisfies Workspace;

function selectFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("GoldenConfigImport", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads the chosen file as a raw application/zip body and shows the result summary", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        operation: {
          status: "succeeded",
          result: {
            workspaceId: workspace.id,
            extractedAt: "2026-07-09T00:00:00.000Z",
            fileCount: 721,
            warnings: ["2 item(s) were skipped during export"],
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<GoldenConfigImport workspace={workspace} />);
    selectFile(new File(["zip-bytes"], "golden-config.zip", { type: "application/zip" }));

    await waitFor(() => {
      expect(screen.getByText(/Imported 721 files/)).toBeInTheDocument();
    });
    expect(screen.getByText(/2 item\(s\) were skipped/)).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/${workspace.id}/golden-config`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/zip" },
      }),
    );
  });

  it("shows the provisioner error message when the import fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: false,
          operation: {
            status: "failed",
            error: {
              code: "golden_config_failed",
              message: "unzip is not installed in this container image",
              retryable: false,
            },
          },
        }),
      }),
    );

    render(<GoldenConfigImport workspace={workspace} />);
    selectFile(new File(["zip-bytes"], "golden-config.zip", { type: "application/zip" }));

    await waitFor(() => {
      expect(
        screen.getByText("unzip is not installed in this container image"),
      ).toBeInTheDocument();
    });
  });
});
