import { describe, expect, it } from "vitest";

import {
  renderDistrobuilderDefinitionObject,
  renderDistrobuilderYaml,
} from "@/lib/builder/render-definition";

describe("distrobuilder definition renderer", () => {
  it("renders a structured Debian definition", () => {
    const definition = renderDistrobuilderDefinitionObject({
      distro: "debian",
      release: "trixie",
      packages: ["git", "curl", "git"],
      postInstallCommands: ["echo ready"],
    });

    expect(definition.image).toMatchObject({
      distribution: "debian",
      release: "trixie",
      architecture: "amd64",
    });
    expect(definition.packages.sets).toEqual([
      { packages: ["git", "curl"], action: "install" },
    ]);
    expect(definition.actions?.[0]?.action).toContain("#!/bin/sh");
    expect(definition.actions?.[0]?.action).toContain("echo ready");
  });

  it("serializes with js-yaml and rejects unsafe package names", () => {
    expect(
      renderDistrobuilderYaml({
        distro: "ubuntu",
        release: "noble",
        packages: ["ca-certificates"],
        postInstallCommands: [],
      }),
    ).toContain("distribution: ubuntu");

    expect(() =>
      renderDistrobuilderYaml({
        distro: "ubuntu",
        release: "noble",
        packages: ["curl;rm"],
        postInstallCommands: [],
      }),
    ).toThrow("invalid package name");
  });
});
