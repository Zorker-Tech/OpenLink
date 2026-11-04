/** Public workspace ignore parser and policy used by box-store scans. */

export { REGENERABLE_WORKSPACE_PATH_PATTERNS } from "../../../adapters/interop/box/workspace-archive-layout-adapter.ts";
export { WORKSPACE_IGNORE_FILE_NAME } from "../../../packages/constants/box-archive.ts";
export { IGNORE_NOTHING } from "./workspace-ignore-contracts.ts";
export type { WorkspaceIgnore } from "./workspace-ignore-contracts.ts";

export {
  parseIgnorePatterns,
  compileRule,
  computeNegationReach,
  globToRegexBody,
} from "./workspace-ignore-patterns.ts";
export { compileWorkspaceIgnore, negationReaches } from "./workspace-ignore-policy.ts";
export { loadWorkspaceIgnore } from "./workspace-ignore-loader.ts";
