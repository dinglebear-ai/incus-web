import http from "node:http";
import https from "node:https";

import {
  type ProvisionerCommand,
  type ProvisionerCommandType,
  type ProvisionerError,
  type ProvisionerOperation,
} from "@/lib/provisioner/contracts";
import {
  createProvisionerClient,
  type ProvisionerClient,
  type ProvisionerTransport,
} from "@/lib/provisioner/client";

export type HostProvisionerTransportConfig = {
  token: string;
  socketPath?: string;
  url?: string;
  timeoutMs?: number;
};

const defaultSocketPath = "/run/incus-web/provisioner.sock";
// The host command budget defaults to 30s. The transport remains alive for
// two additional seconds so the provisioner can return its contract-shaped
// timeout response instead of creating an ambiguous client-side disconnect.
const defaultCommandBudgetMs = 30_000;
const transportGraceMs = 2_000;

function configuredTransportTimeoutMs() {
  const explicit = process.env.INCUS_WEB_PROVISIONER_TRANSPORT_TIMEOUT_MS;
  if (explicit) return positiveNumber(explicit, "INCUS_WEB_PROVISIONER_TRANSPORT_TIMEOUT_MS");
  const budget = process.env.INCUS_WEB_PROVISIONER_TIMEOUT_MS
    ? positiveNumber(process.env.INCUS_WEB_PROVISIONER_TIMEOUT_MS, "INCUS_WEB_PROVISIONER_TIMEOUT_MS")
    : defaultCommandBudgetMs;
  return budget + transportGraceMs;
}

export function hostProvisionerConfigFromEnv():
  | HostProvisionerTransportConfig
  | undefined {
  const token = process.env.INCUS_WEB_PROVISIONER_TOKEN?.trim();
  if (!token) {
    return undefined;
  }

  const url = process.env.INCUS_WEB_PROVISIONER_URL?.trim();
  if (url) {
    assertLocalUrl(url);
    return {
      token,
      url,
      timeoutMs: configuredTransportTimeoutMs(),
    };
  }

  return {
    token,
    socketPath:
      process.env.INCUS_WEB_PROVISIONER_SOCKET?.trim() || defaultSocketPath,
    timeoutMs: configuredTransportTimeoutMs(),
  };
}

export function createHostProvisionerClient(
  config: HostProvisionerTransportConfig,
): ProvisionerClient {
  return createProvisionerClient(new HostProvisionerTransport(config));
}

export class HostProvisionerTransport implements ProvisionerTransport {
  readonly #config: Required<Pick<HostProvisionerTransportConfig, "timeoutMs">> &
    Omit<HostProvisionerTransportConfig, "timeoutMs">;

  constructor(config: HostProvisionerTransportConfig) {
    const token = config.token.trim();
    if (!token) {
      throw new Error("INCUS_WEB_PROVISIONER_TOKEN is required");
    }
    if (!config.socketPath && !config.url) {
      throw new Error("host provisioner socket or URL is required");
    }
    if (config.url) {
      assertLocalUrl(config.url);
    }
    this.#config = {
      ...config,
      token,
      timeoutMs: config.timeoutMs ?? configuredTransportTimeoutMs(),
    };
  }

  async send<TType extends ProvisionerCommandType>(
    command: ProvisionerCommand<TType>,
  ): Promise<ProvisionerOperation<TType>> {
    const body = JSON.stringify(command);
    const response = await requestJson(this.#requestOptions(body), body);
    if (isProvisionerError(response)) {
      return failedOperation(command, response);
    }
    return response as ProvisionerOperation<TType>;
  }

  #requestOptions(body: string): http.RequestOptions | https.RequestOptions {
    const base = {
      method: "POST",
      path: "/v1/operations",
      timeout: this.#config.timeoutMs,
      headers: {
        "Authorization": `Bearer ${this.#config.token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      },
    };

    if (this.#config.socketPath) {
      return {
        ...base,
        socketPath: this.#config.socketPath,
      };
    }

    const url = new URL(this.#config.url ?? "http://127.0.0.1");
    return {
      ...base,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname.replace(/\/$/, "") || ""}/v1/operations`,
    };
  }
}

function requestJson(
  options: http.RequestOptions | https.RequestOptions,
  body: string,
): Promise<unknown> {
  const requester = options.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = requester(options, (res) => {
      let payload = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        payload += chunk;
        if (payload.length > 1024 * 1024) {
          req.destroy(new Error("provisioner response too large"));
        }
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(payload || "{}");
          if ((res.statusCode ?? 500) >= 400) {
            resolve(parsed);
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("provisioner request timed out"));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function failedOperation<TType extends ProvisionerCommandType>(
  command: ProvisionerCommand<TType>,
  error: ProvisionerError,
): ProvisionerOperation<TType> {
  return {
    id: `host-http-error-${command.requestId}`,
    requestId: command.requestId,
    type: command.type,
    workspaceId: command.workspace.id,
    status: "failed",
    error,
    completedAt: new Date().toISOString(),
  } as ProvisionerOperation<TType>;
}

function isProvisionerError(value: unknown): value is ProvisionerError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "retryable" in value &&
    typeof value.retryable === "boolean"
  );
}

function assertLocalUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("host provisioner URL must be HTTP(S)");
  }
  if (!["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new Error("host provisioner URL must be localhost-only");
  }
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}
