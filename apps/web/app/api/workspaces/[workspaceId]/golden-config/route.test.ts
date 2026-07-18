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
const stageGoldenConfigStream = vi.fn();
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
  GoldenConfigUploadError: class GoldenConfigUploadError extends Error {
    constructor(message: string, public code: string) { super(message); }
  },
  goldenConfigMaxBytesFromEnv: () => 10 * 1024 * 1024,
  stageGoldenConfigStream: (...args: unknown[]) => stageGoldenConfigStream(...args),
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
    stageGoldenConfigStream.mockReset();
    stageGoldenConfigStream.mockImplementation(async (_id, body: ReadableStream<Uint8Array>) => {
      const content = Buffer.from(await new Response(body).arrayBuffer());
      if (content.length === 0) throw Object.assign(new Error("empty"), { code: "empty" });
      if (content.length > 10 * 1024 * 1024) throw Object.assign(new Error("large"), { code: "too_large" });
      if (content[0] !== 0x50 || content[1] !== 0x4b) throw Object.assign(new Error("invalid"), { code: "invalid_zip" });
      return {
      sha256Hex: "a".repeat(64),
      stagedPath: "/var/lib/incus-web/golden-config/workspace-incus-web.zip",
      };
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
    expect(stageGoldenConfigStream).not.toHaveBeenCalled();
    expect(sendWorkspaceCommand).not.toHaveBeenCalled();
  });

  it("rejects workspace mismatches before staging anything", async () => {
    const response = await postGoldenConfig(ZIP_MAGIC, { workspaceId: "other-workspace" });

    expect(response.status).toBe(404);
    expect(stageGoldenConfigStream).not.toHaveBeenCalled();
  });

  it("rejects an unexpected content-type before staging anything", async () => {
    const response = await postGoldenConfig(ZIP_MAGIC, { contentType: "text/plain" });

    expect(response.status).toBe(415);
    expect(stageGoldenConfigStream).not.toHaveBeenCalled();
  });

  it("rejects a body that doesn't look like a zip before staging anything", async () => {
    const response = await postGoldenConfig(Buffer.from("not a zip at all"));

    expect(response.status).toBe(400);
    expect(stageGoldenConfigStream).toHaveBeenCalled();
  });

  it("rejects an empty body before staging anything", async () => {
    const response = await postGoldenConfig(Buffer.alloc(0));

    expect(response.status).toBe(400);
    expect(stageGoldenConfigStream).toHaveBeenCalled();
  });

  it("rejects a body over the configured size limit before staging anything", async () => {
    const oversized = Buffer.concat([ZIP_MAGIC, Buffer.alloc(11 * 1024 * 1024)]);

    const response = await postGoldenConfig(oversized);

    expect(response.status).toBe(413);
    expect(stageGoldenConfigStream).toHaveBeenCalled();
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
    expect(stageGoldenConfigStream).toHaveBeenCalledWith(workspace.id, expect.any(ReadableStream), 10 * 1024 * 1024);
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
