import http from "node:http";

import { hostProvisionerConfigFromEnv } from "./host-transport";

export async function provisionerReadiness(): Promise<{
  ok: boolean;
  configured: boolean;
  latencyMs?: number;
  message?: string;
}> {
  const config = hostProvisionerConfigFromEnv();
  if (!config) return { ok: false, configured: false, message: "provisioner is not configured" };
  const started = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const body = "{}";
      const url = config.url ? new URL(config.url) : undefined;
      const request = http.request(
        {
          method: "POST",
          ...(config.socketPath
            ? { socketPath: config.socketPath }
            : { hostname: url?.hostname, port: url?.port }),
          path: config.socketPath
            ? "/v1/operations"
            : `${url?.pathname.replace(/\/$/, "") ?? ""}/v1/operations`,
          timeout: Math.min(config.timeoutMs ?? 10_000, 2_000),
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            const status = response.statusCode ?? 500;
            // A schema error proves the authenticated server handled the
            // request. Authentication and server failures do not prove ready.
            if (status === 401 || status === 403 || status >= 500) {
              reject(new Error(`provisioner returned ${status}`));
            }
            else resolve();
          });
        },
      );
      request.once("timeout", () => request.destroy(new Error("provisioner readiness timed out")));
      request.once("error", reject);
      request.end(body);
    });
    return { ok: true, configured: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      latencyMs: Math.round(performance.now() - started),
      message: error instanceof Error ? error.message : "provisioner readiness failed",
    };
  }
}
