import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceTelemetry } from "@/components/workspace-telemetry";
import type { Workspace } from "@/lib/workspaces/types";

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
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
      loadAverage: [0.12, 0.2, 0.18],
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
    ...overrides,
  };
}

describe("useWorkspaceTelemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reconciles refreshed snapshots and aborts stale fallback polls", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      }),
    );

    const original = workspace();
    const { result, rerender } = renderHook(
      ({ initial }) => useWorkspaceTelemetry(initial),
      { initialProps: { initial: original } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);

    const refreshed = workspace({
      state: "stopped",
      updatedAt: "2026-06-30T00:01:00.000Z",
    });
    rerender({ initial: refreshed });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.workspace).toEqual(refreshed);
    expect(requestSignal?.aborted).toBe(true);

    await act(async () => {
      resolveFetch?.({
        ok: true,
        json: async () => ({
          ok: true,
          workspace: workspace({
            updatedAt: "2026-06-30T00:00:30.000Z",
          }),
        }),
      } as Response);
      await Promise.resolve();
    });

    expect(result.current.workspace).toEqual(refreshed);
    expect(result.current.polling).toBe(false);
  });

  it("starts live telemetry when refresh transitions stopped to running", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const stopped = workspace({ state: "stopped" });
    const { result, rerender } = renderHook(
      ({ initial }) => useWorkspaceTelemetry(initial),
      { initialProps: { initial: stopped } },
    );

    const running = workspace({
      state: "running",
      updatedAt: "2026-06-30T00:01:00.000Z",
    });
    rerender({ initial: running });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.workspace).toEqual(running);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetch).toHaveBeenCalledWith(
      `/api/workspaces/${running.id}/status`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
