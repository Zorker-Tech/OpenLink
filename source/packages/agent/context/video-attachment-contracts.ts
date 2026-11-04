export type SlateVideoContent =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "blob"; readonly blobId: Uint8Array }
  | { readonly kind: "blob-with-bytes"; readonly blobId: Uint8Array; readonly bytes: Uint8Array }
  | {
      readonly kind: "signed-link";
      readonly url: string;
      readonly key?: string | undefined;
      readonly expiresAtUnixMs?: bigint | undefined;
      readonly refreshAfterUnixMs?: bigint | undefined;
      readonly conversationId: string;
    }
  | { readonly kind: "empty" };

/** The video information Slate's context pipeline needs, without its storage message shape. */
export interface SlateVideoAttachment {
  readonly sourcePath: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly frameRate?: number | undefined;
  readonly writeToWorkspace: boolean;
  readonly content: SlateVideoContent;
}
