import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeCoreMessageImagePresence,
  coreMessageJsonHasImage,
} from "../../source/packages/agent/conversation-image-presence.ts";

/** A part with an image marker under `depth` wrappers of the given kind. */
function imageBelow(depth: number, wrapper: "object" | "array"): unknown {
  let value: unknown = { type: "image" };
  for (let level = 0; level < depth; level += 1) {
    value = wrapper === "object" ? { part: value } : [value];
  }
  return value;
}

function messageWith(content: unknown): { role: string; content: unknown } {
  return { role: "user", content };
}

describe("whether a message's content holds an image", () => {
  it("answers no for anything that is not a content-bearing message", () => {
    for (const notAMessage of [null, undefined, 42, "image", true, [], {}]) {
      assert.equal(coreMessageJsonHasImage(notAMessage), false, String(notAMessage));
    }
    for (const notContent of [undefined, null, 7, "image", { 0: { type: "image" } }]) {
      assert.equal(coreMessageJsonHasImage({ role: "user", content: notContent }), false);
    }
    assert.equal(coreMessageJsonHasImage({ role: "user", content: [] }), false);
  });

  it("is true for a part that declares itself an image, wherever the search reaches it", () => {
    assert.equal(coreMessageJsonHasImage(messageWith([{ type: "image" }])), true);
    assert.equal(coreMessageJsonHasImage(messageWith([{ type: "text" }, { type: "image" }])), true);
    assert.equal(coreMessageJsonHasImage(messageWith([{ part: { type: "image" } }])), true);
    assert.equal(coreMessageJsonHasImage(messageWith([[{ type: "image" }]])), true);
    assert.equal(coreMessageJsonHasImage(messageWith([{ type: "text" }])), false);
    assert.equal(coreMessageJsonHasImage(messageWith([{ type: "img" }])), false);
  });

  it("follows six levels of nesting and stops there", () => {
    // A part is at level zero, so the marker may sit under six wrappers and not under seven.
    for (const wrapper of ["object", "array"] as const) {
      assert.equal(coreMessageJsonHasImage(messageWith([imageBelow(6, wrapper)])), true, wrapper);
      assert.equal(coreMessageJsonHasImage(messageWith([imageBelow(7, wrapper)])), false, wrapper);
    }
  });

  it("cannot be made to walk a part that refers to itself", () => {
    const cyclic: Record<string, unknown> = { type: "text" };
    cyclic.self = cyclic;
    assert.equal(coreMessageJsonHasImage(messageWith([cyclic])), false);
  });

  it("takes a marker on the container itself, but does not search an array's extra properties", () => {
    const markedArray: unknown[] & { type?: string } = [{ type: "text" }];
    markedArray.type = "image";
    assert.equal(coreMessageJsonHasImage(messageWith([markedArray])), true, "the marker is checked before the array is walked");

    const arrayWithExtra: unknown[] & { extra?: unknown } = [{ type: "text" }];
    arrayWithExtra.extra = { type: "image" };
    assert.equal(coreMessageJsonHasImage(messageWith([arrayWithExtra])), false, "an array is walked by its items, not its properties");

    assert.equal(coreMessageJsonHasImage(messageWith([Object.create({ type: "image" })])), true, "a marker can be inherited");
  });
});

describe("the image presence of a conversation", () => {
  it("answers no image and zero turns for a conversation that has none", () => {
    assert.deepEqual(computeCoreMessageImagePresence([]), { containsImage: false, suffixNumberOfTurnsWithoutImages: 0 });
    const textOnly = [{ role: "user", content: [{ type: "text" }] }, { role: "assistant" }];
    assert.deepEqual(computeCoreMessageImagePresence(textOnly), { containsImage: false, suffixNumberOfTurnsWithoutImages: 1 });
  });

  it("counts the user turns after the newest image, and nothing else", () => {
    const conversation = [
      { role: "user", content: [{ type: "image" }] },
      { role: "assistant" },
      { role: "user", content: [{ type: "text" }] },
      { role: "assistant", content: [{ type: "image" }] },
      { role: "user" },
      { role: "user" },
    ];
    assert.deepEqual(computeCoreMessageImagePresence(conversation), { containsImage: true, suffixNumberOfTurnsWithoutImages: 2 });
  });

  it("counts a turn only when its role is exactly a user's", () => {
    const conversation = [
      { role: "user", content: [{ type: "image" }] },
      { role: "User" },
      { role: "USER" },
      { role: "assistant" },
      { role: null },
      {},
      { role: "user" },
    ];
    assert.deepEqual(computeCoreMessageImagePresence(conversation), { containsImage: true, suffixNumberOfTurnsWithoutImages: 1 });
  });

  it("answers zero turns when the newest message carries the image", () => {
    assert.deepEqual(
      computeCoreMessageImagePresence([{ role: "user" }, { role: "assistant", content: [{ type: "image" }] }]),
      { containsImage: true, suffixNumberOfTurnsWithoutImages: 0 },
    );
  });

  it("does not see an image the search is bounded away from", () => {
    const conversation = [{ role: "user" }, messageWith([imageBelow(8, "object")]), { role: "user" }];
    assert.deepEqual(computeCoreMessageImagePresence(conversation), { containsImage: false, suffixNumberOfTurnsWithoutImages: 3 });
  });
});
