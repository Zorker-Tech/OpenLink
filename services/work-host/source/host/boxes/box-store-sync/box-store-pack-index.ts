/** Versioned index and retired-pack records stored beside the packed objects. */
import { z } from "zod";

export const BOX_STORE_PACKS_PREFIX = "packs";
export const BOX_STORE_PACK_INDEX_KEY = `${BOX_STORE_PACKS_PREFIX}/index.json`;
export const BOX_STORE_PACK_RETIRED_KEY = `${BOX_STORE_PACKS_PREFIX}/retired.json`;
export const PACK_INDEX_VERSION = 1;
export const PACK_RETIRED_VERSION = 1;
export const PACK_MEMBER_MAX_BYTES = 8 * 1024 * 1024;
export const PACK_MAX_MEMBER_SIZE_SUM = 256 * 1024 * 1024;
export const PACK_MEMBER_CLEN_BOUND = (size: number): number => size + 4_096 + Math.ceil(size / 512);
export const PACK_OBJECT_MAX_BYTES = 320 * 1024 * 1024;
export const PACK_INDEX_MAX_BYTES = 64 * 1024 * 1024;

export const packMemberSchema = z.object({
  sha: z.string().min(1),
  size: z.number().int().nonnegative().max(PACK_MEMBER_MAX_BYTES),
  offset: z.number().int().nonnegative(),
  clen: z.number().int().nonnegative(),
  vmtime: z.number().int().nonnegative(),
}).refine(member => member.clen <= PACK_MEMBER_CLEN_BOUND(member.size), {
  message: "member clen exceeds the gzip expansion bound for its size",
});

export const packEntrySchema = z.object({
  id: z.string().min(1),
  bytes: z.number().int().nonnegative().max(PACK_OBJECT_MAX_BYTES),
  members: z.array(packMemberSchema),
}).superRefine((pack, context) => {
  let expandedBytes = 0;
  for (const member of pack.members) {
    if (member.offset + member.clen > pack.bytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "member range exceeds the pack object size" });
      return;
    }
    expandedBytes += member.size;
  }
  if (expandedBytes > PACK_MAX_MEMBER_SIZE_SUM) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "member size sum exceeds the pack cap" });
  }
});

export const packIndexSchema = z.object({
  version: z.number().int(),
  maxVmtime: z.number().int().nonnegative(),
  packs: z.array(packEntrySchema),
});

const packRetiredSchema = z.object({ version: z.number().int(), retired: z.array(z.string().min(1)) });

export type PackMember = z.infer<typeof packMemberSchema>;
export type PackEntry = z.infer<typeof packEntrySchema>;
export type PackIndex = z.infer<typeof packIndexSchema>;

function decodedJson(source: string): unknown | null {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

export function parsePackIndex(source: string): PackIndex | null {
  const result = packIndexSchema.safeParse(decodedJson(source));
  return result.success && result.data.version === PACK_INDEX_VERSION ? result.data : null;
}

export function serializePackIndex(index: PackIndex): string {
  return JSON.stringify(index);
}

export function parsePackRetired(source: string): string[] | null {
  const result = packRetiredSchema.safeParse(decodedJson(source));
  return result.success && result.data.version === PACK_RETIRED_VERSION ? result.data.retired : null;
}

export function serializePackRetired(retired: readonly string[]): string {
  return JSON.stringify({ version: PACK_RETIRED_VERSION, retired });
}
