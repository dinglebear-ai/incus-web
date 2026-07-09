import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Must match scripts/provisioner-server.mjs's own INCUS_WEB_GOLDEN_CONFIG_DIR
// default -- the provisioner reads back whatever this route stages here.
const DEFAULT_GOLDEN_CONFIG_DIR = "/var/lib/incus-web/golden-config";

// Sized to match scripts/provisioner-server.mjs's INCUS_WEB_GOLDEN_CONFIG_MAX_BYTES
// default; kept as a separate constant (not imported) since the two
// processes don't share a module boundary.
export const DEFAULT_GOLDEN_CONFIG_MAX_BYTES = 150 * 1024 * 1024;

export function goldenConfigDirFromEnv(): string {
  return process.env.INCUS_WEB_GOLDEN_CONFIG_DIR || DEFAULT_GOLDEN_CONFIG_DIR;
}

export function goldenConfigMaxBytesFromEnv(): number {
  const raw = process.env.INCUS_WEB_GOLDEN_CONFIG_MAX_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GOLDEN_CONFIG_MAX_BYTES;
}

// A zip's local-file-header signature ("PK\x03\x04") or, for a zip
// containing zero entries, the end-of-central-directory signature
// ("PK\x05\x06"). Anything else definitely isn't a zip -- rejecting it here
// avoids staging garbage that would just fail cryptically much later inside
// the container's `unzip`.
export function looksLikeZip(buffer: Uint8Array): boolean {
  if (buffer.length < 4) return false;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  return (
    (buffer[2] === 0x03 && buffer[3] === 0x04) ||
    (buffer[2] === 0x05 && buffer[3] === 0x06)
  );
}

// Writes to a sibling temp file and renames into place so a concurrent
// ImportGoldenConfig read (or a second upload racing this one) never
// observes a partially-written zip.
export async function stageGoldenConfigUpload(
  workspaceId: string,
  content: Buffer,
): Promise<{ sha256Hex: string; stagedPath: string }> {
  const dir = goldenConfigDirFromEnv();
  await mkdir(dir, { recursive: true, mode: 0o770 });
  const finalPath = join(dir, `${workspaceId}.zip`);
  const tempPath = join(dir, `.${workspaceId}.zip.uploading-${process.pid}-${Date.now()}`);
  await writeFile(tempPath, content, { mode: 0o640 });
  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  const sha256Hex = createHash("sha256").update(content).digest("hex");
  return { sha256Hex, stagedPath: finalPath };
}
