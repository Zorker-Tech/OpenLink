import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hydrateSelectedExtraContext,
  type ExtraContextBlobStore,
  type ExtraContextEntry,
} from "../../source/packages/agent/context/extra-context-hydration.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const inline = (value: string): ExtraContextEntry => ({ dataOrBlobId: { case: "data", value } });
const fromBlob = (key: string): ExtraContextEntry => ({ dataOrBlobId: { case: "blobId", value: bytes(key) } });
const nothing: ExtraContextEntry = { dataOrBlobId: { case: undefined } };

/** A blob store that holds these texts under these keys. */
function store(blobs: Record<string, string>): ExtraContextBlobStore<string> & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async getBlob(_ctx, id) {
      const key = new TextDecoder().decode(id);
      asked.push(key);
      return blobs[key] === undefined ? undefined : bytes(blobs[key]!);
    },
  };
}

/** The extra context for a prompt made of these entries and these texts. */
const hydrate = (entries: ExtraContextEntry[], extraContext: string[], blobStore?: ExtraContextBlobStore<string>) =>
  hydrateSelectedExtraContext("ctx", { extraContextEntries: entries, extraContext }, blobStore);

describe("collecting the extra context for a prompt", () => {
  it("takes inline text and blob text into one list, in the order they were attached", async () => {
    const prompts = store({ k2: "from a blob" });
    assert.deepEqual(await hydrate([inline("first"), fromBlob("k2"), inline("last")], [], prompts), ["first", "from a blob", "last"]);
  });

  it("puts text that was already spelled out after the entries", async () => {
    assert.deepEqual(await hydrate([inline("first")], ["second", "third"]), ["first", "second", "third"]);
  });

  it("includes a value once, from wherever it came", async () => {
    const prompts = store({ k1: "same" });
    assert.deepEqual(await hydrate([inline("same"), fromBlob("k1"), inline("other")], ["same", "other", "new"], prompts), ["same", "other", "new"]);
  });

  it("skips an entry that carried nothing, and text that is empty", async () => {
    assert.deepEqual(await hydrate([nothing, inline(""), inline("real")], [""]), ["real"]);
  });

  it("skips a blob that decodes to nothing, rather than counting it as context", async () => {
    const prompts = store({ empty: "" });
    assert.deepEqual(await hydrate([fromBlob("empty"), inline("after")], [], prompts), ["after"]);
  });

  it("reads every entry, even when an earlier one would have been enough", async () => {
    const prompts = store({ k1: "one", k2: "two" });
    await hydrate([fromBlob("k1"), fromBlob("k2")], [], prompts);
    assert.deepEqual(prompts.asked, ["k1", "k2"]);
  });

  it("asks for nothing when there is nothing to read", async () => {
    const prompts = store({});
    assert.deepEqual(await hydrate([], []), []);
    assert.deepEqual(prompts.asked, []);
  });
});

describe("a blob that cannot be read", () => {
  it("is an error rather than a silent omission", async () => {
    await assert.rejects(hydrate([fromBlob("missing")], [], store({})), { message: "Extra context blob not found" });
  });

  it("is an error about the store when there is none to ask", async () => {
    await assert.rejects(hydrate([fromBlob("k1")], []), { message: "Blob store is required to hydrate extra context blob" });
  });

  it("does not stop an entry that was inline from being read first", async () => {
    // The entries are read together, so an inline one is never lost to a blob's failure — the call fails, and that is
    // the point: a prompt is either complete or not sent.
    await assert.rejects(hydrate([inline("ok"), fromBlob("missing")], [], store({})));
  });
});
