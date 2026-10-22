/**
 * The shape of a box store's manifest, and how an older one is read.
 *
 * The manifest is a list of entries — a file with its size and mode, a symlink with its target, or a directory — and
 * the legacy version, which knew only files, is still readable: an entry that says a kind the old version never wrote
 * is read as what it meant then.
 */
import { z } from "zod";

export const BOX_STORE_MANIFEST_REL_PATH = "manifest.json";
export const BOX_STORE_BLOBS_PREFIX = "blobs";
export const BOX_STORE_LEGACY_MANIFEST_VERSION = 1;
export const BOX_STORE_MANIFEST_VERSION = 2;
export const SLATE_MANIFEST_V2_ENV = "SLATE_MANIFEST_V2";

/** The two kinds of entry a manifest names; an entry from the legacy version names neither. */
const MANIFEST_FILE_KIND = "file";
const MANIFEST_SYMLINK_KIND = "symlink";

/** A text that has to say something: the two strings an entry carries are both meaningful. */
const nonEmptyText = z.string().min(1);

/** A count that cannot be negative: a size, a timestamp, an append offset. */
const nonNegativeInteger = z.number().int().nonnegative();

/** A file mode: the permission bits, and nothing above them. */
const fileMode = z.number().int().min(0).max(0o777);

/** What identifies a file's bytes, whichever version of the manifest names them. */
const fileIdentityFields = { sha: nonEmptyText, size: nonNegativeInteger };

/** The fields every manifest header carries. */
const manifestHeaderFields = {
  updatedAtMs: nonNegativeInteger,
  writerWindowId: z.string().optional(),
  fullyHydrated: z.boolean().optional(),
};

/** An entry as the legacy version wrote it: no kind and no mode, because that version only knew files. */
export const legacyManifestFileEntrySchema = z.object({ ...fileIdentityFields, kind: z.undefined().optional(), mode: z.undefined().optional() });

/** A file entry: the bytes and the permission bits that name it on disk. */
export const manifestFileEntrySchema = z.object({ kind: z.literal(MANIFEST_FILE_KIND), ...fileIdentityFields, mode: fileMode });

/** A symlink entry: where the link points, as the target text. */
export const manifestSymlinkEntrySchema = z.object({ kind: z.literal(MANIFEST_SYMLINK_KIND), target: nonEmptyText });

/** Any entry, whichever shape it was written in; the order is the order they are tried. */
export const manifestEntrySchema = z.union([manifestFileEntrySchema, manifestSymlinkEntrySchema, legacyManifestFileEntrySchema]);

/** The document both manifest versions share: a version tag, the header, and entries keyed by path. */
function manifestDocument<Version extends number, Entry extends z.ZodTypeAny>(version: Version, entries: Entry) {
  return z.object({ version: z.literal(version), ...manifestHeaderFields, entries: z.record(z.string(), entries) });
}

export const legacyManifestSchema = manifestDocument(BOX_STORE_LEGACY_MANIFEST_VERSION, legacyManifestFileEntrySchema);
export const currentManifestSchema = manifestDocument(BOX_STORE_MANIFEST_VERSION, manifestEntrySchema);
export const manifestSchema = z.discriminatedUnion("version", [legacyManifestSchema, currentManifestSchema]);
export type BoxStoreManifestEntry = z.infer<typeof manifestEntrySchema>;

/** Whether an entry is a symlink; a legacy entry has no kind, so it is not one. */
export function isBoxStoreManifestSymlinkEntry(entry: BoxStoreManifestEntry): entry is z.infer<typeof manifestSymlinkEntrySchema> {
  return entry.kind === MANIFEST_SYMLINK_KIND;
}

/** Whether an entry is a file, which is also what every legacy entry meant. */
export function isBoxStoreManifestFileEntry(entry: BoxStoreManifestEntry): entry is Exclude<BoxStoreManifestEntry, { kind: "symlink" }> {
  return !isBoxStoreManifestSymlinkEntry(entry);
}

/** Whether two entries name the same thing: links by target, files by identity and mode. */
function entriesAgree(previous: BoxStoreManifestEntry, next: BoxStoreManifestEntry): boolean {
  if (isBoxStoreManifestSymlinkEntry(previous)) return isBoxStoreManifestSymlinkEntry(next) && previous.target === next.target;
  if (isBoxStoreManifestSymlinkEntry(next)) return false;
  return previous.sha === next.sha && previous.size === next.size && previous.kind === next.kind && previous.mode === next.mode;
}

export function boxStoreManifestEntriesEqual(
  previous: BoxStoreManifestEntry | null | undefined,
  next: BoxStoreManifestEntry | null | undefined,
): boolean {
  if (previous == null || next == null) return previous === next;
  return entriesAgree(previous, next);
}

/** Whether a stored value can be read as a symlink entry at all. */
export function isSymlinkManifestValue(value: unknown): boolean {
  return manifestSymlinkEntrySchema.safeParse(value).success;
}
