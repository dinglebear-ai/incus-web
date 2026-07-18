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
  GoldenConfigUploadError,
  goldenConfigMaxBytesFromEnv,
  stageGoldenConfigStream,
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

  let sha256Hex: string;
  try {
    ({ sha256Hex } = await stageGoldenConfigStream(
      access.workspace.id,
      request.body,
      maxBytes,
    ));
  } catch (error) {
    const uploadCode = error instanceof GoldenConfigUploadError
      ? error.code
      : typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    if (uploadCode === "busy") {
      return jsonError("upload_busy", "too many golden config uploads are active", 429);
    }
    if (uploadCode === "too_large") {
      return jsonError(
        "payload_too_large",
        `golden config upload exceeds the ${maxBytes}-byte limit`,
        413,
      );
    }
    const status = uploadCode === "empty" || uploadCode === "invalid_zip" ? 400 : 500;
    return jsonError("invalid_body", error instanceof Error ? error.message : "failed to stage request body", status);
  }

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
