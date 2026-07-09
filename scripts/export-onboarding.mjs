#!/usr/bin/env node
// Bundles a user's ~/.claude and ~/.codex config surface (settings, mcp config,
// skills, agents, plugins, marketplaces, CLAUDE.md/AGENTS.md, memories) into a
// single zip so it can be imported into an incus-web workspace to seed a
// matching setup. See `--help` for usage.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB
const SKIP_DIR_NAMES = new Set([
  "cache",
  "node_modules",
  ".git",
  ".system", // Codex's built-in system skill cache, ships with Codex itself
]);
const SKIP_FILE_SUFFIXES = [".sqlite", ".sqlite-wal", ".sqlite-shm", ".log"];

// Each entry is a path relative to the source root (~/.claude or ~/.codex).
// `optional: true` means "skip silently if missing"; anything else is a
// required item that gets a warning (not a hard failure) if absent.
const CLAUDE_INCLUDES = [
  { path: "CLAUDE.md" },
  { path: "AGENTS.md", optional: true },
  { path: "GEMINI.md", optional: true },
  { path: "settings.json" },
  { path: "settings.local.json", optional: true },
  { path: ".claude.json", optional: true },
  { path: ".mcp.json", optional: true },
  { path: "skills", type: "dir", optional: true },
  { path: "agents", type: "dir", optional: true },
  { path: "agent-memory", type: "dir", optional: true },
  { path: "plugins/installed_plugins.json", optional: true },
  { path: "plugins/known_marketplaces.json", optional: true },
  { path: "plugins/blocklist.json", optional: true },
  { path: "plugins/data", type: "dir", optional: true },
];
// Deliberately excluded: plugins/marketplaces and plugins/cache. Both are
// full clones of plugin/marketplace git repos re-fetched from the source
// recorded in known_marketplaces.json / installed_plugins.json — bundling
// them just duplicates fetchable code and can blow up the zip by 100s of MB.

const CODEX_INCLUDES = [
  { path: "config.toml" },
  { path: "auth.json", optional: true },
  { path: "AGENTS.md", optional: true },
  { path: "hooks.json", optional: true },
  { path: "agents", type: "dir", optional: true },
  { path: "skills", type: "dir", optional: true },
  { path: "prompts", type: "dir", optional: true },
  { path: "rules", type: "dir", optional: true },
  { path: "memories/MEMORY.md", optional: true },
  { path: "memories/memory_summary.md", optional: true },
  { path: "memories/raw_memories.md", optional: true },
  { path: "memories/extensions", type: "dir", optional: true },
  { path: "memories/skills", type: "dir", optional: true },
  { path: "plugins/data", type: "dir", optional: true },
];
// Deliberately excluded: plugins/cache, plugins/.marketplace-plugin-source-staging,
// plugins/.remote-plugin-install-staging — cloned/staged plugin source, all
// re-fetchable and not part of the user's actual config. Also
// memories/rollout_summaries — auto-generated per-session history, not
// portable memory content.

