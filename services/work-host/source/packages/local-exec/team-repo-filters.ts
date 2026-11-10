/**
 * Telling a repository URL from a path pattern in the team's settings.
 *
 * A setting may name a repository by its URL or by a pattern that matches paths inside one; the wildcard means every
 * repository. A URL is recognized by carrying a scheme, a known host or a user, and everything else is a pattern.
 */

/** The one value that means every repository. */
const WILDCARD_REPO_URL = "*";

/** What makes a value a repository URL rather than a path pattern: a scheme, a known host, or a user. */
const REPO_URL_MARKERS = ["://", "github.com", "gitlab.com", "bitbucket.org", "@"];

/** Whether a value names a repository by its URL rather than by a path pattern. */
function isRepoUrl(url: string): boolean {
  return REPO_URL_MARKERS.some((marker) => url.includes(marker));
}

/** Whether the setting means every repository. */
export function isWildcardRepoUrl(url: string): boolean {
  return url.trim() === WILDCARD_REPO_URL;
}

/** Whether the setting is a pattern that matches paths inside a repository. */
export function isPathPatternRepoUrl(url: string): boolean {
  return !isRepoUrl(url);
}
