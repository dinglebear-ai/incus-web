import { createServer, type RequestListener, type Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROVISIONER_CONTRACT_VERSION,
  type ProvisionerCommand,
  type ProvisionerOperation,
} from "@/lib/provisioner/contracts";
import {
  createHostProvisionerClient,
  hostProvisionerConfigFromEnv,
  HostProvisionerTransport,
} from "@/lib/provisioner/host-transport";

const command: ProvisionerCommand<"GetWorkspaceStatus"> = {
  version: PROVISIONER_CONTRACT_VERSION,
  requestId: "req-host",
  type: "GetWorkspaceStatus",
  actor: {
    userId: "oidc:owner",
    oidcSubject: "owner",
    email: "owner@example.com",
  },
  workspace: {
    id: "workspace-incus-web",
    ownerUserId: "oidc:owner",
    incusProject: "user-incus-web",
    incusContainer: "ws-incus-web",
  },
  payload: {},
};

const operation: ProvisionerOperation<"GetWorkspaceStatus"> = {
  id: "op-host",
  requestId: "req-host",
  type: "GetWorkspaceStatus",
  workspaceId: "workspace-incus-web",
  status: "succeeded",
  result: {
    workspaceId: "workspace-incus-web",
    state: "running",
    incusProject: "user-incus-web",
    incusContainer: "ws-incus-web",
    lastCheckedAt: "2026-07-01T00:00:00.000Z",
  },
};

describe("host provisioner transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds localhost URL config from environment", () => {
    vi.stubEnv("INCUS_WEB_PROVISIONER_TOKEN", "secret");
    vi.stubEnv("INCUS_WEB_PROVISIONER_URL", "http://127.0.0.1:4010");

    expect(hostProvisionerConfigFromEnv()).toMatchObject({
      token: "secret",
      url: "http://127.0.0.1:4010",
    });
  });

  it("defaults to the host Unix socket when token is configured", () => {
    vi.stubEnv("INCUS_WEB_PROVISIONER_TOKEN", "secret");

    expect(hostProvisionerConfigFromEnv()).toMatchObject({
      token: "secret",
      socketPath: "/run/incus-web/provisioner.sock",
    });
  });

  it("rejects non-local provisioner URLs", () => {
    expect(
      () =>
        new HostProvisionerTransport({
          token: "secret",
          url: "http://[::1]:4010",
        }),
    ).not.toThrow();
    expect(
      () =>
        new HostProvisionerTransport({
          token: "secret",
          url: "https://provisioner.example.com",
        }),
    ).toThrow("localhost-only");
  });

  it("posts commands with bearer service authentication", async () => {
    const seen: { authorization?: string; body?: unknown } = {};
    const server = await listen((req, res) => {
      seen.authorization = req.headers.authorization;
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        seen.body = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(operation));
      });
    });

    try {
      const client = createHostProvisionerClient({
        token: " secret\n",
        url: server.url,
      });
      const result = await client.send(command);

      expect(seen.authorization).toBe("Bearer secret");
      expect(seen.body).toMatchObject({
        version: PROVISIONER_CONTRACT_VERSION,
        type: "GetWorkspaceStatus",
        requestId: "req-host",
      });
      expect(result).toMatchObject(operation);
    } finally {
      await server.close();
    }
  });

  it("preserves contract error bodies returned by the provisioner", async () => {
    const server = await listen((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: "invalid_input",
          message: "bad command",
          retryable: false,
        }),
      );
    });

    try {
      const client = createHostProvisionerClient({
        token: "secret",
        url: server.url,
      });
      const result = await client.send(command);

      expect(result).toMatchObject({
        requestId: "req-host",
        type: "GetWorkspaceStatus",
        workspaceId: "workspace-incus-web",
        status: "failed",
        error: {
          code: "invalid_input",
          message: "bad command",
          retryable: false,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("turns transport failures into contract-shaped failed operations", async () => {
    const client = createHostProvisionerClient({
      token: "secret",
      url: "http://127.0.0.1:9",
      timeoutMs: 50,
    });

    const result = await client.send(command);

    expect(result).toMatchObject({
      requestId: "req-host",
      type: "GetWorkspaceStatus",
      workspaceId: "workspace-incus-web",
      status: "failed",
      error: { code: "unauthenticated_service" },
    });
  });
});

function listen(
  handler: RequestListener,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("server did not bind to a TCP port");
      }
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closed) => {
            server.close(() => closed());
          }),
      });
    });
  });
}
