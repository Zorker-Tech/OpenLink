/**
 * Reading a repository out of a git remote.
 *
 * The remote may be written in any of the forms git accepts — a URL, a scp-like path, a bare host and path — and what
 * comes back is the host and the path it names, or nothing when it does not name one.
 */

/** The path a remote names, once its `.git` suffix is off. */
function pathSegments(url: URL): string[] {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last !== undefined && last.endsWith(".git")) segments[segments.length - 1] = last.slice(0, -4);
  return segments;
}

/** A remote in the scp form `user@host:path` reads as an ssh URL; everything else is left for the URL parser. */
function asUrl(raw: string): URL | null {
  let candidate = raw;
  if (raw.includes("@") && !raw.startsWith("http") && !raw.startsWith("ssh://")) {
    candidate = raw.replace(/^([^@]+)@([^:]+):(.*)/, "ssh://$1@$2/$3");
  }
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/** The first `wanted` segments, when there are at least that many. */
function firstSegments(segments: readonly string[], wanted: number): string | undefined {
  return segments.length >= wanted ? segments.slice(0, wanted).join("/") : undefined;
}

/** Everything the path names, when it names anything. */
function wholePath(segments: readonly string[]): string | undefined {
  return segments.length >= 1 ? segments.join("/") : undefined;
}

/** One host's rule: whether it applies, and what that host calls the repository at this path. */
interface HostRule {
  readonly applies: (host: string, segments: readonly string[]) => boolean;
  readonly nameIn: (host: string, segments: readonly string[]) => string | undefined;
}

/**
 * The hosts that disagree about what a repository path means, most specific first.
 *
 * Azure hides the repository behind `_git` (and an ssh remote prefixes `v3`), GitHub stopped being one host long ago,
 * Bitbucket's server product puts `scm` in front of it, and Gerrit may put both `gerrit` and `a` there.
 */
const HOST_RULES: readonly HostRule[] = [
  {
    applies: (host) => host === "dev.azure.com" || host === "ssh.dev.azure.com" || host.endsWith(".visualstudio.com"),
    nameIn: (host, segments) => {
      const withoutVersion = [...segments];
      if (host === "ssh.dev.azure.com" && withoutVersion[0]?.toLowerCase() === "v3") withoutVersion.shift();
      return wholePath(withoutVersion.filter((segment) => segment.toLowerCase() !== "_git"));
    },
  },
  {
    applies: (host) => host.includes("github") || host.endsWith(".ghe.com"),
    nameIn: (_host, segments) => firstSegments(segments, 2),
  },
  {
    applies: (host) => host.includes("gitlab"),
    nameIn: (_host, segments) => wholePath(segments),
  },
  {
    applies: (host) => host.includes("bitbucket") || host.includes("stash"),
    nameIn: (_host, segments) => {
      if (segments.length >= 3 && segments[0]?.toLowerCase() === "scm") return segments.slice(1, 3).join("/");
      return firstSegments(segments, 2);
    },
  },
  {
    applies: (host, segments) => host.includes("gerrit") || segments[0]?.toLowerCase() === "gerrit",
    nameIn: (_host, segments) => {
      const rest = [...segments];
      if (rest[0]?.toLowerCase() === "gerrit") rest.shift();
      if (rest[0]?.toLowerCase() === "a") rest.shift();
      return wholePath(rest);
    },
  },
];

/** What a host that needs no special handling calls it: the first two segments of the path. */
function defaultName(segments: readonly string[]): string | undefined {
  return firstSegments(segments, 2);
}

/**
 * The repository a remote names, as `owner/name`, or nothing when the remote does not name one.
 *
 * A `gitlab-remote://` remote is answered from its own query when it carries a project with a namespace, and read as an
 * ordinary URL when it does not.
 */
export function extractRepoNameFromGitUrl(upstreamURL: string | undefined): string | undefined {
  if (!upstreamURL) return undefined;
  // Two of the transports this platform builds write a URL with its slashes folded into one; repaired before parsing.
  const repaired = upstreamURL.replace("https///", "https://").replace("http///", "http://");
  if (repaired.startsWith("gitlab-remote://")) {
    const remote = (() => {
      try {
        return new URL(repaired);
      } catch {
        return null;
      }
    })();
    const project = remote?.searchParams.get("project");
    if (project != null) return project.includes("/") ? project : undefined;
  }
  const url = asUrl(repaired);
  if (url === null) return undefined;
  const host = url.hostname.toLowerCase();
  const segments = pathSegments(url);
  for (const rule of HOST_RULES) {
    if (rule.applies(host, segments)) return rule.nameIn(host, segments);
  }
  return defaultName(segments);
}
