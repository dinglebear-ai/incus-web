import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

test("onboarding export excludes live credentials and protects the archive", async () => {
  const temp = await mkdtemp(join(tmpdir(), "incus-onboarding-test-"));
  const claudeDir = join(temp, "claude");
  const codexDir = join(temp, "codex");
  const output = join(temp, "onboarding.zip");

  try {
    await mkdir(claudeDir);
    await mkdir(codexDir);
    await writeFile(join(claudeDir, "CLAUDE.md"), "safe\n");
    await writeFile(join(claudeDir, "settings.json"), "{}\n");
    await writeFile(join(codexDir, "config.toml"), "model = 'test'\n");
    await writeFile(join(codexDir, "auth.json"), '{"token":"live-secret"}\n');

    const result = spawnSync(
      process.execPath,
      [
        join(root, "scripts/export-onboarding.mjs"),
        "--claude-dir",
        claudeDir,
        "--codex-dir",
        codexDir,
        "--out",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);

    const entries = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" });
    assert.doesNotMatch(entries, /codex\/auth\.json/);
    assert.match(result.stderr, /auth\.json was excluded/);
    assert.equal((await stat(output)).mode & 0o777, 0o600);

    const manifest = JSON.parse(
      execFileSync("unzip", ["-p", output, "manifest.json"], { encoding: "utf8" }),
    );
    assert.ok(
      manifest.skipped.some(
        (entry) => entry.path.endsWith("/auth.json") && entry.reason.includes("credentials"),
      ),
    );
    assert.doesNotMatch(await readFile(output, "latin1"), /live-secret/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
