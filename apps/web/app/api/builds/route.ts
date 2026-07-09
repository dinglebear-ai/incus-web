import { headers } from "next/headers";

import { BUILD_WORKER_CONTRACT_VERSION, type BuildWorkerCommand } from "@/lib/build-worker/contracts";
import { sendBuildWorkerCommand } from "@/lib/build-worker/client";
import { renderDistrobuilderYaml } from "@/lib/builder/render-definition";
import { AuthenticationRequiredError, getActorFromHeaders } from "@/lib/auth/identity";
import { jsonError } from "@/lib/workspaces/route-helpers";

export async function GET() {
  const actor = await routeActor();
  if (!actor.ok) return actor.response;

  const images = await sendBuildWorkerCommand(command("ListBuildImages", actor.actor, {}));
  const presets = await sendBuildWorkerCommand(command("ListBuildPresets", actor.actor, {}));
  return Response.json({ ok: images.status === "succeeded" && presets.status === "succeeded", images, presets });
}

export async function POST(request: Request) {
  const actor = await routeActor();
  if (!actor.ok) return actor.response;

  const body = await request.json().catch(() => undefined);
  if (!isRecord(body)) return jsonError("invalid_request", "request body must be JSON", 400);
  const action = typeof body.action === "string" ? body.action : "dispatch";

  if (action === "dispatch") {
    const parsed = dispatchPayload(body);
    if (!parsed.ok) return jsonError("invalid_build", parsed.message, 400);
    const definitionYaml = renderDistrobuilderYaml(parsed.value);
    const operation = await sendBuildWorkerCommand(
      command("DispatchBuildImage", actor.actor, {
        ...parsed.value,
        definitionYaml,
        imageAlias: parsed.imageAlias,
        idempotencyKey: parsed.idempotencyKey,
        basedOn: parsed.basedOn,
      }),
    );
    return Response.json({ ok: operation.status === "succeeded", operation });
  }

  if (action === "savePreset") {
    const operation = await sendBuildWorkerCommand(
      command("SaveBuildPreset", actor.actor, {
        name: stringField(body.name, "Preset"),
        distro: stringField(body.distro, "debian"),
        release: stringField(body.release, "trixie"),
        packages: stringArray(body.packages),
        postInstallCommands: stringArray(body.postInstallCommands),
      }),
    );
    return Response.json({ ok: operation.status === "succeeded", operation });
  }

  if (action === "setMaster") {
    const imageAlias = stringField(body.imageAlias, "");
    if (!imageAlias) return jsonError("invalid_image", "imageAlias is required", 400);
    const operation = await sendBuildWorkerCommand(
      command("SetBuildImageMaster", actor.actor, { imageAlias }),
    );
    return Response.json({ ok: operation.status === "succeeded", operation });
  }

  return jsonError("invalid_action", "unsupported build action", 400);
}

function command<TType extends BuildWorkerCommand["type"]>(
  type: TType,
  actor: { userId: string; email: string; displayName?: string; requestId: string },
  payload: Extract<BuildWorkerCommand, { type: TType }>["payload"],
): Extract<BuildWorkerCommand, { type: TType }> {
  return {
    version: BUILD_WORKER_CONTRACT_VERSION,
    requestId: actor.requestId,
    type,
    actor: {
      userId: actor.userId,
      email: actor.email,
      displayName: actor.displayName,
    },
    payload,
  } as Extract<BuildWorkerCommand, { type: TType }>;
}

async function routeActor() {
  try {
    return { ok: true as const, actor: getActorFromHeaders(await headers()) };
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return { ok: false as const, response: jsonError("authentication_required", error.message, 401) };
    }
    throw error;
  }
}

function dispatchPayload(body: Record<string, unknown>) {
  const value = {
    distro: stringField(body.distro, "debian") as "debian",
    release: stringField(body.release, "trixie"),
    packages: stringArray(body.packages),
    postInstallCommands: stringArray(body.postInstallCommands),
  };
  const imageAlias = stringField(body.imageAlias, `incus-web-${value.distro}-${value.release}-${Date.now()}`);
  const idempotencyKey = stringField(body.idempotencyKey, crypto.randomUUID());
  const basedOn = body.basedOn === undefined ? undefined : stringField(body.basedOn, "");
  try {
    renderDistrobuilderYaml(value);
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : "invalid definition" };
  }
  return { ok: true as const, value, imageAlias, idempotencyKey, basedOn };
}

function stringField(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
