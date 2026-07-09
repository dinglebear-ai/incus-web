import { headers } from "next/headers";

import {
  AuthenticationRequiredError,
  getActorFromHeaders,
} from "@/lib/auth/identity";
import {
  getMutableWorkspaceRefForActor,
  sendWorkspaceCommand,
} from "@/lib/workspaces/provisioner";
import {
  goldenConfigMaxBytesFromEnv,
  looksLikeZip,
  stageGoldenConfigUpload,
} from "@/lib/workspaces/golden-config";
import {
  jsonError,
  provisionerError,
  statusForProvisionerError,
} from "@/lib/workspaces/route-helpers";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  let actor;
  try {
    actor = getActorFromHeaders(await headers());
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return jsonError("authentication_required", error.message, 401);
    }
    throw error;
  }

  const { workspaceId } = await context.params;

  // Resolved (and mutation-authorized) before reading any request body
  // bytes: an actor who isn't allowed to mutate this workspace's config
  // shouldn't cause this route to buffer and stage a multi-megabyte upload
  // on their behalf.
  const access = getMutableWorkspaceRefForActor(actor);
  if (!access.ok) {
    return provisionerError(access.error);
  }
  if (access.workspace.id !== workspaceId) {
    return jsonError("workspace_not_found", "workspace was not found", 404);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType !== "application/zip" &&
    contentType !== "application/octet-stream"
  ) {
    return jsonError(
      "invalid_content_type",
      "request body must be application/zip or application/octet-stream",
      415,
    );
  }

  const maxBytes = goldenConfigMaxBytesFromEnv();
  const declaredLength = Number.parseInt(
    request.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return jsonError(
      "payload_too_large",
      `golden config upload exceeds the ${maxBytes}-byte limit`,
      413,
    );
  }

  let content: Buffer;
  try {
    content = await readLimitedBody(request, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return jsonError(
        "payload_too_large",
        `golden config upload exceeds the ${maxBytes}-byte limit`,
        413,
      );
    }
    return jsonError(
      "invalid_body",
      error instanceof Error ? error.message : "failed to read request body",
      400,
    );
  }

  if (content.length === 0) {
    return jsonError("invalid_body", "golden config upload was empty", 400);
  }
  if (!looksLikeZip(content)) {
    return jsonError(
      "invalid_body",
      "golden config upload does not look like a zip file",
      400,
    );
  }

  const { sha256Hex } = await stageGoldenConfigUpload(access.workspace.id, content);

  const operation = await sendWorkspaceCommand(actor, "ImportGoldenConfig", {
    sha256Hex,
  });

  if (operation.status !== "succeeded") {
    return Response.json(
      { ok: false, operation },
      { status: statusForProvisionerError(operation.error) },
    );
  }

  return Response.json({ ok: true, operation });
}

class BodyTooLargeError extends Error {}

async function readLimitedBody(request: Request, maxBytes: number): Promise<Buffer> {
  if (!request.body) {
    return Buffer.alloc(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError("request body exceeded the configured limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
