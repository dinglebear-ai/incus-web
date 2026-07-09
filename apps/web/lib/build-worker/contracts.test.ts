import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUILD_WORKER_CONTRACT_VERSION,
  BUILD_WORKER_COMMAND_TYPES,
  isBuildImageAlias,
  type BuildWorkerCommand,
  validateBuildWorkerCommand,
  validateBuildWorkerOperation,
} from "@/lib/build-worker/contracts";

const command: BuildWorkerCommand<"GetBuildStatus"> = {
  version: BUILD_WORKER_CONTRACT_VERSION,
  requestId: "req-1",
  type: "GetBuildStatus",
  actor: { userId: "oidc:user", email: "user@example.com" },
  payload: { buildId: "build_1", logOffset: 0 },
};

describe("build worker contracts", () => {
  it("keeps script command lists aligned with the TS contract", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const workerSource = readFileSync(join(here, "../../../../scripts/build-worker.mjs"), "utf8");

    expect(readStringArrayConst(workerSource, "commandTypes")).toEqual(BUILD_WORKER_COMMAND_TYPES);
    expect(readStringArrayConst(workerSource, "dispatchPayloadKeys")).toEqual([
      "distro",
      "release",
      "packages",
      "postInstallCommands",
      "definitionYaml",
      "imageAlias",
      "idempotencyKey",
      "basedOn",
    ]);
    expect(readStringArrayConst(workerSource, "savePresetPayloadKeys")).toEqual([
      "name",
      "distro",
      "release",
      "packages",
      "postInstallCommands",
    ]);
  });

  it("keeps the TS image alias predicate aligned with the worker", () => {
    expect(isBuildImageAlias("incus-web-abc_debian:trixie.1")).toBe(true);
    expect(isBuildImageAlias("-bad")).toBe(false);
    expect(isBuildImageAlias("bad alias")).toBe(false);
    expect(isBuildImageAlias("bad/alias")).toBe(false);
    expect(isBuildImageAlias(`a${"b".repeat(118)}`)).toBe(true);
    expect(isBuildImageAlias(`a${"b".repeat(119)}`)).toBe(false);
  });

  it("rejects dispatch payload aliases the worker would reject", () => {
    const result = validateBuildWorkerCommand({
      version: BUILD_WORKER_CONTRACT_VERSION,
      requestId: "req-2",
      type: "DispatchBuildImage",
      actor: { userId: "oidc:user", email: "user@example.com" },
      payload: {
        distro: "debian",
        release: "trixie",
        packages: [],
        postInstallCommands: [],
        definitionYaml: "image:\n  distribution: debian\n",
        imageAlias: "bad/alias",
        idempotencyKey: "idem-1",
      },
    });

    expect(result.ok).toBe(false);
  });

  it("validates command-specific operation result shape", () => {
    expect(
      validateBuildWorkerOperation(
        {
          id: "op-1",
          requestId: "req-1",
          type: "GetBuildStatus",
          status: "succeeded",
          completedAt: new Date().toISOString(),
          result: {
            buildId: "build_1",
            status: "running",
            imageAlias: "incus-web-user-image",
            logOffset: 10,
            logChunk: "hello",
          },
        },
        command,
      ).ok,
    ).toBe(true);

    expect(
      validateBuildWorkerOperation(
        {
          id: "op-1",
          requestId: "req-1",
          type: "GetBuildStatus",
          status: "succeeded",
          completedAt: new Date().toISOString(),
          result: { buildId: "build_1" },
        },
        command,
      ).ok,
    ).toBe(false);
  });
});

function readStringArrayConst(source: string, name: string) {
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!match) throw new Error(`missing ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}
