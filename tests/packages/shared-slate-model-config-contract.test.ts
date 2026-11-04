import assert from "node:assert/strict"
import { test } from "node:test"

import {
  MAX_MODEL_ID_LENGTH,
  MAX_PARAMETER_VALUE_LENGTH,
  MAX_PARAMETERS,
  ROUTED_MODEL_IDS,
  resolveSlateDefaultModelConfig,
} from "../../source/shared/node/experiments/slate-model-config.ts"

const config = (overrides: Record<string, unknown> = {}) => ({
  modelId: "slate-model",
  maxMode: false,
  parameters: [],
  ...overrides,
})

test("identity hydration is checked before the model configuration is read", () => {
  let reads = 0
  const input = {
    hasHydratedExperimentUser: false,
    get raw() { reads += 1; return config() },
  }

  assert.deepEqual(resolveSlateDefaultModelConfig(input), { rejection: "identity_unhydrated" })
  assert.equal(reads, 0)
})

test("malformed records, parameter rows and model identifiers are refused with distinct reasons", () => {
  const ready = { hasHydratedExperimentUser: true }
  for (const raw of [null, [], "model", 7, config({ modelId: 1 }), config({ maxMode: "yes" }), config({ parameters: {} }), config({ parameters: [null] }), config({ parameters: [{ id: "", value: "v" }] }), config({ parameters: [{ id: "x", value: 1 }] })]) {
    assert.equal(resolveSlateDefaultModelConfig({ ...ready, raw }).rejection, "malformed")
  }
  assert.equal(resolveSlateDefaultModelConfig({ ...ready, raw: config({ modelId: "a b" }) }).rejection, "invalid_model_id")
  assert.equal(resolveSlateDefaultModelConfig({ ...ready, raw: config({ modelId: `model-${"x".repeat(MAX_MODEL_ID_LENGTH)}` }) }).rejection, "invalid_model_id")
})

test("parameter counts and values are bounded, and duplicate names are reported separately", () => {
  const ready = { hasHydratedExperimentUser: true }
  assert.equal(MAX_PARAMETERS, 16)
  assert.equal(MAX_PARAMETER_VALUE_LENGTH, 64)
  assert.equal(resolveSlateDefaultModelConfig({
    ...ready,
    raw: config({ parameters: Array.from({ length: MAX_PARAMETERS + 1 }, (_, index) => ({ id: `p-${index}`, value: "v" })) }),
  }).rejection, "parameters_out_of_bounds")
  assert.equal(resolveSlateDefaultModelConfig({
    ...ready,
    raw: config({ parameters: [{ id: "p", value: "v".repeat(MAX_PARAMETER_VALUE_LENGTH + 1) }] }),
  }).rejection, "parameters_out_of_bounds")
  assert.equal(resolveSlateDefaultModelConfig({
    ...ready,
    raw: config({ parameters: [{ id: "p", value: "first" }, { id: "p", value: "second" }] }),
  }).rejection, "duplicate_parameter")
})

test("routed models cannot carry their own execution settings while empty config stays absent", () => {
  const ready = { hasHydratedExperimentUser: true }
  const routed = [...ROUTED_MODEL_IDS][0]!
  assert.equal(resolveSlateDefaultModelConfig({ ...ready, raw: config({ modelId: routed, maxMode: true }) }).rejection, "routed_model_parameters")
  assert.equal(resolveSlateDefaultModelConfig({ ...ready, raw: config({ modelId: routed, parameters: [{ id: "effort", value: "high" }] }) }).rejection, "routed_model_parameters")
  assert.equal(resolveSlateDefaultModelConfig({ ...ready, raw: config({ modelId: routed }) }).selection?.modelId, routed)
  assert.deepEqual(resolveSlateDefaultModelConfig({ ...ready, raw: config({ modelId: "" }) }), {})
})
