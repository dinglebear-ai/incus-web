// @vitest-environment node

import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { stageGoldenConfigStream } from "./golden-config";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.INCUS_WEB_GOLDEN_CONFIG_DIR;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("stageGoldenConfigStream", () => {
  it("content-addresses concurrent uploads for the same workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "incus-web-golden-stage-"));
    tempDirs.push(dir);
    process.env.INCUS_WEB_GOLDEN_CONFIG_DIR = dir;
    const first = Buffer.from("PK\x03\x04first archive");
    const second = Buffer.from("PK\x03\x04second archive");

    const [stagedFirst, stagedSecond] = await Promise.all([
      stageGoldenConfigStream("workspace-1", stream(first), 1024),
      stageGoldenConfigStream("workspace-1", stream(second), 1024),
    ]);

    expect(stagedFirst.sha256Hex).toBe(createHash("sha256").update(first).digest("hex"));
    expect(stagedSecond.sha256Hex).toBe(createHash("sha256").update(second).digest("hex"));
    expect(stagedFirst.stagedPath).not.toBe(stagedSecond.stagedPath);
    await expect(readFile(stagedFirst.stagedPath)).resolves.toEqual(first);
    await expect(readFile(stagedSecond.stagedPath)).resolves.toEqual(second);
    await expect(access(join(dir, "workspace-1.zip"))).rejects.toThrow();
  });
});

function stream(content: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(content);
      controller.close();
    },
  });
}
