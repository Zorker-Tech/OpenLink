import assert from "node:assert/strict"
import { test } from "node:test"

import type { CatalogModel } from "../../source/shared/agents/model-catalog.ts"
import { createSlateModelCatalogFetcher } from "../../source/host/cloud-agents/model-catalog-fetch.ts"

test("the host projects only catalog credentials into interop and preserves its result", async () => {
  const getAccessToken = async ({ backendUrl }: { readonly backendUrl: string }) => `token:${backendUrl}`
  const getMachineId = async () => "machine-7"
  const onRequestId = (_requestId: string) => {}
  const catalog: CatalogModel[] = [{ id: "slate-model", aliases: [], params: [], variants: [] }]
  const connections: Array<{
    readonly getAccessToken: typeof getAccessToken
    readonly getMachineId: typeof getMachineId
    readonly onRequestId?: typeof onRequestId
  }> = []
  const fetchFromInterop = async (connection: (typeof connections)[number]) => {
    connections.push(connection)
    return catalog
  }
  const fetchCatalog = createSlateModelCatalogFetcher(fetchFromInterop)
  const options = { getAccessToken, getMachineId, onRequestId, hostOnlyLabel: "never send" }

  const result = await fetchCatalog(options)

  assert.equal(result, catalog)
  assert.deepEqual(connections, [{ getAccessToken, getMachineId, onRequestId }])
  assert.equal(await connections[0]!.getAccessToken({ backendUrl: "https://backend.invalid" }), "token:https://backend.invalid")
  assert.equal(await connections[0]!.getMachineId(), "machine-7")
})

test("the interop connection omits an absent request-id observer", async () => {
  const getAccessToken = async () => "token"
  const getMachineId = async () => "machine"
  let connection: object | undefined
  const fetchCatalog = createSlateModelCatalogFetcher(async value => {
    connection = value
    return []
  })

  await fetchCatalog({ getAccessToken, getMachineId })

  assert.deepEqual(connection, { getAccessToken, getMachineId })
  assert.equal(Object.hasOwn(connection!, "onRequestId"), false)
})
