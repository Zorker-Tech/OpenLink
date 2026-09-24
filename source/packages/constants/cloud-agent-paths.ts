/**
 * Where things live inside a cloud agent's environment.
 *
 * A cloud agent works in a fresh environment the platform provisions, so the paths it reads and
 * writes are the platform's own: a managed skill directory it installs into, the workspace root a
 * single-repository run is scoped to, and the directory artifacts are collected in.
 */

export const ENV_SETUP_SKILL_ID = "env-setup"
export const ENV_SETUP_MANAGED_SKILL_DIRECTORY = `/.slate/skills/${ENV_SETUP_SKILL_ID}/`
export const ENV_SETUP_MANAGED_SKILL_PATH = `${ENV_SETUP_MANAGED_SKILL_DIRECTORY}SKILL.md`

export const CLOUD_AGENT_SINGLE_REPO_WORKSPACE_ROOT = "/workspace"
export const CLOUD_AGENT_ARTIFACTS_DIR = "/opt/slate/artifacts/"
