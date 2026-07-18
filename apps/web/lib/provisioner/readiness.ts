import http from "node:http";
import { randomUUID } from "node:crypto";

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
      const probeId = `readiness-${randomUUID()}`;
      const probeType = "ReadinessProbe";
      const probeWorkspaceId = "readiness";
      const body = JSON.stringify({
        version: "provisioner.v1",
        requestId: probeId,
        type: probeType,
        actor: { userId: "readiness", oidcSubject: "readiness", email: "readiness@localhost" },
        workspace: {
          id: probeWorkspaceId,
          ownerUserId: "readiness",
          incusProject: "readiness",
          incusContainer: "readiness",
        },
        payload: {},
      });
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
          const chunks: Buffer[] = [];
          let size = 0;
          response.once("error", reject);
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024) {
              response.destroy(new Error("provisioner readiness response exceeded 64 KiB"));
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            const status = response.statusCode ?? 500;
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              reject(new Error(`provisioner returned a non-contract response (${status})`));
              return;
            }
            const contractResponse = parsed as {
              requestId?: unknown;
              type?: unknown;
              workspaceId?: unknown;
              status?: unknown;
              error?: { code?: unknown; retryable?: unknown };
            };
            if (
              status !== 200 ||
              contractResponse.requestId !== probeId ||
              contractResponse.type !== probeType ||
              contractResponse.workspaceId !== probeWorkspaceId ||
              contractResponse.status !== "failed" ||
              contractResponse.error?.code !== "invalid_input" ||
              contractResponse.error.retryable !== false
            ) {
              reject(new Error(`provisioner returned a non-contract response (${status})`));
              return;
            }
            resolve();
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
