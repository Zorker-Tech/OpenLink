/** Slate-owned result shapes exposed by the web tools. */

export interface SlateWebSearchDocument {
  readonly url: string
  readonly title: string
  readonly text: string
}

export interface SlateWebSearchAnswer {
  readonly answer: string
  readonly documents: SlateWebSearchDocument[]
}

export type SlateWebFetchResult =
  | { readonly content: string }
  | { readonly error: string; readonly isTimeout?: boolean | undefined }
