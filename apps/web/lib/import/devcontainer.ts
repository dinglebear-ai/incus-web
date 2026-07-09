export type ImportedDistroRelease = {
  distro: "debian" | "ubuntu" | "alpine" | "fedora" | "rocky" | "alma";
  release: string;
};

export type ImportedCommand = {
  command: string;
  sourceField: "postCreateCommand" | "postStartCommand";
  externalSource: boolean;
  needsReview: boolean;
  reviewReason?: string;
};

export type ImportSkip = {
  field: string;
  reason: string;
};

export type DevcontainerImportResult = {
  distroRelease?: ImportedDistroRelease;
  packages: string[];
  postInstallCommands: ImportedCommand[];
  skipped: ImportSkip[];
};

type DevcontainerImportOptions = {
  externalSource?: boolean;
};

const PROCESSED_TOP_LEVEL_FIELDS = new Set([
  "image",
  "build",
  "features",
  "postCreateCommand",
  "postStartCommand",
  "remoteUser",
  "containerUser",
  "forwardPorts",
  "mounts",
  "workspaceFolder",
]);

const SKIPPED_FIELD_REASONS = new Map<string, string>([
  ["build", "Dockerfile builds are not imported; choose a distro and release manually."],
  ["remoteUser", "incus-web images use the fixed workspace user."],
  ["containerUser", "incus-web images use the fixed workspace user."],
  ["forwardPorts", "Port forwarding is runtime routing, not image-builder input."],
  ["mounts", "Mounts are workspace configuration, not image-builder input."],
  ["workspaceFolder", "incus-web uses the fixed /workspace mount."],
]);

export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (current === "\n" || current === "\r") {
        inLineComment = false;
        output += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (current === "\n" || current === "\r") {
        output += current;
      }
      continue;
    }

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === "\"") {
        inString = false;
      }
      continue;
    }

    if (current === "\"") {
      inString = true;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += current;
  }

  return output;
}

export function inferDistroReleaseFromImage(
  image: string,
): ImportedDistroRelease | undefined {
  const normalized = image.trim().toLowerCase();
  const withoutRegistry = normalized.split("/").at(-1) ?? normalized;
  const [name, rawTag = "latest"] = withoutRegistry.split(":", 2);
  const tag = rawTag || "latest";

  if (name === "debian") {
    return { distro: "debian", release: debianRelease(tag) };
  }
  if (name === "ubuntu") {
    return { distro: "ubuntu", release: ubuntuRelease(tag) };
  }
  if (name === "alpine") {
    return { distro: "alpine", release: tag === "latest" ? "edge" : tag };
  }
  if (name === "fedora") {
    return { distro: "fedora", release: tag === "latest" ? "latest" : tag };
  }
  if (name === "rockylinux" || name === "rocky") {
    return { distro: "rocky", release: firstVersionNumber(tag) ?? "9" };
  }
  if (name === "almalinux" || name === "alma") {
    return { distro: "alma", release: firstVersionNumber(tag) ?? "9" };
  }
  if (name === "node" || name === "python" || name.includes("node") || name.includes("python")) {
    const release = tag.includes("trixie") ? "trixie" : "bookworm";
    return { distro: "debian", release };
  }

  return undefined;
}

export function mapFeatureToPrereqGroup(featureId: string): string[] | undefined {
  const normalized = featureId.toLowerCase();
  if (normalized.includes("/node") || normalized.endsWith(":node")) {
    return ["nodejs"];
  }
  if (normalized.includes("/python") || normalized.endsWith(":python")) {
    return ["python3"];
  }
  if (normalized.includes("/git") || normalized.endsWith(":git")) {
    return ["git"];
  }
  if (normalized.includes("/common-utils") || normalized.endsWith(":common-utils")) {
    return ["curl", "sudo", "ca-certificates"];
  }
  return undefined;
}

export function parseDevcontainerJson(
  input: string,
  options: DevcontainerImportOptions = {},
): DevcontainerImportResult {
  const parsed = JSON.parse(stripJsonComments(input)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("devcontainer.json must parse to an object");
  }

  const skipped: ImportSkip[] = [];
  const packages = new Set<string>();
  const postInstallCommands: ImportedCommand[] = [];
  let distroRelease: ImportedDistroRelease | undefined;

  if (typeof parsed.image === "string") {
    distroRelease = inferDistroReleaseFromImage(parsed.image);
    if (!distroRelease) {
      skipped.push({
        field: "image",
        reason: "Image was not recognized; choose a distro and release manually.",
      });
    }
  }

  const features = parsed.features;
  if (isRecord(features)) {
    for (const featureId of Object.keys(features)) {
      const mappedPackages = mapFeatureToPrereqGroup(featureId);
      if (mappedPackages) {
        mappedPackages.forEach((pkg) => packages.add(pkg));
      } else {
        skipped.push({
          field: `features.${featureId}`,
          reason: "Feature has no incus-web image-builder package mapping yet.",
        });
      }
    }
  }

  for (const field of ["postCreateCommand", "postStartCommand"] as const) {
    const commands = normalizeDevcontainerCommands(parsed[field]);
    for (const command of commands) {
      postInstallCommands.push(importedCommand(command, field, options));
    }
  }

  for (const [field, reason] of SKIPPED_FIELD_REASONS) {
    if (parsed[field] !== undefined) {
      skipped.push({ field, reason });
    }
  }

  for (const field of Object.keys(parsed)) {
    if (!PROCESSED_TOP_LEVEL_FIELDS.has(field)) {
      skipped.push({
        field,
        reason: "Field is not image-builder input and was left for later workspace/runtime support.",
      });
    }
  }

  return {
    distroRelease,
    packages: [...packages].sort(),
    postInstallCommands,
    skipped,
  };
}

function importedCommand(
  command: string,
  sourceField: ImportedCommand["sourceField"],
  options: DevcontainerImportOptions,
): ImportedCommand {
  const externalSource = options.externalSource === true;
  const needsReview = externalSource && containsNetworkFetch(command);
  return {
    command,
    sourceField,
    externalSource,
    needsReview,
    reviewReason: needsReview
      ? "Command came from an external source and contains a network-fetch tool."
      : undefined,
  };
}

function normalizeDevcontainerCommands(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    const command = value
      .filter((entry): entry is string => typeof entry === "string")
      .join(" ")
      .trim();
    return command ? [command] : [];
  }
  if (isRecord(value)) {
    return Object.values(value)
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  return [];
}

function containsNetworkFetch(command: string): boolean {
  return /\b(curl|wget|nc|netcat|ncat)\b/i.test(command);
}

function debianRelease(tag: string): string {
  if (tag.includes("trixie")) return "trixie";
  if (tag.includes("bullseye")) return "bullseye";
  if (tag.includes("buster")) return "buster";
  return "bookworm";
}

function ubuntuRelease(tag: string): string {
  if (tag.includes("noble") || tag.startsWith("24.04")) return "noble";
  if (tag.includes("jammy") || tag.startsWith("22.04")) return "jammy";
  if (tag.includes("focal") || tag.startsWith("20.04")) return "focal";
  return "noble";
}

function firstVersionNumber(tag: string): string | undefined {
  return /\d+(?:\.\d+)?/.exec(tag)?.[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
