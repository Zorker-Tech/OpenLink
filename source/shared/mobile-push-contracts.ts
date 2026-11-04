export interface MobilePushInput {
  readonly agentId: string
  readonly agentName: string
  readonly messagePreview?: string
  readonly lastMessageId?: string
  readonly awaitingUserResponse: boolean
}
