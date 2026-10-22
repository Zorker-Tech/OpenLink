/**
 * A repository's identity: the host and the path, and nothing about how it was reached.
 *
 * The same repository is written as an scp-style remote, an ssh url, a bare host and path, with or without a scheme,
 * a trailing slash, a `.git` suffix or a query. The identity is what all of those have in common, so the differences
 * are stripped rather than kept.
 */

/** An scp-style remote: `git@host:owner/name` is a URL in disguise. */
const SCP_REMOTE = /^git@/;

/** Any URL scheme, and the two this platform keeps. */
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HTTP_SCHEME = /^https?:\/\//i;

/** What is not part of the identity: trailing slashes, the git suffix, and a query or fragment. */
const TRAILING_SLASHES = /\/+$/;
const GIT_SUFFIX = /\.git$/i;
const QUERY_OR_FRAGMENT = /[?#].*$/;

/** An scp-style remote turned into a URL: the colon between host and path becomes the path's own. */
function withScpRemoteAsUrl(url: string): string {
  return SCP_REMOTE.test(url) ? `https://${url.slice("git@".length).replace(":", "/")}` : url;
}

/** A scheme other than http/https turned into https: only the host and the path are kept, so the scheme is noise. */
function withHttpsScheme(url: string): string {
  return ANY_SCHEME.test(url) && !HTTP_SCHEME.test(url) ? url.replace(ANY_SCHEME, "https://") : url;
}

/** A bare host and path is a URL too. */
function withScheme(url: string): string {
  return HTTP_SCHEME.test(url) ? url : `https://${url}`;
}

/** A path without the marks that name the same repository differently. */
function withoutPathNoise(pathname: string): string {
  return pathname.replace(TRAILING_SLASHES, "").replace(GIT_SUFFIX, "").replace(TRAILING_SLASHES, "");
}

export function toHostPath(rawUrl: string): string {
  const url = withScheme(withHttpsScheme(withScpRemoteAsUrl(rawUrl.trim())));
  try {
    const parsed = new URL(url);
    return parsed.hostname + withoutPathNoise(parsed.pathname);
  } catch {
    // A URL the parser refuses is still written down somehow: strip what this platform strips by hand.
    return withoutPathNoise(url.replace(HTTP_SCHEME, "").replace(QUERY_OR_FRAGMENT, ""));
  }
}
