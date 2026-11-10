import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_INLINE_IMAGES_PER_ENTRY } from "../../source/host/rooms/xuser-wire-normalization.ts";
import {
  REMOTE_AGENT_ID_PREFIX,
  SLATE_SHARED_ROOM_IMAGE_BYTES_MAX,
  SlateXuserEntryPublisher,
  parseRemoteAgentId,
  type PublishableEntry,
  type XuserEntryPublisherHost,
} from "../../source/host/rooms/xuser-entry-publisher.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

interface FixtureOptions {
  enabled?: boolean;
  selfAuthId?: string | null;
  now?: number;
  send?: (payload: unknown) => Promise<{ timestampMs?: number }>;
  restamp?: (args: { roomId: string; entryId: string; timestampMs: number }) => Promise<void>;
  resolve?: (url: string) => Promise<{ data: Uint8Array; mimeType: string } | null>;
}

function fixture(options: FixtureOptions = {}) {
  const sent: unknown[] = [];
  const restamped: Array<{ roomId: string; entryId: string; timestampMs: number }> = [];
  const resolvedUrls: string[] = [];
  let selfReads = 0;
  let enableReads = 0;
  const host: XuserEntryPublisherHost = {
    relay: {
      send: async (payload) => {
        sent.push(payload);
        return options.send?.(payload) ?? {};
      },
    },
    manager: {
      restampRoomEntry: async (args) => {
        restamped.push(args);
        await options.restamp?.(args);
      },
    },
    clock: { now: () => options.now ?? 1_234 },
    isEnabled: () => { enableReads += 1; return options.enabled ?? true; },
    getSelfAuthId: () => { selfReads += 1; return options.selfAuthId === undefined ? "self-auth" : options.selfAuthId; },
    resolveAttachment: async (url) => {
      resolvedUrls.push(url);
      return options.resolve?.(url) ?? null;
    },
  };
  return { publisher: new SlateXuserEntryPublisher(host), sent, restamped, resolvedUrls, get selfReads() { return selfReads; }, get enableReads() { return enableReads; } };
}

const human = (overrides: Record<string, unknown> = {}): PublishableEntry => ({
  id: "entry-user",
  kind: "message",
  role: "user",
  content: "hello",
  ...overrides,
} as PublishableEntry);

const agent = (overrides: Record<string, unknown> = {}): PublishableEntry => ({
  id: "entry-agent",
  kind: "send-message",
  message: { type: "text", content: "answer" },
  author: { id: "agent-1", name: "Helper" },
  ...overrides,
} as PublishableEntry);

