export interface TokenEstimateMessage {
  readonly content: unknown
  readonly [key: string]: unknown
}

export interface TokenEstimateOptions {
  readonly includeNonTextContent?: boolean
  readonly textContentLengthFn?: (message: TokenEstimateMessage) => number
}

export interface TokenEstimatePart {
  readonly type?: unknown
  readonly text?: unknown
  readonly args?: unknown
  readonly result?: unknown
  readonly data?: unknown
}
