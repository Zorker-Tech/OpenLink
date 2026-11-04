import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AVATAR_MAX_BYTES,
  CANONICAL_AVATAR_FILENAME,
  CONVENTIONAL_AVATAR_EXTENSIONS,
  conventionalAvatarRank,
  invalidateAvatarDataUrlCache,
  isConventionalAvatarFilename,
  listConventionalAvatarFilenames,
  readAvatarBytesWithinDir,
  readAvatarWithinDir,
  readValidatedAvatar,
  resolveAvatarPathWithinDir,
  resolveDerivedAvatarFilename,
  sniffAvatarMimeType,
} from "../../source/host/agents/agent-avatar.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function withRoot(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-agent-avatar-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function withRootAsync(run: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = mkdtempSync(join(tmpdir(), "slate-agent-avatar-"));
  try {
    await run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function makePng(fill = 1, extraBytes = 4): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(extraBytes, fill)]);
}

function writeAvatar(agentDir: string, bytes: Uint8Array, name = CANONICAL_AVATAR_FILENAME): string {
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("avatar filenames and formats", () => {
  it("recognizes the conventional filenames and prefers the canonical one", () => {
    assert.deepEqual(CONVENTIONAL_AVATAR_EXTENSIONS, ["png", "jpg", "jpeg", "webp", "gif", "svg"]);
    assert.equal(isConventionalAvatarFilename("avatar.png"), true);
    assert.equal(isConventionalAvatarFilename("Avatar.SVG"), true);
    assert.equal(isConventionalAvatarFilename("profile.png"), false);
    assert.equal(conventionalAvatarRank(CANONICAL_AVATAR_FILENAME), -1);
    assert.equal(conventionalAvatarRank("avatar.jpg"), 1);
    assert.equal(conventionalAvatarRank("avatar.unknown"), CONVENTIONAL_AVATAR_EXTENSIONS.length);
  });

  it("lists conventional names in priority order and tolerates an unreadable directory", () => {
    withRoot((rootDir) => {
      writeFileSync(join(rootDir, "avatar.svg"), "<svg/>");
      writeFileSync(join(rootDir, "avatar.jpg"), "jpeg");
      writeFileSync(join(rootDir, "avatar.png"), "png");
      writeFileSync(join(rootDir, "profile.png"), "ignored");
      assert.deepEqual(listConventionalAvatarFilenames(rootDir), ["avatar.png", "avatar.jpg", "avatar.svg"]);
      assert.deepEqual(listConventionalAvatarFilenames(join(rootDir, "missing")), []);
    });
  });

  it("sniffs PNG, JPEG, GIF, WebP and SVG content, respecting a byte view", () => {
    assert.equal(sniffAvatarMimeType(PNG_SIGNATURE), "image/png");
    assert.equal(sniffAvatarMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x01])), "image/jpeg");
    assert.equal(sniffAvatarMimeType(Buffer.from("GIF89a-payload")), "image/gif");
    assert.equal(sniffAvatarMimeType(Buffer.from("RIFFxxxxWEBPpayload")), "image/webp");
    assert.equal(sniffAvatarMimeType(Buffer.from("\uFEFF  <SVG viewBox='0 0 1 1'></SVG>")), "image/svg+xml");
    const padded = Buffer.concat([Buffer.from([0]), PNG_SIGNATURE, Buffer.from([0])]);
    assert.equal(sniffAvatarMimeType(padded.subarray(1, 9)), "image/png");
    assert.equal(sniffAvatarMimeType(Buffer.from("not an image")), null);
  });
});

describe("keeping avatar paths inside an agent directory", () => {
  it("resolves relative and absolute files but rejects empty, parent and root paths", () => {
    withRoot((rootDir) => {
      const agentDir = join(rootDir, "agent");
      const avatar = writeAvatar(agentDir, makePng());
      const canonicalAvatar = realpathSync(avatar);
      assert.equal(resolveAvatarPathWithinDir(agentDir, "avatar.png"), canonicalAvatar);
      assert.equal(resolveAvatarPathWithinDir(agentDir, avatar), canonicalAvatar);
      assert.equal(resolveAvatarPathWithinDir(agentDir, " "), null);
      assert.equal(resolveAvatarPathWithinDir(agentDir, "../agent-outside.png"), null);
      assert.equal(resolveAvatarPathWithinDir(agentDir, agentDir), null);
      assert.equal(resolveAvatarPathWithinDir(agentDir, "missing.png"), null);
    });
  });

  it("allows an internal symlink and refuses a symlink that escapes the agent", () => {
    withRoot((rootDir) => {
      const agentDir = join(rootDir, "agent");
      const outside = join(rootDir, "outside.png");
      writeAvatar(agentDir, makePng());
      writeFileSync(outside, makePng(2));
      symlinkSync(join(agentDir, "avatar.png"), join(agentDir, "inside.png"));
      symlinkSync(outside, join(agentDir, "outside-link.png"));
      symlinkSync(join(agentDir, "avatar.png"), join(rootDir, "external-link-to-inside.png"));
      assert.equal(resolveAvatarPathWithinDir(agentDir, "inside.png"), realpathSync(join(agentDir, "avatar.png")));
      assert.equal(resolveAvatarPathWithinDir(agentDir, "outside-link.png"), null);
      assert.equal(resolveAvatarPathWithinDir(agentDir, join(rootDir, "external-link-to-inside.png")), null);
    });
  });
});

