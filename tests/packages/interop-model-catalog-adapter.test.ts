import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { AvailableModelsResponse } from "../../source/adapters/interop/proto/generated/aiserver/v1/aiserver_pb.ts"
import {
  projectAvailableModel,
  projectAvailableModels,
} from "../../source/adapters/interop/agent/model-catalog-adapter.ts"

type InteropModel = AvailableModelsResponse["models"][number]

const remoteModel = {
  name: "slate-pro",
  clientDisplayName: "  Slate Pro  ",
  idAliases: ["pro"],
  parameterDefinitions: [
    { id: "tier", name: " Tier ", parameterType: { enumParameter: { values: [{ value: "fast", displayName: " Fast " }, { value: "deep" }] } } },
    { id: "thinking", name: "", parameterType: { booleanParameter: { values: [{ value: "on" }] } } },
    { id: "empty", name: "No values", parameterType: { enumParameter: { values: [] } } },
  ],
  variants: [{ parameterValues: [{ id: "tier", value: "fast" }] }],
} as unknown as InteropModel

describe("the model catalog interop adapter", () => {
  it("projects selectable values into Slate's catalog model", () => {
    assert.deepEqual(projectAvailableModel(remoteModel), {
      id: "slate-pro",
      displayName: "Slate Pro",
      aliases: ["pro"],
      params: [
        { id: "tier", name: "Tier", type: "enum", values: [{ value: "fast", displayName: "Fast" }, { value: "deep" }] },
        { id: "thinking", type: "boolean", values: [{ value: "on" }] },
      ],
      variants: [[{ id: "tier", value: "fast" }]],
    })
  })

  it("drops unnamed entries and blank display names", () => {
    assert.deepEqual(projectAvailableModels([remoteModel, { ...remoteModel, name: "  " } as InteropModel]).map(({ id }) => id), ["slate-pro"])
    assert.equal("displayName" in projectAvailableModel({ ...remoteModel, clientDisplayName: "  " } as InteropModel), false)
  })
})
