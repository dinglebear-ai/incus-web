import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const sendBuildWorkerCommand = vi.fn();
const headersMock = vi.fn(
  async () => new Headers({ "x-auth-request-email": "test@example.com" }),
);

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

vi.mock("@/lib/build-worker/client", () => ({
  sendBuildWorkerCommand: (...args: unknown[]) => sendBuildWorkerCommand(...args),
}));

describe("builds route", () => {
  beforeEach(() => {
    sendBuildWorkerCommand.mockReset();
    headersMock.mockResolvedValue(
      new Headers({ "x-auth-request-email": "test@example.com" }),
    );
    vi.unstubAllEnvs();
  });

  it("requires identity before listing builds", async () => {
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");

    const response = await GET();

    expect(response.status).toBe(401);
    expect(sendBuildWorkerCommand).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it("sends a tenant-scoped image alias on dispatch", async () => {
    vi.stubEnv("INCUS_WEB_BUILD_WORKER_ALLOWED_ACTORS", "test@example.com");
    sendBuildWorkerCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "DispatchBuildImage",
      status: "succeeded",
      result: { buildId: "build_1" },
      completedAt: new Date().toISOString(),
    });

    const response = await POST(
      new Request("http://localhost/api/builds", {
        method: "POST",
        body: JSON.stringify({
          action: "dispatch",
          distro: "debian",
          release: "trixie",
          packages: ["git"],
          postInstallCommands: [],
          imageAlias: "Shared Alias",
          idempotencyKey: "idem-1",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(sendBuildWorkerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "DispatchBuildImage",
        payload: expect.objectContaining({
          imageAlias: expect.stringMatching(/^incus-web-[0-9a-f]{12}-shared-alias$/),
        }),
      }),
    );
  });

  it("preserves partial list failures in the response envelope", async () => {
    sendBuildWorkerCommand
      .mockResolvedValueOnce({
        id: "op-images",
        requestId: "req-images",
        type: "ListBuildImages",
        status: "succeeded",
        result: { images: [] },
        completedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        id: "op-presets",
        requestId: "req-presets",
        type: "ListBuildPresets",
        status: "failed",
        error: { code: "operation_failed", message: "boom", retryable: true },
        completedAt: new Date().toISOString(),
      });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.images.status).toBe("succeeded");
    expect(body.presets.status).toBe("failed");
  });

  it("returns ok false when worker dispatch validation fails", async () => {
    vi.stubEnv("INCUS_WEB_BUILD_WORKER_ALLOWED_ACTORS", "test@example.com");
    sendBuildWorkerCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "DispatchBuildImage",
      status: "failed",
      error: { code: "invalid_input", message: "bad image", retryable: false },
      completedAt: new Date().toISOString(),
    });

    const response = await POST(
      new Request("http://localhost/api/builds", {
        method: "POST",
        body: JSON.stringify({
          action: "dispatch",
          distro: "debian",
          release: "trixie",
          packages: ["git"],
          postInstallCommands: [],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.operation.status).toBe("failed");
    expect(body.operation.error.message).toBe("bad image");
  });

  it("requires a trusted builder for privileged build actions in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");
    headersMock.mockResolvedValue(
      new Headers({
        "x-auth-request-email": "test@example.com",
        "x-incus-web-proxy-secret": "shh",
      }),
    );

    const response = await POST(
      new Request("http://localhost/api/builds", {
        method: "POST",
        body: JSON.stringify({
          action: "dispatch",
          distro: "debian",
          release: "trixie",
          packages: ["git"],
          postInstallCommands: [],
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(sendBuildWorkerCommand).not.toHaveBeenCalled();
  });

  it("requires a trusted builder for preset and master actions in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "shh");
    headersMock.mockResolvedValue(
      new Headers({
        "x-auth-request-email": "test@example.com",
        "x-incus-web-proxy-secret": "shh",
      }),
    );

    for (const body of [
      { action: "savePreset", name: "Preset" },
      { action: "setMaster", imageAlias: "incus-web-test" },
    ]) {
      const response = await POST(
        new Request("http://localhost/api/builds", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );

      expect(response.status).toBe(403);
    }
    expect(sendBuildWorkerCommand).not.toHaveBeenCalled();
  });

  it("rejects invalid packages before worker dispatch", async () => {
    const response = await POST(
      new Request("http://localhost/api/builds", {
        method: "POST",
        body: JSON.stringify({
          action: "dispatch",
          distro: "debian",
          release: "trixie",
          packages: ["bad;pkg"],
          postInstallCommands: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(sendBuildWorkerCommand).not.toHaveBeenCalled();
  });
});
