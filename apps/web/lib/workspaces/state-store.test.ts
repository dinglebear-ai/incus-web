// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

describe("workspace state store", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reports configured persistent database failures instead of falling back silently", async () => {
    vi.stubEnv("INCUS_WEB_WORKSPACE_STATE_DB", "/dev/null/workspace-state.sqlite3");
    const store = await import("./state-store");

    expect(store.workspaceStateStoreStatus()).toMatchObject({
      ok: false,
      mode: "unavailable",
      path: "/dev/null/workspace-state.sqlite3",
    });
    expect(() => store.listActivity("workspace-1")).toThrow("workspace state database unavailable");
  });

  it("allows memory mode when no persistent database path is configured", async () => {
    const store = await import("./state-store");

    expect(store.workspaceStateStoreStatus()).toMatchObject({
      ok: true,
      mode: expect.stringMatching(/sqlite|memory/),
    });
  });
});
