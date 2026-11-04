/** Binds production transcript derivation to Slate turn envelopes and remaining interop payload codecs. */

import { UserMessage } from "../proto/generated/agent/v1/agent_pb.ts"
import {
  createSlateTranscriptOccurrenceCodec,
} from "./transcript-occurrence-codec-adapter.ts"
import {
  createProductionTranscriptMirrorProvider,
  type CreateTranscriptMirror,
} from "../../../host/transcript/mirror/production-provider.ts"

export function createDefaultProductionTranscriptMirrorProvider(): CreateTranscriptMirror {
  return createProductionTranscriptMirrorProvider({
    codec: createSlateTranscriptOccurrenceCodec({
      UserMessage,
    }),
  })
}
