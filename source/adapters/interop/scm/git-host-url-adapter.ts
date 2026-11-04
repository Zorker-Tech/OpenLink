/**
 * URL shapes accepted at Git service boundaries.
 *
 * Keep service hostnames and path markers here so product utilities can use repository values without depending on a
 * particular hosting provider's URL grammar.
 */
const GIT_SUFFIX = /\.git$/i
const NON_REPOSITORY_ROOTS = new Set(["account", "dashboard"])

const stripSuffix = (segment: string): string => segment.replace(GIT_SUFFIX, "")

export const isGitHubDotComHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  return host === "github.com" || host.endsWith(".github.com")
}

export const isGitLabHost = (hostname: string): boolean =>
  hostname.toLowerCase().split(".").includes("gitlab")

export const isBitbucketCloudHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  return host === "bitbucket.org" || host === "www.bitbucket.org"
}

export const isAzureDevopsServicesHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  return host === "dev.azure.com" || host === "www.dev.azure.com"
}

export function parseGitHubRepositoryPathSegments(
  segments: readonly string[],
): { owner: string; repo: string; hasSubpath: boolean } | undefined {
  const owner = segments.at(0)
  const rawRepo = segments.at(1)
  if (owner === undefined || owner.length === 0 || rawRepo === undefined) return undefined
  const repo = stripSuffix(rawRepo)
  if (repo.length === 0) return undefined
  return { owner, repo, hasSubpath: segments.length > 2 }
}

export function parseGitLabRepositoryPathSegments(
  segments: readonly string[],
): { repositorySegments: string[]; hasSpecialRouteSeparator: boolean } | undefined {
  const separator = segments.indexOf("-")
  const repositorySegments = separator < 0 ? [...segments] : segments.slice(0, separator)
  if (repositorySegments.length < 2 || repositorySegments.some(segment => segment.length === 0)) return undefined
  const last = repositorySegments.length - 1
  const repository = stripSuffix(repositorySegments[last]!)
  if (repository.length === 0) return undefined
  repositorySegments[last] = repository
  return { repositorySegments, hasSpecialRouteSeparator: separator >= 0 }
}

function decodeRoutePart(segment: string): string | undefined {
  try {
    const value = decodeURIComponent(segment)
    return value.length > 0 && !value.includes("/") ? value : undefined
  } catch {
    return undefined
  }
}

export function parseBitbucketRepositoryPathSegments(
  segments: readonly string[],
): { workspace: string; repo: string; hasSubpath: boolean } | undefined {
  const rawWorkspace = segments.at(0)
  const rawRepo = segments.at(1)
  if (rawWorkspace === undefined || rawRepo === undefined) return undefined
  const workspace = decodeRoutePart(rawWorkspace)
  const decodedRepo = decodeRoutePart(rawRepo)
  if (workspace === undefined || decodedRepo === undefined) return undefined
  if (NON_REPOSITORY_ROOTS.has(workspace.toLowerCase())) return undefined
  const repo = stripSuffix(decodedRepo)
  if (repo.length === 0) return undefined
  return {
    workspace: encodeURIComponent(workspace),
    repo: encodeURIComponent(repo),
    hasSubpath: segments.length > 2,
  }
}

export function parseAzureDevopsRepositoryPathSegments(
  segments: readonly string[],
): { organization: string; project: string; repo: string; hasSubpath: boolean } | undefined {
  const marker = segments.findIndex(segment => segment.toLowerCase() === "_git")
  if (marker < 1 || marker > 2) return undefined
  const organization = segments.at(0)
  const rawRepo = segments.at(marker + 1)
  if (organization === undefined || organization.length === 0 || rawRepo === undefined || rawRepo.length === 0) return undefined
  const repo = stripSuffix(rawRepo)
  const project = marker === 2 ? segments.at(1) : repo
  if (repo.length === 0 || project === undefined || project.length === 0) return undefined
  return { organization, project, repo, hasSubpath: segments.length > marker + 2 }
}
