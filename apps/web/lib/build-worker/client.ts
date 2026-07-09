import http from "node:http";

import {
  type BuildWorkerCommand,
  type BuildWorkerCommandType,
  type BuildWorkerOperation,
  validateBuildWorkerCommand,
} from "@/lib/build-worker/contracts";

export type BuildWorkerTransportConfig = {
  token: string;
  socketPath?: string;
  url?: string;
  timeoutMs?: number;
};

const defaultSocketPath = "/run/incus-web/build-worker.sock";
const defaultTimeoutMs = 10_000;

export function buildWorkerConfigFromEnv(): BuildWorkerTransportConfig | undefined {
  const token = process.env.INCUS_WEB_BUILD_WORKER_TOKEN?.trim();
  if (!token) return undefined;
  return {
    token,
    socketPath: process.env.INCUS_WEB_BUILD_WORKER_SOCKET?.trim() || defaultSocketPath,
    url: process.env.INCUS_WEB_BUILD_WORKER_URL?.trim() || undefined,
    timeoutMs: numberEnv("INCUS_WEB_BUILD_WORKER_TIMEOUT_MS", defaultTimeoutMs),
  };
}

export async function sendBuildWorkerCommand<TType extends BuildWorkerCommandType>(
  command: BuildWorkerCommand<TType>,
  config = buildWorkerConfigFromEnv(),
): Promise<BuildWorkerOperation<TType>> {
  const validation = validateBuildWorkerCommand(command);
  if (!validation.ok) {
    return failedOperation(command, "invalid_input", validation.message);
  }
  if (!config) {
    return failedOperation(command, "unauthenticated_service", "build worker is not configured");
  }
  const body = JSON.stringify(command);
  try {
    const response = await requestJson(requestOptions(config, body), body);
    if (!response.ok) {
      return failedOperation(command, "operation_failed", response.message, true);
    }
    if (!isOperationForCommand(response.body, command)) {
      return failedOperation(command, "operation_failed", "build worker returned malformed operation", true);
    }
    return response.body;
  } catch (error) {
    return failedOperation(
      command,
      "operation_failed",
      error instanceof Error ? error.message : "build worker request failed",
      true,
    );
  }
}

function requestOptions(config: BuildWorkerTransportConfig, body: string): http.RequestOptions {
  const base = {
    method: "POST",
    path: "/v1/builds",
    timeout: config.timeoutMs ?? defaultTimeoutMs,
    headers: {
      "Authorization": `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    },
  };
  if (config.socketPath) return { ...base, socketPath: config.socketPath };
  const url = new URL(config.url ?? "http://127.0.0.1");
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error("build worker URL must be loopback-only");
  }
  return {
    ...base,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname.replace(/\/$/, "") || ""}/v1/builds`,
  };
}

function requestJson(
  options: http.RequestOptions,
  body: string,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let payload = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        payload += chunk;
        if (payload.length > 1024 * 1024) req.destroy(new Error("build worker response too large"));
      });
      res.on("end", () => {
        const statusCode = res.statusCode ?? 0;
        try {
          const parsed = JSON.parse(payload || "{}");
          if (statusCode < 200 || statusCode >= 300) {
            const message =
              isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string"
                ? parsed.error.message
                : isRecord(parsed) && typeof parsed.message === "string"
                  ? parsed.message
                  : `build worker returned HTTP ${statusCode}`;
            resolve({ ok: false, message });
            return;
          }
          resolve({ ok: true, body: parsed });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("build worker request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

function isOperationForCommand<TType extends BuildWorkerCommandType>(
  value: unknown,
  command: BuildWorkerCommand<TType>,
): value is BuildWorkerOperation<TType> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.requestId === command.requestId &&
    value.type === command.type &&
    (value.status === "succeeded" || value.status === "failed") &&
    typeof value.completedAt === "string" &&
    (value.status === "succeeded" ? value.result !== undefined : isRecord(value.error))
  );
}

function failedOperation<TType extends BuildWorkerCommandType>(
  command: BuildWorkerCommand<TType>,
  code: "invalid_input" | "unauthenticated_service" | "operation_failed",
  message: string,
  retryable = false,
): BuildWorkerOperation<TType> {
  return {
    id: `failed-${command.requestId}`,
    requestId: command.requestId,
    type: command.type,
    status: "failed",
    error: { code, message, retryable },
    completedAt: new Date().toISOString(),
  } as BuildWorkerOperation<TType>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
