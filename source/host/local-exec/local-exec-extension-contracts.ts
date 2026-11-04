export interface LocalExecExtensionHost {
  readonly events: {
    on(topic: string, listener: (payload: unknown) => void): () => void
  }
}
