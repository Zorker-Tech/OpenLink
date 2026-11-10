/** Disposable cache locations assigned to shared-build sandbox commands. */
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SANDBOX_CACHE_DIR = "slate-sandbox-cache"
let sessionId: string | undefined

function currentSessionId(): string {
  sessionId ??= randomBytes(16).toString("hex")
  return sessionId
}

export function getSandboxCacheEnv(): Record<string, string> {
  const root = join(tmpdir(), SANDBOX_CACHE_DIR, currentSessionId())
  return {
    NPM_CONFIG_CACHE: join(root, "npm"),
    PNPM_STORE_PATH: join(root, "pnpm-store"),
    GOCACHE: join(root, "go-build"),
    GOMODCACHE: join(root, "go-mod"),
    CARGO_TARGET_DIR: join(root, "cargo-target"),
    PIP_CACHE_DIR: join(root, "pip"),
    UV_CACHE_DIR: join(root, "uv"),
    BUN_INSTALL_CACHE_DIR: join(root, "bun"),
    YARN_CACHE_FOLDER: join(root, "yarn"),
    npm_config_devdir: join(root, "node-gyp"),
    PLAYWRIGHT_BROWSERS_PATH: join(root, "playwright"),
    PUPPETEER_CACHE_DIR: join(root, "puppeteer"),
    TURBO_CACHE_DIR: join(root, "turbo"),
    GRADLE_USER_HOME: join(root, "gradle"),
    CONDA_PKGS_DIRS: join(root, "conda"),
    POETRY_CACHE_DIR: join(root, "poetry"),
    GEM_SPEC_CACHE: join(root, "gem-specs"),
    BUNDLE_PATH: join(root, "bundle"),
    COMPOSER_HOME: join(root, "composer"),
    HOMEBREW_CACHE: join(root, "homebrew"),
    CYPRESS_CACHE_FOLDER: join(root, "cypress"),
    NX_CACHE_DIRECTORY: join(root, "nx"),
    NUGET_PACKAGES: join(root, "nuget"),
    CCACHE_DIR: join(root, "ccache"),
    CP_HOME_DIR: join(root, "cocoapods"),
  }
}
