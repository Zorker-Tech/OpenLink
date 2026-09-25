/**
 * Telling a repository URL from a path pattern in the team's settings.
 *
 * A setting may name a repository by its URL or by a pattern that matches paths inside one; the wildcard means every
 * repository. A URL is recognized by carrying a scheme, a known host or a user, and everything else is a pattern.
 */
export function isWildcardRepoUrl(url: string): boolean {
  return url.trim() === "*";
}

export function isPathPatternRepoUrl(url: string): boolean {
  return !url.includes("://") && !url.includes("github.com") && !url.includes("gitlab.com") && !url.includes("bitbucket.org") && !url.includes("@");
}
