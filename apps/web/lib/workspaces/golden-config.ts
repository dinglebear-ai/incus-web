import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";

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

export class GoldenConfigUploadError extends Error {
  constructor(
    message: string,
    public readonly code: "busy" | "empty" | "invalid_zip" | "too_large",
  ) {
    super(message);
  }
}

let activeUploads = 0;

function maxConcurrentUploads(): number {
  const parsed = Number.parseInt(process.env.INCUS_WEB_GOLDEN_CONFIG_MAX_CONCURRENT_UPLOADS ?? "2", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
}

// Stream uploads to disk so accepted archives never exist as a second
// process-sized Buffer. The digest and ZIP signature are computed while the
// bytes are flowing, and a failed/cancelled request never replaces the last
// complete staged archive.
export async function stageGoldenConfigStream(
  workspaceId: string,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ sha256Hex: string; stagedPath: string }> {
  if (!body) throw new GoldenConfigUploadError("golden config upload was empty", "empty");
  if (activeUploads >= maxConcurrentUploads()) {
    throw new GoldenConfigUploadError("too many golden config uploads are active", "busy");
  }
  activeUploads += 1;
  try {
    const dir = goldenConfigDirFromEnv();
    await mkdir(dir, { recursive: true, mode: 0o770 });
    const tempPath = join(
      dir,
      `.${workspaceId}.zip.uploading-${process.pid}-${Date.now()}-${randomUUID()}`,
    );
    const output = createWriteStream(tempPath, { mode: 0o640, flags: "wx" });
    const outputFailure = new Promise<never>((_, reject) => output.once("error", reject));
    // Every read/write/finish wait races this promise. Attach a handler now so
    // an immediate open error cannot become an unhandled rejection first.
    void outputFailure.catch(() => undefined);
    const reader = body.getReader();
    const hash = createHash("sha256");
    const signature = new Uint8Array(4);
    let signatureBytes = 0;
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), outputFailure]);
        if (done) break;
        if (!value?.byteLength) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new GoldenConfigUploadError("request body exceeded the configured limit", "too_large");
        }
        const copyLength = Math.min(4 - signatureBytes, value.byteLength);
        if (copyLength > 0) {
          signature.set(value.subarray(0, copyLength), signatureBytes);
          signatureBytes += copyLength;
        }
        hash.update(value);
        if (!output.write(value)) await Promise.race([once(output, "drain"), outputFailure]);
      }
      if (total === 0) throw new GoldenConfigUploadError("golden config upload was empty", "empty");
      if (!looksLikeZip(signature)) {
        throw new GoldenConfigUploadError("golden config upload does not look like a zip file", "invalid_zip");
      }
      output.end();
      await Promise.race([once(output, "finish"), outputFailure]);
      const sha256Hex = hash.digest("hex");
      const finalPath = join(dir, `${workspaceId}-${sha256Hex}.zip`);
      await rename(tempPath, finalPath);
      return { sha256Hex, stagedPath: finalPath };
    } catch (error) {
      output.destroy();
      await rm(tempPath, { force: true });
      throw error;
    } finally {
      reader.releaseLock();
    }
  } finally {
    activeUploads -= 1;
  }
}
