import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientSideToolV2Call, ClientSideToolV2Result } from "../../source/packages/proto/generated/aiserver/v1/tools_pb.ts";
import {
  CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT, CLIENT_SIDE_TOOL_V2_FAMILY, CLIENT_SIDE_TOOL_V2_WIRE_VERSION,
  encodeClientSideToolV2Message, decodeClientSideToolV2Message, parseClientSideToolV2TransportEvent,
  materializeClientSideToolV2RendererEvent,
} from "../../source/shared/rpc/client-side-tool-v2-transport.ts";

const call = new ClientSideToolV2Call({ toolCallId: "call-1", name: "test", rawArgs: "{}" });
const update = (message=encodeClientSideToolV2Message("call",call)) => ({version:1,kind:"call",accountSlot:"host",agentId:"agent",epoch:"epoch",sequence:1,message});

test("wire identity constants and generated protobuf round-trip remain stable", () => {
  assert.equal(CLIENT_SIDE_TOOL_V2_FAMILY,"client-side-tool-v2"); assert.equal(CLIENT_SIDE_TOOL_V2_WIRE_VERSION,1); assert.equal(CLIENT_SIDE_TOOL_V2_ACCOUNT_SLOT,"host");
  const encoded=encodeClientSideToolV2Message("call",call); assert.equal(encoded.encoding,"protobuf-base64"); assert.equal(encoded.messageType,"aiserver.v1.ClientSideToolV2Call"); assert.deepEqual(decodeClientSideToolV2Message("call",encoded),call);
  const result=new ClientSideToolV2Result({toolCallId:"result-1"}); const resultBytes=encodeClientSideToolV2Message("result",result); assert.deepEqual(decodeClientSideToolV2Message("result",resultBytes),result);
});

test("decoding refuses malformed envelope, encoding, type, base64 and empty call id", () => {
  const valid=encodeClientSideToolV2Message("call",call);
  for (const value of [null,[],{}, {...valid,encoding:"protobuf"},{...valid,messageType:"wrong"},{...valid,bytes:""},{...valid,bytes:"GgFh====!!!!"},{...valid,bytes:"YQ== "},{...valid,bytes:"YR=="},{...valid,bytes:"AA=="}]) assert.equal(decodeClientSideToolV2Message("call",value),null);
  const emptyCall=new ClientSideToolV2Call({name:"test"});
  assert.equal(decodeClientSideToolV2Message("call",encodeClientSideToolV2Message("call",emptyCall)),null);
  const padded={encoding:"protobuf-base64",messageType:"aiserver.v1.ClientSideToolV2Call",bytes:"GgFh=="};
  assert.equal(decodeClientSideToolV2Message("call",padded),null);
  const nonCanonicalBits={...padded,bytes:"YR=="};
  assert.equal(decodeClientSideToolV2Message("call",nonCanonicalBits),null);
  const invalidCanonical={...padded,bytes:"YR=="};
  assert.equal(decodeClientSideToolV2Message("call",invalidCanonical),null);
  const omittedPadding={...padded,bytes:"GgFi=="};
  assert.equal(decodeClientSideToolV2Message("call",omittedPadding),null);
  assert.equal(decodeClientSideToolV2Message("result",valid),null);
});

test("transport parser validates its envelope and accepts reset or valid updates", () => {
  const parsed=parseClientSideToolV2TransportEvent(update()); assert.equal(parsed?.kind,"call");
  const arrayEnvelope=Object.assign([], { version: 1, kind: "reset", accountSlot: "host", agentId: "agent", epoch: "epoch", sequence: 1 });
  assert.equal(parseClientSideToolV2TransportEvent(arrayEnvelope),null);
  const decoderArray = Object.assign([], { encoding: "protobuf-base64", messageType: "aiserver.v1.ClientSideToolV2Call", bytes: "GgFh" });
  assert.equal(decodeClientSideToolV2Message("call", decoderArray), null);
  assert.equal(decodeClientSideToolV2Message("call", Object.create({encoding:"protobuf-base64",messageType:"aiserver.v1.ClientSideToolV2Call",bytes:"GgFh=="})), null);
  const reset={version:1,kind:"reset",accountSlot:"host",agentId:"agent",epoch:"epoch",sequence:3}; assert.deepEqual(parseClientSideToolV2TransportEvent(reset),reset);
  assert.deepEqual(parseClientSideToolV2TransportEvent({...reset, ignored: true}),reset);
  for (const value of [null, [], Object.assign([], { ...reset, kind: "call", message: {} }, { version: 2 }), [1,"reset","host","agent","epoch",3], {...reset,version:2}, {...reset,accountSlot:""}, {...reset,agentId:""}, {...reset,epoch:""}, {...reset,sequence:0}, {...reset,sequence:1.5}, {...reset,sequence:Number.MAX_SAFE_INTEGER+1}, {...reset,kind:"other"}, {...reset,kind:"call",message:{}}, {...update(),message:{...encodeClientSideToolV2Message("call",call),bytes:"bad"}}]) assert.equal(parseClientSideToolV2TransportEvent(value),null);
});

test("renderer materialization decodes bytes and leaves resets alone", () => {
  const transport=update(); const materialized=materializeClientSideToolV2RendererEvent(transport); assert.equal(materialized?.kind,"call"); if (materialized?.kind==="call") { assert.equal(materialized.message.encoding,"protobuf"); assert.deepEqual(materialized.message.bytes,Buffer.from(transport.message.bytes,"base64")); }
  const reset={version:1,kind:"reset",accountSlot:"host",agentId:"agent",epoch:"epoch",sequence:2}; assert.deepEqual(materializeClientSideToolV2RendererEvent(reset),reset); assert.equal(materializeClientSideToolV2RendererEvent({bad:true}),null);
});
