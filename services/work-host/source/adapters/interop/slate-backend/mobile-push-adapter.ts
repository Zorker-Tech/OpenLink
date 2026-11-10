import { SlateBotService } from "../proto/generated/aiserver/v1/slate_bot_connect.ts"
import { createSlateBackendClient } from "./slate-backend-client.ts"
import type { MobilePushInput } from "../../../shared/mobile-push-contracts.ts"

export interface MobilePushBackendRequest {
  readonly agentId: string
  readonly agentName: string
  readonly messagePreview: string
  readonly lastMessageId: string
  readonly awaitingUserResponse: boolean
}

export interface MobilePushBackendClient {
  notifySlateAgentTurnFinished(request: MobilePushBackendRequest): Promise<unknown>
}

export function toMobilePushBackendRequest(input: MobilePushInput): MobilePushBackendRequest {
  return {
    agentId: input.agentId,
    agentName: input.agentName,
    messagePreview: input.messagePreview ?? "",
    lastMessageId: input.lastMessageId ?? "",
    awaitingUserResponse: input.awaitingUserResponse,
  }
}

export function createSlateMobilePushSender(client: MobilePushBackendClient): (input: MobilePushInput) => Promise<void> {
  return async (input) => {
    await client.notifySlateAgentTurnFinished(toMobilePushBackendRequest(input))
  }
}

export function createSlateMobilePushAdapter(auth: {
  readonly getAccessToken: (options: { readonly backendUrl: string }) => Promise<string>
  readonly getMachineId: () => Promise<string>
}): (input: MobilePushInput) => Promise<void> {
  const client = createSlateBackendClient(SlateBotService, auth)
  return createSlateMobilePushSender(client as unknown as MobilePushBackendClient)
}
