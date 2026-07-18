import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("healthz route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 204 with no body and no auth requirement", async () => {
    const response = GET();

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  it("does not require trusted proxy headers even when the secret is configured", async () => {
    vi.stubEnv("INCUS_WEB_TRUSTED_PROXY_SECRET", "test-secret");

    const response = GET();

    expect(response.status).toBe(204);
  });
});
// @vitest-environment node
