export interface InlineImage {
  readonly base64: string;
  readonly mediaType: string;
  readonly alt?: string;
}

export interface TurnMessage {
  readonly speakerKind: "agent" | "human";
  readonly speakerName: string;
  readonly isSelf?: true;
  readonly text: string;
}

export type MirrorEntry =
  | {
      readonly kind: "human-message";
      readonly entryId: string;
      readonly authorAuthId: string;
      readonly authorName: string;
      readonly authorAvatarUrl?: string;
      readonly text: string;
      readonly images: InlineImage[];
      readonly clientNonce?: string;
      readonly timestampMs: number;
    }
  | {
      readonly kind: "agent-message";
      readonly entryId: string;
      readonly agentOwnerAuthId: string;
      readonly agentId: string;
      readonly authorName: string;
      readonly text: string;
      readonly images: InlineImage[];
      readonly timestampMs: number;
    };
