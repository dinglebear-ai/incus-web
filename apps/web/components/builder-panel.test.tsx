import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuilderPanel } from "@/components/builder-panel";

describe("BuilderPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "build-test-key" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts in-flight build polling and clears the next timer on unmount", async () => {
    let pollSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/builds" && init?.method !== "POST") {
        return response({
          ok: true,
          images: { result: { images: [] } },
          presets: { result: { presets: [] } },
        });
      }
      if (target === "/api/builds" && init?.method === "POST") {
        return response({
          ok: true,
          operation: { result: { buildId: "build-1" } },
        });
      }
      if (target.startsWith("/api/builds/build-1")) {
        pollSignal = init?.signal ?? undefined;
        return response({
          ok: true,
          operation: {
            result: {
              buildId: "build-1",
              status: "running",
              imageAlias: "incus-web-custom",
              logOffset: 24,
              logChunk: "queued\nrunning\n",
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = render(<BuilderPanel />);

    fireEvent.click(screen.getByRole("button", { name: /build image/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/builds/build-1")),
      ).toBe(true);
    });
    expect(pollSignal?.aborted).toBe(false);

    unmount();

    expect(pollSignal?.aborted).toBe(true);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});

function response(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}
