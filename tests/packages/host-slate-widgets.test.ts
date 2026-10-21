import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getWidgetAnswerLabel,
  slateWidgetSchema,
  summarizeWidget,
  widgetActionStyleSchema,
} from "../../source/shared/slate-widgets.ts";

/** A choice a widget offers. */
const option = (fields: Record<string, unknown> = {}) => ({ label: "Yes", ...fields });

/** Whether the schema takes this widget, and what it says when it does not. */
const checked = (widget: unknown) => {
  const result = slateWidgetSchema.safeParse(widget);
  return result.success ? { accepted: true as const, value: result.data } : { accepted: false as const, paths: result.error.issues.map((issue) => issue.path.join(".")) };
};

describe("the widget a message may carry", () => {
  it("is a question with between one and six choices", () => {
    assert.equal(checked({ prompt: "Ship it?", options: [option()] }).accepted, true);
    assert.equal(checked({ prompt: "Ship it?", options: Array.from({ length: 6 }, () => option()) }).accepted, true);
    assert.deepEqual(checked({ prompt: "Ship it?", options: Array.from({ length: 7 }, () => option()) }), { accepted: false, paths: ["options"] });
    assert.deepEqual(checked({ prompt: "Ship it?", options: [] }), { accepted: false, paths: ["options"] });
  });

  it("refuses a question with nothing in it, before or after trimming", () => {
    assert.deepEqual(checked({ prompt: "", options: [option()] }), { accepted: false, paths: ["prompt"] });
    assert.deepEqual(checked({ prompt: "   ", options: [option()] }), { accepted: false, paths: ["prompt"] });
    assert.deepEqual(checked({ options: [option()] }), { accepted: false, paths: ["prompt"] });
  });

  it("trims the question and the choices it accepts", () => {
    const result = checked({ prompt: "  Ship it?  ", options: [option({ label: "  Yes  ", value: "  y  " })] });
    assert.equal(result.accepted, true);
    if (!result.accepted) return;
    assert.equal(result.value.prompt, "Ship it?");
    assert.equal(result.value.options[0]?.label, "Yes");
    assert.equal(result.value.options[0]?.value, "y");
  });

  it("refuses a choice with an empty label, and takes one with no value at all", () => {
    assert.deepEqual(checked({ prompt: "Q", options: [option({ label: "  " })] }), { accepted: false, paths: ["options.0.label"] });
    assert.equal(checked({ prompt: "Q", options: [option({ value: undefined })] }).accepted, true);
    assert.deepEqual(checked({ prompt: "Q", options: [option({ value: "" })] }), { accepted: false, paths: ["options.0.value"] });
  });

  it("takes one of the three styles, and refuses any other", () => {
    assert.deepEqual(widgetActionStyleSchema.options, ["default", "primary", "danger"]);
    for (const style of ["default", "primary", "danger"]) assert.equal(checked({ prompt: "Q", options: [option({ style })] }).accepted, true, style);
    assert.deepEqual(checked({ prompt: "Q", options: [option({ style: "loud" })] }), { accepted: false, paths: ["options.0.style"] });
  });

  it("takes the two switches only as booleans", () => {
    assert.equal(checked({ prompt: "Q", options: [option()], allowCustom: true }).accepted, true);
    assert.deepEqual(checked({ prompt: "Q", options: [option()], allowCustom: "yes" }), { accepted: false, paths: ["allowCustom"] });
    assert.equal(checked({ prompt: "Q", options: [option()], dismissOnMoveOn: false }).accepted, true);
    assert.deepEqual(checked({ prompt: "Q", options: [option()], dismissOnMoveOn: "later" }), { accepted: false, paths: ["dismissOnMoveOn"] });
  });

  it("refuses help text with nothing in it", () => {
    assert.deepEqual(checked({ prompt: "Q", options: [option()], helpText: "" }), { accepted: false, paths: ["helpText"] });
    assert.deepEqual(checked({ prompt: "Q", options: [option()], helpText: "   " }), { accepted: false, paths: ["helpText"] });
    assert.equal(checked({ prompt: "Q", options: [option()], helpText: "some help" }).accepted, true);
  });

  it("leaves out fields it was not given, and keeps what it does not know nothing about", () => {
    const result = checked({ prompt: "Q", options: [option()], extra: "ignored" });
    assert.equal(result.accepted, true);
    if (!result.accepted) return;
    assert.equal("allowCustom" in result.value, false);
    assert.equal("helpText" in result.value, false);
    assert.equal("extra" in result.value, false);
  });
});

describe("a widget in one line", () => {
  it("is the question with the labels it offers beside it", () => {
    assert.equal(summarizeWidget({ prompt: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }), "Ship it? — Yes / No");
  });

  it("is the question alone when it offers nothing to name", () => {
    assert.equal(summarizeWidget({ prompt: "Ship it?" }), "Ship it?");
    assert.equal(summarizeWidget({ prompt: "Ship it?", options: [] }), "Ship it?");
    assert.equal(summarizeWidget({ options: [{ label: "Yes" }] }), "Question — Yes", "a widget with no question is still a question");
    assert.equal(summarizeWidget({ prompt: 5, options: [] }), "Question");
  });

  it("reads a widget whose options are not a list as offering nothing at all", () => {
    // Even when the widget carries a stray label of its own, it is the options that name the choices.
    assert.equal(summarizeWidget({ prompt: "Q", options: "not a list", label: "stray" } as never), "Q");
  });

  it("joins whatever the options carry, even when that is nothing", () => {
    assert.equal(summarizeWidget({ prompt: "Q", options: [{}, {}] }), "Q —  / ");
  });
});

describe("the label an answer came from", () => {
  it("is the label of the choice whose value was sent", () => {
    assert.equal(getWidgetAnswerLabel({ options: [{ label: "Yes, ship", value: "yes" }] }, "yes"), "Yes, ship");
  });

  it("is the label of the choice whose label was sent, when it carries no value", () => {
    assert.equal(getWidgetAnswerLabel({ options: [{ label: "Yes" }] }, "Yes"), "Yes");
    assert.equal(getWidgetAnswerLabel({ options: [{ label: "Yes", value: undefined }] }, "Yes"), "Yes");
  });

  it("is the answer itself when no choice matches", () => {
    assert.equal(getWidgetAnswerLabel({ options: [{ label: "Yes", value: "yes" }] }, "something else"), "something else");
    assert.equal(getWidgetAnswerLabel({}, "typed by hand"), "typed by hand");
    assert.equal(getWidgetAnswerLabel({ options: "not a list" }, "typed"), "typed");
    assert.equal(getWidgetAnswerLabel({ options: "not a list", label: "stray" } as never, "stray"), "stray");
  });
});
