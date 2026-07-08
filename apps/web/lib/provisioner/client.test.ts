import { describe, expect, it, vi } from "vitest";

import {
  PROVISIONER_CONTRACT_VERSION,
  type ProvisionerCommand,
  type WorkspaceRuntimeStatus,
} from "@/lib/provisioner/contracts";
import {
  createProvisionerClient,
  createStaticPrototypeStatusClient,
  type ProvisionerTransport,
} from "@/lib/provisioner/client";

const status: WorkspaceRuntimeStatus = {
  workspaceId: "workspace-1",
  state: "running",
  incusProject: "user-owner",
  incusContainer: "ws-workspace",
  cpuCount: 2,
  memoryUsedBytes: 128 * 1024 * 1024,
  memoryLimitBytes: 4 * 1024 * 1024 * 1024,
  rootDiskLimitBytes: 20 * 1024 * 1024 * 1024,
  lastCheckedAt: "2026-07-01T00:00:00.000Z",
};

const command: ProvisionerCommand<"GetWorkspaceStatus"> = {
  version: PROVISIONER_CONTRACT_VERSION,
  requestId: "req-1",
  type: "GetWorkspaceStatus",
  actor: {
    userId: "user-1",
    oidcSubject: "subject-1",
    email: "owner@example.com",
  },
  workspace: {
    id: "workspace-1",
    ownerUserId: "user-1",
    incusProject: "user-owner",
    incusContainer: "ws-workspace",
  },
  payload: {},
};

describe("provisioner client", () => {
  it("sends validated command envelopes through the transport", async () => {
    const send = vi.fn<ProvisionerTransport["send"]>().mockResolvedValue({
      id: "op-1",
      requestId: "req-1",
      type: "GetWorkspaceStatus",
      workspaceId: "workspace-1",
      status: "succeeded",
      result: status,
    });
    const client = createProvisionerClient({ send } as ProvisionerTransport);

    const operation = await client.send(command);

    expect(send).toHaveBeenCalledWith(command);
    expect(operation.status).toBe("succeeded");
    expect(operation.result).toMatchObject({ state: "running" });
  });

  it("rejects invalid command envelopes before transport", async () => {
    const send = vi.fn<ProvisionerTransport["send"]>();
    const client = createProvisionerClient({ send } as ProvisionerTransport);

    const operation = await client.send({
      ...command,
      type: "RawIncusExec",
    });

    expect(send).not.toHaveBeenCalled();
    expect(operation).toMatchObject({
      type: "GetWorkspaceStatus",
      requestId: "req-1",
      workspaceId: "workspace-1",
      status: "failed",
      error: { code: "invalid_input" },
    });
  });

  it("turns transport exceptions into failed operations with command context", async () => {
    const send = vi
      .fn<ProvisionerTransport["send"]>()
      .mockRejectedValue(new Error("socket down"));
    const client = createProvisionerClient({ send } as ProvisionerTransport);

    const operation = await client.send(command);

    expect(operation).toMatchObject({
      requestId: "req-1",
      type: "GetWorkspaceStatus",
      workspaceId: "workspace-1",
      status: "failed",
      error: {
        code: "unauthenticated_service",
        message: "provisioner transport failed",
      },
    });
  });

  it("creates a static prototype status client for local inventory tests", async () => {
    const client = createStaticPrototypeStatusClient(status);
    const operation = await client.send(command);

    expect(operation).toMatchObject({
      id: "static-prototype-op-req-1",
      status: "succeeded",
      result: { workspaceId: "workspace-1", state: "running" },
    });
  });

  it("rejects non-status commands in the static prototype status client", async () => {
    const client = createStaticPrototypeStatusClient(status);
    const operation = await client.send({
      ...command,
      type: "StartWorkspace",
    });

    expect(operation).toMatchObject({
      status: "failed",
      error: { code: "invalid_input" },
    });
  });

  it("returns an empty agent run list in the static prototype client", async () => {
    const client = createStaticPrototypeStatusClient(status);
    const listCommand: ProvisionerCommand<"ListAgentRuns"> = {
      ...command,
      type: "ListAgentRuns",
      payload: { limit: 20 },
    };
    const operation = await client.send(listCommand);

    expect(operation).toMatchObject({
      status: "succeeded",
      result: { runs: [] },
    });
  });
});
