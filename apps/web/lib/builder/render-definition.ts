import * as yaml from "js-yaml";

import { findBuilderRelease, type BuilderDistroId } from "@/lib/builder/distros";

export type RenderImageDefinitionInput = {
  distro: BuilderDistroId;
  release: string;
  architecture?: string;
  packages: string[];
  postInstallCommands: string[];
  description?: string;
};

export type DistrobuilderDefinition = {
  image: {
    distribution: string;
    release: string;
    architecture: string;
    description: string;
    variant: string;
  };
  source: {
    downloader: string;
    url: string;
    keyserver?: string;
    keys?: string[];
    components?: string[];
  };
  packages: {
    manager: string;
    update: boolean;
    cleanup: boolean;
    sets: Array<{
      packages: string[];
      action: "install";
    }>;
  };
  actions?: Array<{
    trigger: "post-packages";
    action: string;
  }>;
};

const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;

export function renderDistrobuilderDefinitionObject(
  input: RenderImageDefinitionInput,
): DistrobuilderDefinition {
  const release = findBuilderRelease(input.distro, input.release);
  if (!release) {
    throw new Error("unsupported distro/release");
  }

  const packages = [...new Set(input.packages.map((entry) => entry.trim()).filter(Boolean))];
  for (const pkg of packages) {
    if (!PACKAGE_PATTERN.test(pkg)) {
      throw new Error(`invalid package name: ${pkg}`);
    }
  }

  const definition: DistrobuilderDefinition = {
    image: {
      distribution: input.distro,
      release: input.release,
      architecture: input.architecture ?? "amd64",
      description:
        input.description ??
        `incus-web ${input.distro} ${input.release} generated image`,
      variant: "default",
    },
    source: release.source,
    packages: {
      manager: release.packageManager,
      update: true,
      cleanup: true,
      sets: packages.length > 0 ? [{ packages, action: "install" }] : [],
    },
  };

  const commands = input.postInstallCommands
    .map((command) => command.trim())
    .filter(Boolean);
  if (commands.length > 0) {
    definition.actions = [
      {
        trigger: "post-packages",
        action: ["#!/bin/sh", "set -eu", ...commands].join("\n"),
      },
    ];
  }

  return definition;
}

export function renderDistrobuilderYaml(input: RenderImageDefinitionInput): string {
  return yaml.dump(renderDistrobuilderDefinitionObject(input), {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
}
