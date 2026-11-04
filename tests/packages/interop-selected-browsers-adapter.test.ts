import assert from "node:assert/strict"
import test from "node:test"

import { SelectedBrowser } from "../../source/adapters/interop/proto/generated/agent/v1/selected_context_pb.ts"
import { toBrowserTabPromptInputs } from "../../source/adapters/interop/agent/selected-browsers-adapter.ts"

test("selected browser messages become ordered tab references", () => {
  assert.deepEqual(toBrowserTabPromptInputs([
    new SelectedBrowser({ pageTitle: "Project", url: "https://app.example", browserId: "tab-1" }),
    new SelectedBrowser({ url: "https://docs.example", browserId: "tab-2" }),
  ]), [
    { pageTitle: "Project", url: "https://app.example", browserId: "tab-1" },
    { url: "https://docs.example", browserId: "tab-2" },
  ])
})
