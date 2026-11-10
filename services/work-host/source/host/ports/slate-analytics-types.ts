/** The bucket a message's length is reported in, so lengths are grouped rather than counted one by one. */

/** The bucket a message's length is counted in. */
export type SlateMessageLengthBucket = "empty" | "xs" | "s" | "m" | "l" | "xl";

/** The buckets above "empty", by the length each starts below; a length beyond the last is "xl". */
const BUCKET_BOUNDS: ReadonlyArray<readonly [exclusiveBound: number, bucket: SlateMessageLengthBucket]> = [
  [20, "xs"],
  [100, "s"],
  [500, "m"],
  [2_000, "l"],
];

/** The bucket a message length is counted in. */
export function slateMessageLengthBucket(length: number): SlateMessageLengthBucket {
  if (length <= 0) return "empty";
  for (const [exclusiveBound, bucket] of BUCKET_BOUNDS) {
    if (length < exclusiveBound) return bucket;
  }
  return "xl";
}
