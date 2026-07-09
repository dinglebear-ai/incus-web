import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

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

describe("build status route", () => {
  beforeEach(() => {
    sendBuildWorkerCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "GetBuildStatus",
      status: "succeeded",
      result: {
        buildId: "build_1",
        status: "running",
        imageAlias: "incus-web-test",
        logOffset: 0,
        logChunk: "",
      },
      completedAt: new Date().toISOString(),
    });
    headersMock.mockResolvedValue(
      new Headers({ "x-auth-request-email": "test@example.com" }),
    );
  });

  it("normalizes invalid log offsets to zero", async () => {
    await GET(new Request("http://localhost/api/builds/build_1?offset=-9"), {
      params: Promise.resolve({ buildId: "build_1" }),
    });

    expect(sendBuildWorkerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { buildId: "build_1", logOffset: 0 },
      }),
    );
  });
});
