/** Public avatar filename, path-containment and validated-reading helpers. */
export {
  AVATAR_MAX_BYTES,
  CANONICAL_AVATAR_FILENAME,
  CONVENTIONAL_AVATAR_EXTENSIONS,
} from "./agent-avatar-contracts.ts";
export {
  conventionalAvatarRank,
  isConventionalAvatarFilename,
  listConventionalAvatarFilenames,
  resolveAvatarPathWithinDir,
  resolveDerivedAvatarFilename,
} from "./agent-avatar-paths.ts";
export { sniffAvatarMimeType } from "./agent-avatar-format.ts";
export {
  invalidateAvatarDataUrlCache,
  readAvatarBytesWithinDir,
  readAvatarWithinDir,
  readValidatedAvatar,
} from "./agent-avatar-reading.ts";
