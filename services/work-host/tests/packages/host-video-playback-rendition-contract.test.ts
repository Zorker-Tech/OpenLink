import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  FAILED_RESOLUTION_RETRY_MS,
  MAX_CACHED_RENDITIONS,
  VIDEO_TOOL_TIMEOUT_MS,
  createVideoPlaybackSource,
  withVideoPlaybackSource,
} from "../../source/host/attachments/video-playback-rendition.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-video-rendition-contract-"));
// The test data may live on a mounted workspace volume; executable fixtures stay on the local temp filesystem.
const toolsDir = mkdtempSync(join("/tmp", "slate-video-rendition-tools-"));
const callLog = join(scratch, "calls.ndjson");
const cacheDir = join(tmpdir(), `slate-video-playback-${process.pid}`);
mkdirSync(toolsDir, { recursive: true });

const fakeTool = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
async function main() {
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const record = (event) => fs.appendFileSync(process.env.SLATE_VIDEO_TEST_LOG, JSON.stringify(event) + "\\n");
if (name === "ffprobe") {
  const source = args.at(-1);
  record({ tool: name, event: "call", source });
  if (process.env.SLATE_VIDEO_TEST_FAIL_PROBE === "1") {
    process.stderr.write("probe failed");
    process.exitCode = 2;
  } else {
    const content = fs.readFileSync(source, "utf8");
    process.stdout.write(content.includes("hevc") ? "hevc\\n" : "h264\\n");
  }
} else {
  const input = args[args.indexOf("-i") + 1];
  const output = args.at(-1);
  record({ tool: name, event: "call", input, output });
  let slot;
  const slots = process.env.SLATE_VIDEO_TEST_SLOTS;
  if (slots) {
    fs.mkdirSync(slots, { recursive: true });
    while (slot === undefined) {
      for (let index = 0; index < 8; index += 1) {
        const candidate = path.join(slots, "slot-" + index);
        try { fs.mkdirSync(candidate); slot = candidate; break; } catch {}
      }
      if (slot === undefined) await delay(2);
    }
    record({ tool: name, event: "start", active: fs.readdirSync(slots).length });
  }
  try {
    await delay(25);
    if (process.env.SLATE_VIDEO_TEST_FAIL_ENCODE === "1") {
      fs.writeFileSync(output, "partial");
      process.stderr.write("encode failed");
      process.exitCode = 2;
    } else {
      fs.writeFileSync(output, "rendition:" + fs.readFileSync(input, "utf8"));
    }
  } finally {
    if (slot !== undefined) {
      fs.rmSync(slot, { recursive: true, force: true });
      record({ tool: name, event: "end", active: fs.readdirSync(slots).length });
    }
  }
}
}
main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
`;

for (const tool of ["ffprobe", "ffmpeg"]) {
  const executable = join(toolsDir, tool);
  writeFileSync(executable, fakeTool);
  chmodSync(executable, 0o755);
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(toolsDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

function source(name: string, contents: string): string {
  const path = join(scratch, name);
  writeFileSync(path, contents);
  return path;
}

function calls(tool: string): Array<Record<string, unknown>> {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.tool === tool && event.event === "call");
}

async function withFakeTools<T>(run: () => Promise<T>): Promise<T> {
  const keys = ["PATH", "SLATE_VIDEO_TEST_LOG", "SLATE_VIDEO_TEST_FAIL_PROBE", "SLATE_VIDEO_TEST_FAIL_ENCODE", "SLATE_VIDEO_TEST_SLOTS"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  rmSync(callLog, { force: true });
  rmSync(join(scratch, "slots"), { recursive: true, force: true });
  process.env.PATH = `${toolsDir}:${previous.get("PATH") ?? ""}`;
  process.env.SLATE_VIDEO_TEST_LOG = callLog;
  delete process.env.SLATE_VIDEO_TEST_FAIL_PROBE;
  delete process.env.SLATE_VIDEO_TEST_FAIL_ENCODE;
  delete process.env.SLATE_VIDEO_TEST_SLOTS;
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("video playback rendition behavior contract", () => {
  it("uses the original source for an unsupported codec without starting a transcode", async () => {
    await withFakeTools(async () => {
      const input = source("unsupported.mp4", "h264 video");
      const result = await withVideoPlaybackSource(input, async (resolved) => resolved);
      assert.equal(result, input);
      assert.equal(calls("ffprobe").length, 1);
      assert.equal(calls("ffmpeg").length, 0);
    });
  });

  it("shares an in-flight HEVC conversion and reuses its completed rendition", async () => {
    await withFakeTools(async () => {
      const input = source("shared-hevc.mp4", "hevc video");
      const read = (resolved: string) => Promise.resolve({ resolved, exists: existsSync(resolved) });
      const [first, second] = await Promise.all([
        withVideoPlaybackSource(input, read),
        withVideoPlaybackSource(input, read),
      ]);
      assert.equal(first.resolved, second.resolved);
      assert.notEqual(first.resolved, input);
      assert.equal(first.exists, true);
      assert.equal(calls("ffprobe").length, 1);
      assert.equal(calls("ffmpeg").length, 1);
      assert.equal(await withVideoPlaybackSource(input, async (resolved) => resolved), first.resolved);
      assert.equal(calls("ffprobe").length, 1);
      assert.equal(calls("ffmpeg").length, 1);
    });
  });

  it("uses a complete cached rendition after probing without encoding again", async () => {
    await withFakeTools(async () => {
      const input = source("existing-hevc.mp4", "hevc video");
      mkdirSync(cacheDir, { recursive: true });
      const rendition = join(cacheDir, "already-ready.mp4");
      writeFileSync(rendition, "ready");
      assert.equal(await createVideoPlaybackSource(input, rendition), rendition);
      assert.equal(calls("ffprobe").length, 1);
      assert.equal(calls("ffmpeg").length, 0);
    });
  });

  it("passes missing and non-file sources to the reader without invoking tools", async () => {
    await withFakeTools(async () => {
      const missing = join(scratch, "missing.mp4");
      const directory = join(scratch, "video-folder");
      mkdirSync(directory);
      assert.equal(await withVideoPlaybackSource(missing, async (resolved) => resolved), missing);
      assert.equal(await withVideoPlaybackSource(directory, async (resolved) => resolved), directory);
      assert.equal(calls("ffprobe").length, 0);
      assert.equal(calls("ffmpeg").length, 0);
    });
  });

  it("caches a probe failure until its retry deadline and then probes again", async () => {
    const originalNow = Date.now;
    let now = 100_000;
    Date.now = () => now;
    try {
      await withFakeTools(async () => {
        const input = source("retry.mp4", "h264 video");
        process.env.SLATE_VIDEO_TEST_FAIL_PROBE = "1";
        assert.equal(await withVideoPlaybackSource(input, async (resolved) => resolved), input);
        process.env.SLATE_VIDEO_TEST_FAIL_PROBE = "0";
        assert.equal(await withVideoPlaybackSource(input, async (resolved) => resolved), input);
        assert.equal(calls("ffprobe").length, 1);

        now += FAILED_RESOLUTION_RETRY_MS + 1;
        assert.equal(await withVideoPlaybackSource(input, async (resolved) => resolved), input);
        assert.equal(calls("ffprobe").length, 2);
      });
    } finally {
      Date.now = originalNow;
    }
  });

  it("falls back to the original after a failed encode and removes its partial file", async () => {
    await withFakeTools(async () => {
      const input = source("encode-error-hevc.mp4", "hevc video");
      process.env.SLATE_VIDEO_TEST_FAIL_ENCODE = "1";
      assert.equal(await withVideoPlaybackSource(input, async (resolved) => resolved), input);
      assert.equal(calls("ffmpeg").length, 1);
      assert.deepEqual(readdirSync(cacheDir).filter((name) => name.endsWith(".tmp.mp4")), []);
    });
  });

  it("bounds the LRU and re-probes a source after its entry is evicted", async () => {
    await withFakeTools(async () => {
      const inputs = Array.from({ length: MAX_CACHED_RENDITIONS + 1 }, (_, index) => source(`lru-${index}.mp4`, "h264 video"));
      for (const input of inputs) await withVideoPlaybackSource(input, async (resolved) => resolved);
      assert.equal(calls("ffprobe").length, MAX_CACHED_RENDITIONS + 1);
      await withVideoPlaybackSource(inputs[0]!, async (resolved) => resolved);
      assert.equal(calls("ffprobe").length, MAX_CACHED_RENDITIONS + 2);
    });
  });

  it("keeps an evicted rendition until its active reader finishes, then removes it", async () => {
    await withFakeTools(async () => {
      const input = source("active-reader-hevc.mp4", "hevc video");
      const entered = deferred<string>();
      const release = deferred<void>();
      const activeRead = withVideoPlaybackSource(input, async (resolved) => {
        entered.resolve(resolved);
        await release.promise;
        return resolved;
      });
      const rendition = await entered.promise;
      assert.notEqual(rendition, input);
      assert.equal(existsSync(rendition), true);

      const moreInputs = Array.from({ length: MAX_CACHED_RENDITIONS }, (_, index) => source(`evict-${index}.mp4`, "h264 video"));
      for (const other of moreInputs) await withVideoPlaybackSource(other, async (resolved) => resolved);
      assert.equal(existsSync(rendition), true);
      release.resolve();
      await activeRead;
      for (let attempt = 0; attempt < 30 && existsSync(rendition); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(existsSync(rendition), false);
    });
  });

  it("keeps concurrent transcodes within the two-process budget", async () => {
    await withFakeTools(async () => {
      process.env.SLATE_VIDEO_TEST_SLOTS = join(scratch, "slots");
      const inputs = Array.from({ length: 5 }, (_, index) => source(`parallel-${index}.mp4`, "hevc video"));
      await Promise.all(inputs.map((input) => withVideoPlaybackSource(input, async (resolved) => resolved)));

      const starts = readFileSync(callLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.tool === "ffmpeg" && event.event === "start");
      assert.equal(starts.length, inputs.length);
      assert.equal(Math.max(...starts.map((event) => Number(event.active))), 2);
    });
  });

  it("keeps the encoder's process deadline at two minutes", () => {
    assert.equal(VIDEO_TOOL_TIMEOUT_MS, 120_000);
  });
});