function parseArgs(argv) {
  const opts = {
    out: null,
    claudeDir: join(homedir(), ".claude"),
    codexDir: join(homedir(), ".codex"),
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--out":
        opts.out = resolve(argv[++i]);
        break;
      case "--claude-dir":
        opts.claudeDir = resolve(argv[++i]);
        break;
      case "--codex-dir":
        opts.codexDir = resolve(argv[++i]);
        break;
      case "--max-file-mb":
        opts.maxFileBytes = Number.parseFloat(argv[++i]) * 1024 * 1024;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/export-onboarding.mjs [options]

Bundles ~/.claude and ~/.codex config (settings, mcp config, skills, agents,
plugins, marketplaces, CLAUDE.md/AGENTS.md, memories) into a zip file for
import into an incus-web workspace.

Options:
  --out <path>         Output zip path (default: ./incus-onboarding-<host>-<timestamp>.zip)
  --claude-dir <path>  Override ~/.claude source dir
  --codex-dir <path>   Override ~/.codex source dir
  --max-file-mb <n>    Skip any single file larger than this many MiB (default: 25)
  -h, --help           Show this help
`);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function shouldSkipFile(absPath) {
  return SKIP_FILE_SUFFIXES.some((suffix) => absPath.endsWith(suffix));
}

// Manually walks + copies rather than fs.cp so every file gets the size guard
// and skip-list applied, and every skip/warning is captured for the manifest.
async function copyTree(srcRoot, destRoot, log) {
  async function walk(srcDir, destDir) {
    const entries = await readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);

      let fileStat;
      try {
        fileStat = await stat(srcPath); // follows symlinks
      } catch {
        log.skipped.push({ path: srcPath, reason: "broken symlink" });
        continue;
      }

      if (fileStat.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) {
          log.skipped.push({ path: srcPath, reason: "excluded directory" });
          continue;
        }
        await mkdir(destPath, { recursive: true });
        await walk(srcPath, destPath);
        continue;
      }

      if (shouldSkipFile(srcPath)) {
        log.skipped.push({ path: srcPath, reason: "excluded file type" });
        continue;
      }

      if (fileStat.size > log.maxFileBytes) {
        log.skipped.push({
          path: srcPath,
          reason: `exceeds max file size (${Math.round(fileStat.size / 1024 / 1024)} MiB)`,
        });
        continue;
      }

      await mkdir(destDir, { recursive: true });
      await copyFile(srcPath, destPath);
      log.included.push(srcPath);
    }
  }

  await mkdir(destRoot, { recursive: true });
  await walk(srcRoot, destRoot);
}

async function collectSource(sourceLabel, sourceRoot, includes, stagingRoot, log) {
  if (!(await pathExists(sourceRoot))) {
    log.warnings.push(`${sourceLabel} source dir not found: ${sourceRoot}`);
    return;
  }

  for (const item of includes) {
    const srcPath = join(sourceRoot, item.path);
    const destPath = join(stagingRoot, sourceLabel, item.path);

    if (!(await pathExists(srcPath))) {
      if (!item.optional) {
        log.warnings.push(`${sourceLabel}: expected but missing: ${item.path}`);
      }
      continue;
    }

    const info = await stat(srcPath);
    if (item.type === "dir" || info.isDirectory()) {
      await copyTree(srcPath, destPath, log);
    } else {
      if (shouldSkipFile(srcPath)) {
        log.skipped.push({ path: srcPath, reason: "excluded file type" });
        continue;
      }
      if (info.size > log.maxFileBytes) {
        log.skipped.push({
          path: srcPath,
          reason: `exceeds max file size (${Math.round(info.size / 1024 / 1024)} MiB)`,
        });
        continue;
      }
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      log.included.push(srcPath);
    }
  }
}

function runZip(stagingDir, outPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("zip", ["-r", "-q", outPath, "."], {
      cwd: stagingDir,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        rejectPromise(
          new Error("`zip` command not found on PATH; install zip and retry."),
        );
      } else {
        rejectPromise(err);
      }
    });
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`zip exited with code ${code}`));
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath =
    opts.out || resolve(`incus-onboarding-${hostname()}-${timestamp}.zip`);

  const log = {
    included: [],
    skipped: [],
    warnings: [],
    maxFileBytes: opts.maxFileBytes,
  };

  const stagingDir = await mkdtemp(join(tmpdir(), "incus-onboarding-"));

  try {
    await collectSource("claude", opts.claudeDir, CLAUDE_INCLUDES, stagingDir, log);
    await collectSource("codex", opts.codexDir, CODEX_INCLUDES, stagingDir, log);

    const manifest = {
      generatedAt: new Date().toISOString(),
      host: hostname(),
      claudeDir: opts.claudeDir,
      codexDir: opts.codexDir,
      includedCount: log.included.length,
      skipped: log.skipped,
      warnings: log.warnings,
    };
    await writeFile(
      join(stagingDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    if (existsSync(outPath)) {
      await rm(outPath);
    }
    await runZip(stagingDir, outPath);

    console.log(`Wrote ${outPath}`);
    console.log(`  included: ${log.included.length} files`);
    if (log.skipped.length) {
      console.log(`  skipped: ${log.skipped.length} (see manifest.json in the zip)`);
    }
    for (const warning of log.warnings) {
      console.warn(`  warning: ${warning}`);
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
