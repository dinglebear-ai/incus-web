import { describe, expect, it } from "vitest";

import {
  importMiseToml,
  importToolVersionsFile,
  parseMiseToolsTable,
  parseToolVersionsFile,
} from "@/lib/import/mise";

describe("mise importer", () => {
  it("parses .tool-versions pins", () => {
    const result = parseToolVersionsFile(`
      node 22.13.1
      python 3.13.0 3.12.8 # extra version skipped
      bad/tool 1.0
    `);

    expect(result.tools).toEqual([
      { tool: "node", version: "22.13.1" },
      { tool: "python", version: "3.13.0" },
    ]);
    expect(result.warnings).toEqual([
      "Line 3 pins multiple python versions; only 3.13.0 was imported.",
      "Line 4 was skipped because it is not a valid tool pin.",
    ]);
  });

  it("parses the [tools] table from mise.toml", () => {
    const result = parseMiseToolsTable(`
      [env]
      NODE_ENV = "development"

      [tools]
      node = "22.13.1" # comment
      "cargo:taplo-cli" = { version = "0.10.0" }
      python = ["3.13.0", "3.12.8"]
    `);

    expect(result.tools).toEqual([
      { tool: "node", version: "22.13.1" },
      { tool: "cargo:taplo-cli", version: "0.10.0" },
      { tool: "python", version: "3.13.0" },
    ]);
    expect(result.warnings).toEqual([
      "Line 8 pins multiple python versions; only 3.13.0 was imported.",
    ]);
  });

  it("renders build-time mise post-install commands", () => {
    const result = importToolVersionsFile("node 22\npython 3.13\n", "build-time");

    expect(result.mode).toBe("build-time");
    expect(result.postInstallCommand).toContain("export MISE_DATA_DIR=/opt/mise");
    expect(result.postInstallCommand).toContain("mise use -g 'node@22' 'python@3.13'");
    expect(result.postInstallCommand).toContain("mise install");
    expect(result.runtimeConfigToml).toBeUndefined();
  });

  it("renders runtime config TOML for workspace bootstrap", () => {
    const result = importMiseToml(
      `
      [tools]
      node = "22"
      "cargo:taplo-cli" = "0.10.0"
      `,
      "runtime",
    );

    expect(result.mode).toBe("runtime");
    expect(result.runtimeConfigToml).toBe(
      '[tools]\nnode = "22"\n"cargo:taplo-cli" = "0.10.0"\n',
    );
    expect(result.postInstallCommand).toBeUndefined();
  });
});
