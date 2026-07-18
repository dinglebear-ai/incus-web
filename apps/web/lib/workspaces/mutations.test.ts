import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkspaceSnapshot,
  dispatchWorkspaceLifecycle,
  lifecycleActionsFor,
} from "@/lib/workspaces/mutations";

afterEach(() => vi.unstubAllGlobals());

describe("workspace mutations", () => {
  it("derives lifecycle actions from workspace state", () => {
    expect(lifecycleActionsFor("running")).toEqual(["restart", "stop"]);
    expect(lifecycleActionsFor("stopped")).toEqual(["start"]);
    expect(lifecycleActionsFor("provisioning")).toEqual([]);
  });

  it("prevents overlapping mutations for the same workspace", async () => {
    let resolveLifecycle: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveLifecycle = resolve;
          }),
      )
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, snapshot: { name: "snap-1" } }),
      } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const lifecycle = dispatchWorkspaceLifecycle("workspace-1", "restart");
    await expect(createWorkspaceSnapshot("workspace-1")).resolves.toEqual({
      started: false,
    });

    resolveLifecycle?.({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response);
    await expect(lifecycle).resolves.toEqual({
      started: true,
      value: { ok: true },
    });
    await expect(createWorkspaceSnapshot("workspace-1")).resolves.toEqual({
      started: true,
      value: { ok: true, snapshot: { name: "snap-1" } },
    });
  });
});
