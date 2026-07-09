import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWorkerConfigFromEnv,
  sendBuildWorkerCommand,
} from "@/lib/build-worker/client";
import {
  BUILD_WORKER_CONTRACT_VERSION,
  type BuildWorkerCommand,
} from "@/lib/build-worker/contracts";

const command: BuildWorkerCommand<"ListBuildPresets"> = {
  version: BUILD_WORKER_CONTRACT_VERSION,
  requestId: "req-1",
  type: "ListBuildPresets",
  actor: { userId: "oidc:user", email: "user@example.com" },
  payload: {},
};

describe("build worker client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers an explicit URL over the default socket path", () => {
    vi.stubEnv("INCUS_WEB_BUILD_WORKER_TOKEN", "token");
    vi.stubEnv("INCUS_WEB_BUILD_WORKER_URL", "http://127.0.0.1:4999");
    vi.stubEnv("INCUS_WEB_BUILD_WORKER_SOCKET", "");

    expect(buildWorkerConfigFromEnv()).toMatchObject({
      token: "token",
      url: "http://127.0.0.1:4999",
    });
    expect(buildWorkerConfigFromEnv()?.socketPath).toBeUndefined();
  });

  it("turns malformed worker responses into failed operations", async () => {
    const operation = await sendBuildWorkerCommand(command, {
      token: "token",
      url: "http://127.0.0.1:9",
      timeoutMs: 50,
    });

    expect(operation.status).toBe("failed");
    expect(operation.error?.retryable).toBe(true);
  });
});
