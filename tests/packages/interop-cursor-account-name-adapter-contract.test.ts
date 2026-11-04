import assert from "node:assert/strict"
import { test } from "node:test"

import {
  readAccountName,
  type GetMeClient,
} from "../../source/adapters/interop/cursor-backend/account-name-adapter.ts"
import {
  GetMeRequest,
  GetMeResponse,
} from "../../source/adapters/interop/proto/generated/aiserver/v1/dashboard_pb.ts"

test("the account adapter sends the counterpart request and returns a Slate-owned name shape", async () => {
  const factoryInputs: Array<{ accessToken: string; getMachineId: () => Promise<string> }> = []
  const requests: unknown[] = []
  const getMachineId = async () => "machine-5"
  const result = await readAccountName({
    accessToken: "access-token",
    getMachineId,
    timeoutMs: 73,
    createClient: (input) => {
      factoryInputs.push(input)
      const client: GetMeClient = {
        async getMe(request, options) {
          requests.push({ request, options })
          return new GetMeResponse({ firstName: "Ada", lastName: "Lovelace" })
        },
      }
      return client
    },
  })

  assert.equal(factoryInputs[0]?.accessToken, "access-token")
  assert.equal(factoryInputs[0]?.getMachineId, getMachineId)
  assert.equal(typeof await factoryInputs[0]?.getMachineId(), "string")
  assert.equal(requests.length, 1)
  const sent = requests[0] as { request: unknown; options: unknown }
  assert.equal(sent.request instanceof GetMeRequest, true)
  assert.deepEqual(sent.options, { timeoutMs: 73 })
  assert.deepEqual(result, { givenName: "Ada", familyName: "Lovelace" })
})
