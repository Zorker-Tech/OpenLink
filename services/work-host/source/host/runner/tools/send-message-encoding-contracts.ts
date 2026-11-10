export type EncodableMessage = Readonly<Record<string, unknown>> & { readonly type: string };

export interface BoxMediaAttachmentRequest {
  readonly boxPath: string;
  readonly remoteBoxHasDesktop: boolean;
  readonly download: (path: string) => Promise<Uint8Array | null>;
  readonly persistImage?: (bytes: Uint8Array, mime: string) => Promise<{ fileUrl: string } | null>;
  readonly persistMediaBytes?: (name: string, bytes: Uint8Array) => Promise<string | null>;
}
