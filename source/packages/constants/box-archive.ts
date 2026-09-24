/**
 * What a box archives, and what it refuses to walk.
 *
 * A box's persistent store is archived and restored across image changes, which is only practical if
 * caches and build output stay out of it: they are regenerable, and walking them turns a restore into
 * a minutes-long operation over a workspace that is mostly noise.
 */

/** Chrome's caches: per-profile, regenerated on demand, and large enough to dominate an archive. */
export const BOX_PERSIST_ARCHIVE_EXCLUDES = [
  "home/box/chrome-profile/*/Cache",
  "home/box/chrome-profile/*/Code Cache",
  "home/box/chrome-profile/*/GPUCache",
  "home/box/chrome-profile/*/Service Worker/CacheStorage",
] as const

/** A workspace file listing extra paths to ignore, next to the ones below. */
export const WORKSPACE_IGNORE_FILE_NAME = ".slateignore"

export const BOX_WORKSPACE_DEFAULT_IGNORE_PATTERNS = [
  "node_modules/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".parcel-cache/",
  ".cache/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  ".venv/",
  "venv/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  ".ipynb_checkpoints/",
  "*.egg-info/",
  ".eggs/",
  "target/",
  ".gradle/",
  "core.[0-9]*",
  "*.core",
] as const
