import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuilderPanel } from "@/components/builder-panel";

describe("BuilderPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "build-test-key" });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("requires review before building with imported commands", async () => {
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
        return response({
          ok: true,
          operation: {
            result: {
              buildId: "build-1",
              status: "succeeded",
              imageAlias: "incus-web-custom",
              logOffset: 0,
              logChunk: "",
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BuilderPanel />);

    const input = document.querySelector('input[accept=".json"]') as HTMLInputElement;
    const file = {
      name: "devcontainer.json",
      text: async () => JSON.stringify({ image: "debian:trixie", postCreateCommand: "echo imported" }),
    };
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    fireEvent.change(input);

    expect(await screen.findByText("Review imported commands")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /build image/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reviewed" }));
    fireEvent.click(screen.getByRole("button", { name: /build image/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === "/api/builds" && init?.method === "POST",
        ),
      ).toBe(true);
    });
  });

  it("continues polling with log offsets and refreshes the registry when complete", async () => {
    const originalSetTimeout = window.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(window, "setTimeout")
      .mockImplementation((callback: TimerHandler, _timeout?: number, ...args: unknown[]) =>
        originalSetTimeout(callback, 0, ...args),
      );
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
      if (target === "/api/builds/build-1?offset=0") {
        return response({
          ok: true,
          operation: {
            result: {
              buildId: "build-1",
              status: "running",
              imageAlias: "incus-web-custom",
              logOffset: 24,
              logChunk: "running\n",
            },
          },
        });
      }
      if (target === "/api/builds/build-1?offset=24") {
        return response({
          ok: true,
          operation: {
            result: {
              buildId: "build-1",
              status: "succeeded",
              imageAlias: "incus-web-custom",
              logOffset: 40,
              logChunk: "done\n",
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BuilderPanel />);
    fireEvent.click(screen.getByRole("button", { name: /build image/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/builds/build-1?offset=0")).toBe(true);
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/builds/build-1?offset=24")).toBe(true);
    });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => String(url) === "/api/builds" && init?.method !== "POST",
        ),
      ).toHaveLength(2);
    });
    setTimeoutSpy.mockRestore();
  });

  it("bounds long build logs and discloses truncation", async () => {
    const hugeChunk = `${"start".padEnd(2000, "a")}${"tail".padStart(81_000, "z")}`;
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
        return response({
          ok: true,
          operation: {
            result: {
              buildId: "build-1",
              status: "succeeded",
              imageAlias: "incus-web-custom",
              logOffset: hugeChunk.length,
              logChunk: hugeChunk,
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<BuilderPanel />);
    fireEvent.click(screen.getByRole("button", { name: /build image/i }));

    expect(await screen.findByText(/Log truncated/)).toBeInTheDocument();
    const log = container.querySelector("pre")?.textContent ?? "";
    expect(log.length).toBeLessThanOrEqual(80_000);
    expect(log).not.toContain("start");
    expect(log.endsWith("tail")).toBe(true);
  });
});

function response(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}
