import assert from "node:assert/strict"
import test from "node:test"

import { SelectedUIElement } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { toSelectedUIElementInputs } from "../../source/adapters/interop/agent/selected-ui-elements-adapter.ts"

test("counterpart UI elements become ordered Slate inputs with only rendered fields", () => {
  assert.deepEqual(toSelectedUIElementInputs([
    new SelectedUIElement({
      component: "Button",
      componentPropsJson: '{"label":"Run"}',
      xpath: "/html/body/button",
      extra: "ignored by the prompt renderer",
    }),
    new SelectedUIElement({
      element: "<div>status</div>",
      xpath: "/html/body/div",
      textContent: "ready",
    }),
  ]), [
    {
      element: "",
      xpath: "/html/body/button",
      textContent: "",
      component: "Button",
      componentPropsJson: '{"label":"Run"}',
    },
    {
      element: "<div>status</div>",
      xpath: "/html/body/div",
      textContent: "ready",
    },
  ])
})
