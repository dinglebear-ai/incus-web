export type MiseToolPin = {
  tool: string;
  version: string;
};

export type MiseImportMode = "build-time" | "runtime";

export type MiseImportResult = {
  tools: MiseToolPin[];
  mode: MiseImportMode;
  postInstallCommand?: string;
  runtimeConfigToml?: string;
  warnings: string[];
};

const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export function parseToolVersionsFile(input: string): {
  tools: MiseToolPin[];
  warnings: string[];
} {
  const tools: MiseToolPin[] = [];
  const warnings: string[] = [];

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const [tool, ...versions] = line.split(/\s+/);
    if (!isValidToolName(tool) || versions.length === 0) {
      warnings.push(`Line ${index + 1} was skipped because it is not a valid tool pin.`);
      continue;
    }
    if (versions.length > 1) {
      warnings.push(
        `Line ${index + 1} pins multiple ${tool} versions; only ${versions[0]} was imported.`,
      );
    }
    tools.push({ tool, version: versions[0] });
  }

  return { tools: dedupeTools(tools), warnings };
}

export function parseMiseToolsTable(input: string): {
  tools: MiseToolPin[];
  warnings: string[];
} {
  const tools: MiseToolPin[] = [];
  const warnings: string[] = [];
  let inToolsTable = false;

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      inToolsTable = section[1].trim() === "tools";
      continue;
    }
    if (!inToolsTable) continue;

    const assignment = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.:-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) {
      warnings.push(`Line ${index + 1} in [tools] was skipped because it is not an assignment.`);
      continue;
    }

    const tool = unquote(assignment[1].trim());
    if (!isValidToolName(tool)) {
      warnings.push(`Line ${index + 1} in [tools] has an invalid tool name.`);
      continue;
    }

    const versions = parseTomlVersionValue(assignment[2].trim());
    if (versions.length === 0) {
      warnings.push(`Line ${index + 1} in [tools] has no supported version value.`);
      continue;
    }
    if (versions.length > 1) {
      warnings.push(
        `Line ${index + 1} pins multiple ${tool} versions; only ${versions[0]} was imported.`,
      );
    }
    tools.push({ tool, version: versions[0] });
  }

  return { tools: dedupeTools(tools), warnings };
}

export function importMiseTools(
  tools: MiseToolPin[],
  mode: MiseImportMode,
  warnings: string[] = [],
): MiseImportResult {
  const normalizedTools = dedupeTools(
    tools.filter((pin) => isValidToolName(pin.tool) && pin.version.trim().length > 0),
  );

  if (mode === "build-time") {
    return {
      tools: normalizedTools,
      mode,
      postInstallCommand: renderBuildTimeMiseCommand(normalizedTools),
      warnings,
    };
  }

  return {
    tools: normalizedTools,
    mode,
    runtimeConfigToml: renderRuntimeMiseConfig(normalizedTools),
    warnings,
  };
}

export function importToolVersionsFile(
  input: string,
  mode: MiseImportMode,
): MiseImportResult {
  const parsed = parseToolVersionsFile(input);
  return importMiseTools(parsed.tools, mode, parsed.warnings);
}

export function importMiseToml(input: string, mode: MiseImportMode): MiseImportResult {
  const parsed = parseMiseToolsTable(input);
  return importMiseTools(parsed.tools, mode, parsed.warnings);
}

function renderBuildTimeMiseCommand(tools: MiseToolPin[]): string {
  const toolArgs = tools.map((pin) => shellQuote(`${pin.tool}@${pin.version}`)).join(" ");
  const useCommand = toolArgs ? `mise use -g ${toolArgs}` : "true";
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "export MISE_DATA_DIR=/opt/mise",
    "export MISE_CONFIG_DIR=/etc/mise",
    "export PATH=/opt/mise/bin:/opt/mise/shims:/usr/local/bin:/usr/bin:/bin",
    "if ! command -v mise >/dev/null 2>&1; then",
    "  curl -fsSL https://mise.run | sh",
    "fi",
    useCommand,
    "mise install",
  ].join("\n");
}

function renderRuntimeMiseConfig(tools: MiseToolPin[]): string {
  const lines = ["[tools]"];
  for (const pin of tools) {
    lines.push(`${quoteTomlKey(pin.tool)} = ${quoteTomlString(pin.version)}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseTomlVersionValue(value: string): string[] {
  const inlineVersion = /version\s*=\s*("[^"]+"|'[^']+'|[^,}]+)/.exec(value);
  if (inlineVersion) {
    return [unquote(inlineVersion[1].trim())];
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((entry) => unquote(entry.trim()))
      .filter(Boolean);
  }

  return [unquote(value.trim())].filter(Boolean);
}

function stripTomlComment(input: string): string {
  let output = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;

  for (const char of input) {
    if (quote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (quote === "\"" && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "#") break;
    output += char;
  }

  return output;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function dedupeTools(tools: MiseToolPin[]): MiseToolPin[] {
  const seen = new Set<string>();
  const deduped: MiseToolPin[] = [];
  for (const pin of tools) {
    if (seen.has(pin.tool)) continue;
    seen.add(pin.tool);
    deduped.push({ tool: pin.tool, version: pin.version.trim() });
  }
  return deduped;
}

function isValidToolName(tool: string): boolean {
  return TOOL_NAME_PATTERN.test(tool);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteTomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : quoteTomlString(value);
}

function quoteTomlString(value: string): string {
  return `"${value.replace(/["\\]/g, (match) => `\\${match}`)}"`;
}
