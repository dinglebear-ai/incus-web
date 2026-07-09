import { describe, expect, it } from "vitest";

import {
  inferDistroReleaseFromImage,
  mapFeatureToPrereqGroup,
  parseDevcontainerJson,
  stripJsonComments,
} from "@/lib/import/devcontainer";

describe("devcontainer importer", () => {
  it("strips comments without changing URL strings", () => {
    const stripped = stripJsonComments(`{
      // comment
      "image": "mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm",
      "url": "https://example.com/a//b",
      /* block */
      "postCreateCommand": "echo ok"
    }`);

    expect(JSON.parse(stripped)).toMatchObject({
      image: "mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm",
      url: "https://example.com/a//b",
    });
  });

  it("infers distro and release from common devcontainer images", () => {
    expect(inferDistroReleaseFromImage("debian:trixie")).toEqual({
      distro: "debian",
      release: "trixie",
    });
    expect(inferDistroReleaseFromImage("ubuntu:22.04")).toEqual({
      distro: "ubuntu",
      release: "jammy",
    });
    expect(inferDistroReleaseFromImage("node:22-bookworm")).toEqual({
      distro: "debian",
      release: "bookworm",
    });
    expect(
      inferDistroReleaseFromImage("mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm"),
    ).toEqual({
      distro: "debian",
      release: "bookworm",
    });
  });

  it("maps known features to package prerequisites", () => {
    expect(mapFeatureToPrereqGroup("ghcr.io/devcontainers/features/node:1")).toEqual([
      "nodejs",
    ]);
    expect(
      mapFeatureToPrereqGroup("ghcr.io/devcontainers/features/common-utils:2"),
    ).toEqual(["curl", "sudo", "ca-certificates"]);
  });

  it("imports builder prefill data and surfaces skipped fields", () => {
    const result = parseDevcontainerJson(
      `{
        "image": "ubuntu:noble",
        "features": {
          "ghcr.io/devcontainers/features/git:1": {},
          "ghcr.io/example/custom:1": {}
        },
        "postCreateCommand": "curl -fsSL https://example.com/install.sh | bash",
        "postStartCommand": ["echo", "ready"],
        "forwardPorts": [3000],
        "workspaceFolder": "/workspaces/app",
        "customizations": {}
      }`,
      { externalSource: true },
    );

    expect(result.distroRelease).toEqual({ distro: "ubuntu", release: "noble" });
    expect(result.packages).toEqual(["git"]);
    expect(result.postInstallCommands).toEqual([
      {
        command: "curl -fsSL https://example.com/install.sh | bash",
        sourceField: "postCreateCommand",
        externalSource: true,
        needsReview: true,
        reviewReason:
          "Command came from an external source and contains a network-fetch tool.",
      },
      {
        command: "echo ready",
        sourceField: "postStartCommand",
        externalSource: true,
        needsReview: false,
        reviewReason: undefined,
      },
    ]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        {
          field: "features.ghcr.io/example/custom:1",
          reason: "Feature has no incus-web image-builder package mapping yet.",
        },
        {
          field: "forwardPorts",
          reason: "Port forwarding is runtime routing, not image-builder input.",
        },
        {
          field: "workspaceFolder",
          reason: "incus-web uses the fixed /workspace mount.",
        },
        {
          field: "customizations",
          reason:
            "Field is not image-builder input and was left for later workspace/runtime support.",
        },
      ]),
    );
  });
});
