/** The bucket a message's length is reported in, so lengths are grouped rather than counted one by one. */
export type SlateMessageLengthBucket = "empty" | "xs" | "s" | "m" | "l" | "xl";
export function slateMessageLengthBucket(length: number): SlateMessageLengthBucket { if (length <= 0) return "empty"; if (length < 20) return "xs"; if (length < 100) return "s"; if (length < 500) return "m"; if (length < 2_000) return "l"; return "xl"; }
