/** Binds the production transcript provider to the generated message identities persisted by the service. */

import {
  ConversationStep,
  ConversationTurnStructure,
  UserMessage,
} from "../proto/generated/agent/v1/agent_pb.ts"
import {
  createGeneratedTranscriptOccurrenceCodec,
} from "./transcript-occurrence-codec-adapter.ts"
import {
  createProductionTranscriptMirrorProvider,
  type CreateTranscriptMirror,
} from "../../../host/transcript/mirror/production-provider.ts"

export function createDefaultProductionTranscriptMirrorProvider(): CreateTranscriptMirror {
  return createProductionTranscriptMirrorProvider({
    codec: createGeneratedTranscriptOccurrenceCodec({
      ConversationTurnStructure,
      UserMessage,
      ConversationStep,
    }),
  })
}
