import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PointScaler } from "../../source/packages/local-exec/computer-use/scaling.ts";

const screens = { display: { width: 1920, height: 1080 }, api: { width: 1280, height: 720 } };

describe("a point between the display and the API", () => {
  it("is scaled up to the picture and down to the point", () => {
    const scaler = new PointScaler(screens);
    assert.deepEqual(scaler.toDisplay(10, 20), { x: 15, y: 30 });
    assert.deepEqual(scaler.toApi(150, 300), { x: 100, y: 200 });
    assert.deepEqual([scaler.apiWidth, scaler.apiHeight, scaler.displayWidth, scaler.displayHeight], [1280, 720, 1920, 1080]);
  });

  it("is rounded to the nearest pixel, halves and negatives included", () => {
    const scaler = new PointScaler({ display: { width: 1280, height: 720 }, api: { width: 1920, height: 1080 } });
    assert.deepEqual(scaler.toDisplay(1, 1), { x: 1, y: 1 }, "two thirds rounds down");
    assert.deepEqual(scaler.toDisplay(-3, -7), { x: -2, y: -5 });
    assert.deepEqual(scaler.toDisplay(3, 6), { x: 2, y: 4 });
  });

  it("scales each axis by its own ratio", () => {
    const scaler = new PointScaler({ display: { width: 1000, height: 1000 }, api: { width: 500, height: 500 } });
    assert.deepEqual(scaler.toDisplay(2, 3), { x: 4, y: 6 });
    const wider = new PointScaler({ display: { width: 2000, height: 1000 }, api: { width: 1000, height: 500 } });
    assert.deepEqual([wider.toDisplay(10, 10).x, wider.toDisplay(10, 10).y], [20, 20]);
  });

  it("scales x by x and y by y, even when the two ratios are nearly the same", () => {
    // A pair a fiftieth apart: the x ratio is 1.0105 and the y ratio is 1, which a big point makes visible.
    const scaler = new PointScaler({ display: { width: 1920, height: 1080 }, api: { width: 1900, height: 1080 } });
    assert.deepEqual(scaler.toDisplay(1000, 1000), { x: 1011, y: 1000 });
    assert.deepEqual(scaler.toApi(1000, 1000), { x: 990, y: 1000 });
  });

  it("round-trips a point that lands on a whole pixel", () => {
    const scaler = new PointScaler(screens);
    assert.deepEqual(scaler.toApi(scaler.toDisplay(100, 200).x, scaler.toDisplay(100, 200).y), { x: 100, y: 200 });
  });
});

describe("a pair of sizes that is not the same picture", () => {
  it("is refused rather than scaled into something wrong", () => {
    assert.throws(() => new PointScaler({ display: { width: 1920, height: 1080 }, api: { width: 1024, height: 768 } }), /Aspect ratio mismatch: display=1\.778, api=1\.333/);
  });

  it("is refused when the two are a tenth apart, even though they are nearly the same shape", () => {
    // 16:9 against 16:9.8 — a tenth of a ratio, well inside a fifth and far outside a fiftieth.
    assert.throws(() => new PointScaler({ display: { width: 1920, height: 1080 }, api: { width: 1920, height: 1188 } }), /Aspect ratio mismatch/);
  });

  it("is taken when the two are close enough to be the same picture", () => {
    assert.doesNotThrow(() => new PointScaler({ display: { width: 1920, height: 1080 }, api: { width: 1900, height: 1080 } }));
  });
});