describe("deriving an avatar file from a legacy profile value", () => {
  it("chooses the highest-priority conventional file before consulting the legacy value", () => {
    withRoot((rootDir) => {
      const agentDir = join(rootDir, "agent");
      writeAvatar(agentDir, Buffer.from("svg"), "avatar.svg");
      writeAvatar(agentDir, makePng(), "avatar.png");
      writeAvatar(agentDir, Buffer.from("jpg"), "avatar.jpg");
      assert.equal(resolveDerivedAvatarFilename(agentDir, "not-an-avatar.png"), CANONICAL_AVATAR_FILENAME);
    });
  });

  it("copies a supported legacy image under its derived conventional name", () => {
    withRoot((rootDir) => {
      const agentDir = join(rootDir, "agent");
      const source = writeAvatar(agentDir, makePng(), "old-picture.data");
      assert.equal(resolveDerivedAvatarFilename(agentDir, "old-picture.data"), CANONICAL_AVATAR_FILENAME);
      assert.deepEqual(readFileSync(join(agentDir, CANONICAL_AVATAR_FILENAME)), makePng());
      assert.equal(source, join(agentDir, "old-picture.data"));
    });
  });

  it("preserves a legacy reference when its content cannot be classified", () => {
    withRoot((rootDir) => {
      const agentDir = join(rootDir, "agent");
      writeAvatar(agentDir, Buffer.from("text file"), "legacy.bin");
      assert.equal(resolveDerivedAvatarFilename(agentDir, "legacy.bin"), "legacy.bin");
      assert.equal(resolveDerivedAvatarFilename(agentDir, "../outside.png"), null);
    });
  });
});

describe("reading a validated avatar", () => {
  it("returns the recognized bytes and rejects unsupported or oversized files", async () => {
    await withRootAsync(async (rootDir) => {
      const agentDir = join(rootDir, "agent");
      const avatarPath = writeAvatar(agentDir, makePng());
      assert.deepEqual(await readValidatedAvatar(agentDir, "avatar.png"), { bytes: makePng(), mime: "image/png" });
      assert.deepEqual(await readAvatarBytesWithinDir(agentDir, "avatar.png"), makePng());
      writeFileSync(avatarPath, Buffer.from("not an image"));
      assert.equal(await readValidatedAvatar(agentDir, "avatar.png"), null);
      const exactLimit = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(AVATAR_MAX_BYTES - PNG_SIGNATURE.length, 3)]);
      writeFileSync(join(agentDir, "exact-limit.png"), exactLimit);
      assert.equal((await readValidatedAvatar(agentDir, "exact-limit.png"))?.bytes.length, AVATAR_MAX_BYTES);
      writeFileSync(avatarPath, makePng(1, AVATAR_MAX_BYTES));
      assert.equal(await readValidatedAvatar(agentDir, "avatar.png"), null);
      assert.equal(AVATAR_MAX_BYTES, 5 * 1024 * 1024);
    });
  });

  it("returns a data URL and stable content version, then honors explicit cache invalidation", async () => {
    await withRootAsync(async (rootDir) => {
      const agentDir = join(rootDir, "agent");
      const avatarPath = writeAvatar(agentDir, makePng(1));
      const first = await readAvatarWithinDir(agentDir, "avatar.png");
      assert.equal(first?.dataUrl, `data:image/png;base64,${makePng(1).toString("base64")}`);
      assert.equal(first?.version, createHash("sha256").update(makePng(1)).digest("hex").slice(0, 16));
      const timestamp = new Date(1_600_000_000_000);
      utimesSync(avatarPath, timestamp, timestamp);
      await readAvatarWithinDir(agentDir, "avatar.png");
      const newerTimestamp = new Date(timestamp.getTime() + 1_000);
      writeFileSync(avatarPath, makePng(2));
      utimesSync(avatarPath, newerTimestamp, newerTimestamp);
      const refreshed = await readAvatarWithinDir(agentDir, "avatar.png");
      assert.equal(refreshed?.version, createHash("sha256").update(makePng(2)).digest("hex").slice(0, 16));
      writeFileSync(avatarPath, makePng(3));
      utimesSync(avatarPath, newerTimestamp, newerTimestamp);
      assert.equal((await readAvatarWithinDir(agentDir, "avatar.png"))?.version, refreshed?.version);
      invalidateAvatarDataUrlCache(agentDir);
      assert.equal((await readAvatarWithinDir(agentDir, "avatar.png"))?.version, createHash("sha256").update(makePng(3)).digest("hex").slice(0, 16));
    });
  });

  it("evicts the least recently used avatar after the cache bound", async () => {
    await withRootAsync(async (rootDir) => {
      const firstDir = join(rootDir, "agent-0");
      const firstPath = writeAvatar(firstDir, makePng(1));
      const fixedTime = new Date(1_600_000_000_000);
      utimesSync(firstPath, fixedTime, fixedTime);
      const cached = await readAvatarWithinDir(firstDir, "avatar.png");
      for (let index = 1; index <= 128; index += 1) {
        const directory = join(rootDir, `agent-${index}`);
        writeAvatar(directory, makePng(index));
        await readAvatarWithinDir(directory, "avatar.png");
      }
      writeFileSync(firstPath, makePng(2));
      utimesSync(firstPath, fixedTime, fixedTime);
      const afterEviction = await readAvatarWithinDir(firstDir, "avatar.png");
      assert.notEqual(afterEviction?.version, cached?.version);
    });
  });
});
