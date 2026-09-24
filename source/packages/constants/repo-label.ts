/**
 * Repository labels.
 *
 * A conversation shows the repository it belongs to as `owner/name`, and that label has to come out
 * of whatever the user pasted: an https URL, an scp-style git remote, or a self-hosted host that is
 * neither of those and keeps its host in the label so two same-named repositories stay distinct.
 */

const KNOWN_GIT_HOSTING_DOMAINS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "bitbucket.com",
  "codeberg.org",
  "gitea.com",
  "sr.ht",
])

export function isKnownGitHostingDomain(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (KNOWN_GIT_HOSTING_DOMAINS.has(lower)) return true
  return [...KNOWN_GIT_HOSTING_DOMAINS].some(domain => lower.endsWith(`.${domain}`))
}

function trimRepoPath(pathname: string): string {
  return pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "")
}

function extractOwnerRepoFromPath(pathname: string): string | undefined {
  const parts = trimRepoPath(pathname).split("/").filter(Boolean)
  return parts.length < 2 ? undefined : `${parts[0]}/${parts.slice(1).join("/")}`
}

/** `git@host:owner/name` is a git remote, not a URL: rewrite it into one before parsing. */
function rewriteScpGitUrl(raw: string): string {
  if (raw.includes("://")) return raw
  const match = raw.match(/^[^@/]+@([^:]+):(.+)$/)
  return match === null ? raw : `https://${match[1]}/${match[2]}`
}

export function parseRepoNameFromUrl(repoUrl: string | null | undefined): string | undefined {
  try {
    const trimmed = repoUrl?.trim()
    if (!trimmed) return undefined
    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed)
      return extractOwnerRepoFromPath(parsed.pathname)
    }
    const slash = trimmed.indexOf("/")
    if (slash === -1) return undefined
    const host = trimmed.slice(0, slash)
    const rest = trimmed.slice(slash)
    return extractOwnerRepoFromPath(isKnownGitHostingDomain(host) ? rest : `/${trimmed}`)
  } catch {
    return undefined
  }
}

/** A host the platform does not know about: its label keeps the host, because names collide. */
export function parseSelfHostedRepoScope(repoUrl: string): string | undefined {
  let candidate = repoUrl
  if (!candidate.includes("://")) {
    const slash = candidate.indexOf("/")
    if (slash === -1) return undefined
    const host = candidate.slice(0, slash)
    if (!host.includes(".") || isKnownGitHostingDomain(host)) return undefined
    candidate = `https://${candidate}`
  }
  try {
    const parsed = new URL(candidate)
    if (isKnownGitHostingDomain(parsed.hostname)) return undefined
    const parts = trimRepoPath(parsed.pathname).split("/").filter(Boolean)
    return parts.length === 0 ? undefined : `${parsed.host}/${parts.join("/")}`
  } catch {
    return undefined
  }
}

export function deriveRepoLabelValueFromUrl(repoUrl: string | null | undefined): string | undefined {
  const trimmed = repoUrl?.trim()
  if (!trimmed) return undefined
  const rewritten = rewriteScpGitUrl(trimmed)
  return parseSelfHostedRepoScope(rewritten) ?? parseRepoNameFromUrl(rewritten)
}
