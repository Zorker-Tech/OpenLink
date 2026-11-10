/** The box-side trees and exclusions captured by the host store service. */
import { BROWSER_PROFILE_CACHE_EXCLUSIONS } from "../../../adapters/interop/box/workspace-archive-layout-adapter.ts";
import { BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES } from "../../durable-file-policy.ts";
import { BOX_STORE_HYDRATION_HANDOFF_FILE_NAME } from "./box-store-hydration.ts";
import { SLATE_MANIFEST_V2_ENV } from "./box-store-manifest-format.ts";
import {
  CHROME_AUTH_STATE_CACHE_EXCLUDE_NAMES,
  CHROME_AUTH_STATE_REL_DIRS,
  CHROME_SESSION_CATEGORY_NAME,
  CHROME_SESSION_DB_DIR,
  CHROME_SESSION_DB_NAMES,
  CHROME_SESSION_DB_REL_DIR,
  stageBoxChromeSession,
  type ChromeStageReport,
} from "./chrome-session-stage.ts";
import { compileWorkspaceIgnore, loadWorkspaceIgnore } from "./workspace-ignore.ts";
import {
  BOX_HOME_CATEGORY_NAME,
  BOX_HOME_DIR,
  BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES,
  BOX_HOME_REGENERABLE_JUNK_IGNORE_PATTERNS,
  BOX_HOME_REL_PREFIX,
  SLATE_STORE_BETTER_CLI_ENV,
  type BuildBoxStoreCategoriesArgs,
} from "./box-store-sync-service-contracts.ts";
import type { BoxStoreCategory } from "./box-store-sync-contracts.ts";

/** Personal home content is opt-in; box runtime state is excluded even when it is enabled. */
export function buildBoxHomeCategory(absRoot: string): BoxStoreCategory {
  return {
    name: BOX_HOME_CATEGORY_NAME,
    absRoot,
    relPrefix: BOX_HOME_REL_PREFIX,
    excludes: BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES,
    ignore: () => compileWorkspaceIgnore(BOX_HOME_REGENERABLE_JUNK_IGNORE_PATTERNS),
  };
}

export function buildBoxStoreCategories(args: BuildBoxStoreCategoriesArgs): BoxStoreCategory[] {
  const slateDataPrefix = "home/box/slate-data";
  const categories: BoxStoreCategory[] = [
    {
      name: "slate-data",
      absRoot: args.slateRoot,
      relPrefix: slateDataPrefix,
      containsAgentStoreDbs: true,
      excludes: [
        `${slateDataPrefix}/host.lock`,
        `${slateDataPrefix}/gateway.json`,
        `${slateDataPrefix}/box-store-sync.lock`,
        `${slateDataPrefix}/${BOX_STORE_HYDRATION_HANDOFF_FILE_NAME}`,
        ...BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES.map(name => `${slateDataPrefix}/${name}`),
      ],
    },
    { name: "workspace", absRoot: "/workspace", relPrefix: "workspace", ignore: () => loadWorkspaceIgnore("/workspace") },
    {
      name: "cli-config",
      absRoot: "/home/box/cli-config",
      relPrefix: "home/box/cli-config",
      excludes: ["home/box/cli-config/.cli-auth-tmp*", "home/box/cli-config/*.cli-auth-old", "home/box/cli-config/**/*.cli-auth-old"],
    },
    {
      name: CHROME_SESSION_CATEGORY_NAME,
      absRoot: CHROME_SESSION_DB_DIR,
      relPrefix: "home/box/chrome-profile",
      stageOnly: true,
      stage: () => stageBoxChromeSession({ retry: args.chromeStageRetry, report: args.reportChromeSessionStage }),
    },
    ...CHROME_AUTH_STATE_REL_DIRS.map(dir => ({
      name: `chrome-${dir.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      absRoot: `${CHROME_SESSION_DB_DIR}/${dir}`,
      relPrefix: `${CHROME_SESSION_DB_REL_DIR}/${dir}`,
      excludes: CHROME_AUTH_STATE_CACHE_EXCLUDE_NAMES.map(cache => `${CHROME_SESSION_DB_REL_DIR}/${dir}/${cache}`),
    })),
    {
      name: "chrome-profile",
      absRoot: "/home/box/chrome-profile",
      relPrefix: "home/box/chrome-profile",
      excludes: [
        ...BROWSER_PROFILE_CACHE_EXCLUSIONS,
        ...CHROME_SESSION_DB_NAMES.flatMap(name => ["", "-wal", "-shm", "-journal"].map(suffix => `${CHROME_SESSION_DB_REL_DIR}/${name}${suffix}`)),
        ...CHROME_AUTH_STATE_REL_DIRS.map(dir => `${CHROME_SESSION_DB_REL_DIR}/${dir}`),
      ],
      idleOnly: true,
    },
  ];

  if (args.env[SLATE_STORE_BETTER_CLI_ENV] === "1" && args.env.SLATE_USER_NON_ROOT === "1") {
    categories.push(buildBoxHomeCategory(BOX_HOME_DIR));
  }
  return categories;
}

export { SLATE_MANIFEST_V2_ENV };