describe("shared room entry publishing behavior contract", () => {
  it("parses only well-formed remote agent ids and decodes each component", () => {
    assert.equal(REMOTE_AGENT_ID_PREFIX, "slate-remote:");
    assert.deepEqual(parseRemoteAgentId("slate-remote:owner%2Fid/agent%20one"), { ownerAuthId: "owner/id", agentId: "agent one" });
    assert.equal(parseRemoteAgentId("agent-1"), null);
    assert.equal(parseRemoteAgentId("slate-remote:/agent"), null);
    assert.equal(parseRemoteAgentId("slate-remote:owner/"), null);
    assert.equal(parseRemoteAgentId("slate-remote:owner%ZZ/agent"), null);
  });

  it("serializes an ordinary user message with original text, nonce, images and clock fallback", async () => {
    const h = fixture({ now: 4_321, resolve: async () => ({ data: new Uint8Array([1, 2]), mimeType: "image/png" }) });
    const wire = await h.publisher.serializeEntry(human({ content: "  hello  ", clientNonce: "nonce-1", images: [{ url: "upload://1", alt: "cover" }] }), "auth-7");
    assert.deepEqual(wire, {
      kind: "human-message",
      entryId: "entry-user",
      authorAuthId: "auth-7",
      authorName: "Host",
      text: "  hello  ",
      images: [{ base64: "AQI=", mediaType: "image/png", alt: "cover" }],
      clientNonce: "nonce-1",
      timestampMs: 4_321,
    });
  });

  it("preserves an explicit zero timestamp and omits absent optional fields", async () => {
    const wire = await fixture().publisher.serializeEntry(human({ timestampMs: 0, clientNonce: null, images: [] }), "auth-1");
    assert.deepEqual(wire, {
      kind: "human-message", entryId: "entry-user", authorAuthId: "auth-1", authorName: "Host",
      text: "hello", images: [], timestampMs: 0,
    });
  });

  it("does not publish routed, blank, or non-user message entries", async () => {
    const h = fixture();
    assert.equal(await h.publisher.serializeEntry(human({ content: " \n\t" }), "auth"), null);
    for (const field of ["fromAgent", "toAgent", "channel", "fromUser"]) {
      assert.equal(await h.publisher.serializeEntry(human({ [field]: "routed" }), "auth"), null, `${field} stays local`);
    }
    assert.equal(await h.publisher.serializeEntry({ id: "system", kind: "message", role: "assistant", content: "x" }, "auth"), null);
  });

  it("serializes text agent messages and excludes remote, streaming, and non-text entries", async () => {
    const h = fixture({ now: 9 });
    assert.deepEqual(await h.publisher.serializeEntry(agent(), "owner-auth"), {
      kind: "agent-message", entryId: "entry-agent", agentOwnerAuthId: "owner-auth", agentId: "agent-1",
      authorName: "Helper", text: "answer", images: [], timestampMs: 9,
    });
    assert.equal(await h.publisher.serializeEntry(agent({ author: { id: "slate-remote:owner/agent", name: "Remote" } }), "auth"), null);
    assert.equal(await h.publisher.serializeEntry(agent({ streaming: true }), "auth"), null);
    assert.equal(await h.publisher.serializeEntry(agent({ message: { type: "tool", content: "hidden" } }), "auth"), null);
    assert.equal(await h.publisher.serializeEntry(agent({ author: undefined }), "auth"), null);
  });

  it("keeps inline images in order within the byte budget and skips invalid resolutions", async () => {
    const h = fixture({
      resolve: async (url) => {
        if (url === "first") return { data: new Uint8Array(700_000), mimeType: "image/jpeg" };
        if (url === "over-budget") return { data: new Uint8Array(500_001), mimeType: "image/png" };
        if (url === "fits-after-skip") return { data: new Uint8Array(400_000), mimeType: "image/webp" };
        if (url === "not-image") return { data: new Uint8Array([1]), mimeType: "text/plain" };
        if (url === "missing") return null;
        throw new Error("unavailable");
      },
    });
    const result = await h.publisher.inlineImages([
      { url: "first", alt: "first" },
      { url: "over-budget", alt: "skip" },
      { url: "fits-after-skip", alt: "" },
      { url: "not-image" },
      { url: "missing" },
      { url: "throws" },
    ]);
    assert.equal(SLATE_SHARED_ROOM_IMAGE_BYTES_MAX, 1_100_000);
    assert.deepEqual(result, [
      { base64: Buffer.from(new Uint8Array(700_000)).toString("base64"), mediaType: "image/jpeg", alt: "first" },
      { base64: Buffer.from(new Uint8Array(400_000)).toString("base64"), mediaType: "image/webp" },
    ]);
    assert.deepEqual(await h.publisher.inlineImages([{ url: "missing" }, { url: "throws" }]), []);
    assert.deepEqual(h.resolvedUrls, ["first", "over-budget", "fits-after-skip", "not-image", "missing", "throws"]);
  });

  it("only resolves the configured number of image attachments", async () => {
    const h = fixture({ resolve: async () => ({ data: new Uint8Array([1]), mimeType: "image/png" }) });
    const inputs = Array.from({ length: MAX_INLINE_IMAGES_PER_ENTRY + 1 }, (_, index) => ({ url: `image-${index}` }));
    const output = await h.publisher.inlineImages(inputs);
    assert.equal(output.length, MAX_INLINE_IMAGES_PER_ENTRY);
    assert.deepEqual(h.resolvedUrls, inputs.slice(0, MAX_INLINE_IMAGES_PER_ENTRY).map(({ url }) => url));
  });

  it("checks the enablement and self identity before sending", async () => {
    const disabled = fixture({ enabled: false });
    await disabled.publisher.publishEntry("room", human());
    assert.deepEqual(disabled.sent, []);
    assert.equal(disabled.selfReads, 0);

    const anonymous = fixture({ selfAuthId: null });
    await anonymous.publisher.publishEntry("room", human());
    assert.deepEqual(anonymous.sent, []);
    assert.deepEqual(anonymous.resolvedUrls, []);
  });

  it("sends the room envelope and restamps only when the relay returns a timestamp", async () => {
    const h = fixture({ send: async () => ({ timestampMs: 55 }) });
    await h.publisher.publishEntry("room-4", human({ timestampMs: 12 }),);
    assert.deepEqual(h.sent, [{ kind: "room-entry", roomId: "room-4", entry: {
      kind: "human-message", entryId: "entry-user", authorAuthId: "self-auth", authorName: "Host",
      text: "hello", images: [], timestampMs: 12,
    } }]);
    assert.deepEqual(h.restamped, [{ roomId: "room-4", entryId: "entry-user", timestampMs: 55 }]);

    const noTimestamp = fixture();
    await noTimestamp.publisher.publishEntry("room-5", human());
    assert.deepEqual(noTimestamp.restamped, []);
  });

  it("serializes publishes per room while allowing another room to make progress", async () => {
    const first = deferred<{ timestampMs?: number }>();
    const firstStarted = deferred<void>();
    const secondRoomSent = deferred<void>();
    const secondFirstRoomSent = deferred<void>();
    const h = fixture({ send: async (payload) => {
      const roomId = (payload as { roomId: string }).roomId;
      if (roomId === "room-a" && !firstStartedResolved) {
        firstStartedResolved = true;
        firstStarted.resolve();
        return first.promise;
      }
      if (roomId === "room-b") secondRoomSent.resolve();
      if (roomId === "room-a") secondFirstRoomSent.resolve();
      return {};
    } });
    let firstStartedResolved = false;

    h.publisher.enqueuePublish("room-a", human({ id: "a1" }));
    h.publisher.enqueuePublish("room-a", human({ id: "a2" }));
    h.publisher.enqueuePublish("room-b", human({ id: "b1" }));
    await Promise.all([firstStarted.promise, secondRoomSent.promise]);
    assert.deepEqual(h.sent.map((payload) => (payload as { roomId: string; entry: { entryId: string } }).entry.entryId), ["a1", "b1"]);
    first.resolve({});
    await secondFirstRoomSent.promise;
    assert.deepEqual(h.sent.map((payload) => (payload as { entry: { entryId: string } }).entry.entryId), ["a1", "b1", "a2"]);
  });

  it("continues a room's queue after one relay send fails", async () => {
    const secondSent = deferred<void>();
    let attempt = 0;
    const h = fixture({ send: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("relay unavailable");
      secondSent.resolve();
      return {};
    } });
    h.publisher.enqueuePublish("room", human({ id: "fail" }));
    h.publisher.enqueuePublish("room", human({ id: "recover" }));
    await secondSent.promise;
    assert.deepEqual(h.sent.map((payload) => (payload as { entry: { entryId: string } }).entry.entryId), ["fail", "recover"]);
  });
});
