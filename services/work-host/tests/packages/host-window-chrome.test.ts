import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPUTER_OVERLAY_HEIGHT_PX,
  COMPUTER_TOP_BAR_PX,
  TITLE_BAR_BLOCK_PX,
  TITLE_BAR_OVERLAY_HEIGHT_PX,
  TRAFFIC_LIGHTS_AT,
  blendOver,
  overlayBackgroundFor,
  overlayHeightFor,
  overlaySymbolColorFor,
} from "../../source/shared/window-chrome.ts";

describe("where the platform draws its own furniture", () => {
  it("places the traffic lights, and gives each bar the height its own block has", () => {
    assert.deepEqual(TRAFFIC_LIGHTS_AT, { x: 16, y: 15 });
    assert.equal(TITLE_BAR_BLOCK_PX, 52);
    assert.equal(TITLE_BAR_OVERLAY_HEIGHT_PX, TITLE_BAR_BLOCK_PX - 1);
    assert.equal(COMPUTER_TOP_BAR_PX, 44);
    assert.equal(COMPUTER_OVERLAY_HEIGHT_PX, COMPUTER_TOP_BAR_PX - 1);
  });

  it("gives the overlay the height of the bar it covers", () => {
    assert.equal(overlayHeightFor(true), COMPUTER_OVERLAY_HEIGHT_PX);
    assert.equal(overlayHeightFor(false), TITLE_BAR_OVERLAY_HEIGHT_PX);
  });
});

describe("a colour laid over another", () => {
  it("is the overlap of the two at that alpha", () => {
    assert.equal(blendOver([255, 0, 0], 0.5, "#000000"), "#800000");
    assert.equal(blendOver([0, 0, 0], 0.5, "#FFFFFF"), "#808080");
    assert.equal(blendOver([1, 2, 3], 1, "#123456"), "#010203", "all of the colour and none of the background");
  });

  it("reads a background it cannot use as a neutral dark", () => {
    assert.equal(blendOver([0, 0, 0], 0, "not-a-colour"), "#181818");
    assert.equal(blendOver([0, 0, 0], 0, "#12345"), "#181818");
    assert.equal(blendOver([0, 0, 0], 0, "#0A0B0C"), "#0A0B0C");
  });
});

describe("the title bar's own tone", () => {
  it("keeps the window's background when it is not drawing one", () => {
    assert.equal(overlayBackgroundFor("#0A0B0C", false), "#0A0B0C");
  });

  it("darkens it twice over when it is", () => {
    const darkened = overlayBackgroundFor("#0A0B0C", true);
    assert.match(darkened, /^#[0-9A-F]{6}$/);
    assert.notEqual(darkened, "#0A0B0C");
    const red = darkened.slice(1, 3) ?? "";
    assert.equal(Number.parseInt(red, 16) <= 0x0a, true);
  });

  it("draws its symbols light on a dark background and dark on a light one", () => {
    assert.equal(overlaySymbolColorFor("#0A0B0C"), "#FFFFFF");
    assert.equal(overlaySymbolColorFor("#FFFFFF"), "#000000");
    assert.equal(overlaySymbolColorFor("#777777"), "#FFFFFF", "a colour at the threshold reads as dark");
    assert.equal(overlaySymbolColorFor("bad"), "#FFFFFF", "an unreadable colour is read as the assumed dark");
  });
});
