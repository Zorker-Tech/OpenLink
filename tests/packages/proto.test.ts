import { test } from "node:test"
import assert from "node:assert/strict"
import { MethodKind } from "@bufbuild/protobuf"

import { BlobData, BlobType, ImageBlobData } from "../../source/adapters/interop/proto/generated/internapi/v1/blob_pb.ts"
import { InferenceService } from "../../source/adapters/interop/proto/generated/aiserver/v1/inference_connect.ts"
import { AgentService } from "../../source/adapters/interop/proto/generated/agent/v1/agent_service_connect.ts"
import { AllowedDomain } from "../../source/adapters/interop/proto/generated/anyrun/v1/common_pb.ts"
import { PodErrorEvent } from "../../source/adapters/interop/proto/generated/anyrun/v1/pod_event_pb.ts"
import { ClientSideToolV2Call } from "../../source/adapters/interop/proto/generated/aiserver/v1/tools_pb.ts"
import { WriteShellStdinArgs } from "../../source/adapters/interop/proto/generated/agent/v1/background_shell_exec_pb.ts"

test("generated messages carry the wire name the peer service knows them by", () => {
  assert.equal(BlobData.typeName, "internapi.v1.BlobData")
  assert.equal(ImageBlobData.typeName, "internapi.v1.ImageBlobData")
  assert.equal(AllowedDomain.typeName, "anyrun.v1.AllowedDomain")
  assert.equal(PodErrorEvent.typeName, "anyrun.v1.PodErrorEvent")
})

test("field numbers, kinds and labels are the declared contract", () => {
  const fields = BlobData.fields.list()
  assert.deepEqual(
    fields.map(field => ({ no: field.no, name: field.name, kind: field.kind })),
    [
      { no: 1, name: "blob_type", kind: "enum" },
      { no: 2, name: "blob_id", kind: "scalar" },
      { no: 3, name: "index", kind: "scalar" },
      { no: 4, name: "image_data", kind: "message" },
    ],
  )
  const oneofMember = fields.find(field => field.name === "image_data")
  assert.equal(typeof oneofMember?.oneof === "object" ? oneofMember.oneof.name : undefined, "type_specific_data")
  const blobId = fields.find(field => field.name === "blob_id") as { T?: unknown } | undefined
  assert.equal(blobId?.T, 12, "bytes")

  const repeated = AllowedDomain.fields.list()
  assert.equal(repeated.length, 1, "a message declares only the fields the schema gives it")
})

test("enum wire values are the schema's, not the TypeScript names", () => {
  assert.equal(BlobType.UNSPECIFIED, 0)
  assert.equal(BlobType.VIDEO, 10)
  const values = Object.entries(BlobType).filter(([key]) => Number.isNaN(Number(key)))
  assert.equal(values.length, 11)
  assert.equal(BlobType[BlobType.IMAGE], "IMAGE")
})

test("a message round-trips through binary and JSON", () => {
  const original = new BlobData({
    blobType: BlobType.IMAGE,
    blobId: new Uint8Array([1, 2, 3]),
    index: 7,
    typeSpecificData: { case: "imageData", value: new ImageBlobData({ mimeType: "image/png" }) },
  })

  const decoded = BlobData.fromBinary(original.toBinary())
  assert.equal(decoded.blobType, BlobType.IMAGE)
  assert.deepEqual([...decoded.blobId], [1, 2, 3])
  assert.equal(decoded.index, 7)
  assert.equal(decoded.typeSpecificData.case, "imageData")
  assert.equal(
    decoded.typeSpecificData.case === "imageData" ? decoded.typeSpecificData.value.mimeType : undefined,
    "image/png",
  )

  const fromJson = BlobData.fromJsonString(original.toJsonString())
  assert.deepEqual(fromJson.toJson(), original.toJson())
  assert.deepEqual(BlobData.fromJsonString(original.toJsonString()).toBinary(), original.toBinary())
})

test("a oneof only carries one case at a time", () => {
  const empty = new BlobData()
  assert.equal(empty.typeSpecificData.case, undefined)
  const withImage = new BlobData({ typeSpecificData: { case: "imageData", value: new ImageBlobData() } })
  assert.equal(withImage.typeSpecificData.case, "imageData")
})

test("services are generated with their rpc names and streaming kinds", () => {
  assert.equal(InferenceService.typeName, "aiserver.v1.InferenceService")
  assert.equal(InferenceService.methods.stream?.name, "Stream")
  assert.equal(InferenceService.methods.stream?.kind, MethodKind.ServerStreaming)
  assert.equal(InferenceService.methods.recordAgentPostTurnLabeling?.kind, MethodKind.Unary)

  assert.equal(AgentService.typeName, "agent.v1.AgentService")
  const methodNames = Object.values(AgentService.methods).map(method => method.name)
  assert.ok(methodNames.length > 0)
  assert.equal(new Set(methodNames).size, methodNames.length, "rpc names are unique")
})

test("a type declared in another namespace is referenced, not copied", () => {
  const call = ClientSideToolV2Call.fields.list().find(field => field.name === "write_shell_stdin_params")
  assert.equal(call?.kind, "message")
  assert.equal(
    typeof call?.T === "function" ? call.T.typeName : undefined,
    "agent.v1.WriteShellStdinArgs",
    "an aiserver message points at the agent namespace's own type",
  )
  assert.equal(
    WriteShellStdinArgs.typeName,
    "agent.v1.WriteShellStdinArgs",
    "and that type is declared once, in its own namespace",
  )
})
