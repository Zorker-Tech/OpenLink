export interface SharedRoomTurnMessage {
  speakerKind: "human" | "agent"
  speakerName: string
  text: string
  isSelf?: true
}
