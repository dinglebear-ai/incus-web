import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const workspace = {
  id: "workspace-incus-web",
  ownerUserId: "oidc:test@example.com",
  incusProject: "default",
  incusContainer: "incus-web",
};

const sendWorkspaceCommand = vi.fn();
const getMutableWorkspaceRefForActor = vi.fn();
const stageGoldenConfigUpload = vi.fn();
const headersMock = vi.fn(
  async () => new Headers({ "x-auth-request-email": "test@example.com" }),
);

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

vi.mock("@/lib/workspaces/provisioner", () => ({
  getMutableWorkspaceRefForActor: (...args: unknown[]) =>
    getMutableWorkspaceRefForActor(...args),
  sendWorkspaceCommand: (...args: unknown[]) => sendWorkspaceCommand(...args),
}));

vi.mock("@/lib/workspaces/golden-config", () => ({
  goldenConfigMaxBytesFromEnv: () => 10 * 1024 * 1024,
  looksLikeZip: (buffer: Uint8Array) =>
    buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b,
  stageGoldenConfigUpload: (...args: unknown[]) => stageGoldenConfigUpload(...args),
}));

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);

function postGoldenConfig(
  body: BodyInit | undefined,
  {
    workspaceId = workspace.id,
    contentType = "application/zip",
  }: { workspaceId?: string; contentType?: string | null } = {},
) {
  const headersInit: Record<string, string> = {};
  if (contentType !== null) headersInit["content-type"] = contentType;
  return POST(
    new Request("http://localhost/api", {
      method: "POST",
      headers: headersInit,
      body,
    }),
    { params: Promise.resolve({ workspaceId }) },
  );
}

describe("golden-config import route", () => {
  beforeEach(() => {
    getMutableWorkspaceRefForActor.mockReturnValue({ ok: true, workspace });
    sendWorkspaceCommand.mockReset();
    stageGoldenConfigUpload.mockReset();
    stageGoldenConfigUpload.mockResolvedValue({
      sha256Hex: "a".repeat(64),
      stagedPath: "/var/lib/incus-web/golden-config/workspace-incus-web.zip",
    });
    headersMock.mockResolvedValue(
      new Headers({ "x-auth-request-email": "test@example.com" }),
    );
  });

  it("rejects an unauthorized/unauthenticated actor before staging anything", async () => {
    getMutableWorkspaceRefForActor.mockReturnValue({
      ok: false,
      error: { code: "mutation_not_authorized", message: "nope", retryable: false },
    });

    const response = await postGoldenConfig(ZIP_MAGIC);

    expect(response.status).toBe(403);
    expect(stageGoldenConfigUpload).not.toHaveBeenCalled();
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("rejects workspace mismatches before staging anything", async () => {
    const response = await postGoldenConfig(ZIP_MAGIC, { workspaceId: "other-workspace" });

    expect(response.status).toBe(404);
    expect(stageGoldenConfigUpload).not.toHaveBeenCalled();
  });

  it("rejects an unexpected content-type before staging anything", async () => {
    const response = await postGoldenConfig(ZIP_MAGIC, { contentType: "text/plain" });

    expect(response.status).toBe(415);
    expect(stageGoldenConfigUpload).not.toHaveBeenCalled();
  });

  it("rejects a body that doesn't look like a zip before staging anything", async () => {
    const response = await postGoldenConfig(Buffer.from("not a zip at all"));

    expect(response.status).toBe(400);
    expect(stageGoldenConfigUpload).not.toHaveBeenCalled();
  });

  it("rejects an empty body before staging anything", async () => {
    const response = await postGoldenConfig(Buffer.alloc(0));

    expect(response.status).toBe(400);
    expect(stageGoldenConfigUpload).not.toHaveBeenCalled();
  });

  it("rejects a body over the configured size limit before staging anything", async () => {
    const oversized = Buffer.concat([ZIP_MAGIC, Buffer.alloc(11 * 1024 * 1024)]);

    const response = await postGoldenConfig(oversized);

    expect(response.status).toBe(413);
    expect(stageGoldenConfigUpload).not.toHaveBeenCalled();
  });

  it("stages a valid zip upload and dispatches ImportGoldenConfig with its hash", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "ImportGoldenConfig",
      workspaceId: workspace.id,
      status: "succeeded",
      result: {
        workspaceId: workspace.id,
        extractedAt: new Date().toISOString(),
        fileCount: 721,
        warnings: [],
      },
    });

    const response = await postGoldenConfig(ZIP_MAGIC);

    expect(response.status).toBe(200);
    expect(stageGoldenConfigUpload).toHaveBeenCalledWith(workspace.id, expect.any(Buffer));
    expect(sendWorkspaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({ email: "test@example.com" }),
      "ImportGoldenConfig",
      { sha256Hex: "a".repeat(64) },
    );
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("surfaces provisioner failures with a mapped status code", async () => {
    sendWorkspaceCommand.mockResolvedValue({
      id: "op-1",
      requestId: "req-test",
      type: "ImportGoldenConfig",
      workspaceId: workspace.id,
      status: "failed",
      error: { code: "golden_config_failed", message: "unzip missing", retryable: false },
    });

    const response = await postGoldenConfig(ZIP_MAGIC);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });
});
