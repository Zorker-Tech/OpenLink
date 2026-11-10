/** Layout rules kept for compatibility with existing workspace and browser-profile files. */

export const BROWSER_PROFILE_CACHE_EXCLUSIONS = [
  "home/box/chrome-profile/*/Cache",
  "home/box/chrome-profile/*/Code Cache",
  "home/box/chrome-profile/*/GPUCache",
  "home/box/chrome-profile/*/Service Worker/CacheStorage",
] as const;

export const REGENERABLE_WORKSPACE_PATH_PATTERNS = [
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
] as const;
