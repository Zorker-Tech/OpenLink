/**
 * The host's own edges: where it is listening, the lock that keeps one host per machine, what a channel
 * may attach, the source map it keeps, an agent's picture and the disk-pressure ledger.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { isGatewayDiscoveryInfo } from "../../source/host/host-discovery.ts";
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_TAKEOVER_TIMEOUT_MS, MAX_ACQUIRE_ATTEMPTS } from "../../source/host/host-lock.ts";
import { CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES, GENERIC_BINARY_MIME, resolveChannelAttachment, toLocalChannelAttachmentPath, urlLooksLikeImage } from "../../source/host/connectors/channel-attachment.ts";
import { BOX_STORE_SOURCE_KEY, getSourceMapPath } from "../../source/host/extensions/source-map/source-map-service.ts";
import { AVATAR_MAX_BYTES, CANONICAL_AVATAR_FILENAME } from "../../source/host/agents/agent-avatar.ts";
import { SlateDiskPressureLedgerError } from "../../source/host/boxes/forever-box/disk-pressure.ts";

const scratch = mkdtempSync(join(tmpdir(), "slate-host-runtime-6-"));
after(() => { rmSync(scratch, { recursive: true, force: true }); });

describe("where a host says it is listening", () => {
  it("takes a record only when it holds a port, a process and when it started", () => {
    assert.equal(isGatewayDiscoveryInfo(null), false);
    assert.equal(isGatewayDiscoveryInfo({}), false);
    assert.equal(isGatewayDiscoveryInfo({ port: "1", pid: 2, startedAt: 3 }), false);
    assert.equal(isGatewayDiscoveryInfo({ port: 1, pid: 2, startedAt: 3 }), true);
    assert.equal(isGatewayDiscoveryInfo({ port: 1, pid: 2, startedAt: 3, scheme: "https" }), true);
  });
});

describe("the lock that keeps one host per machine", () => {
  it("waits, gives up, and knows how long it waits", () => {
    assert.equal(DEFAULT_POLL_INTERVAL_MS, 100);
    assert.equal(DEFAULT_TAKEOVER_TIMEOUT_MS, 3_000);
    assert.equal(MAX_ACQUIRE_ATTEMPTS, 5);
  });
});

describe("what a channel may attach", () => {
  it("judges a link by what it points at, and turns a file link into a path", () => {
    assert.equal(CHANNEL_ATTACHMENT_MAX_UPLOAD_BYTES, 50 * 1024 * 1024);
    assert.equal(urlLooksLikeImage("https://example.com/a.png"), true);
    assert.equal(urlLooksLikeImage("https://example.com/a.txt"), false);
    assert.equal(toLocalChannelAttachmentPath("file:///tmp/a.png"), "/tmp/a.png");
    assert.equal(GENERIC_BINARY_MIME.length > 0, true);
  });

  it("refuses what it cannot read rather than attaching half of it", async () => {
    const missing = await resolveChannelAttachment({ url: "file:///tmp/definitely-not-here-9f3a.png" } as never).catch(() => null);
    assert.equal(missing, null);
    const good = join(scratch, "note.txt");
    writeFileSync(good, "hello");
    // A local link it cannot turn into a usable attachment resolves to nothing rather than to a half-read file.
    assert.equal(await resolveChannelAttachment({ url: `file://${good}` } as never), null);
  });
});

describe("where the code an agent works on came from", () => {
  it("keeps a source map under the host's root and names the box-store source", () => {
    assert.equal(BOX_STORE_SOURCE_KEY.length > 0, true);
    assert.match(getSourceMapPath(), /source-map|sources/);
  });
});

describe("an agent's picture", () => {
  it("bounds it and names the file it prefers", () => {
    assert.equal(AVATAR_MAX_BYTES > 0, true);
    assert.equal(CANONICAL_AVATAR_FILENAME.length > 0, true);
  });
});

describe("remembering that the disk was filling up", () => {
  it("names the error a broken ledger raises", () => {
    const error = new SlateDiskPressureLedgerError("broken");
    assert.equal(error instanceof Error, true);
    assert.equal(error.message, "broken");
  });
});
