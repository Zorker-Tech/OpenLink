/**
 * A repository's identity, as a host and a path.
 *
 * The same repository is named differently depending on how it was reached — an ssh remote, a scheme other than
 * http, a bare host and path, a trailing slash or `.git`, a query — and the identity is what they all have in common,
 * so the differences are stripped rather than kept.
 */
export function toHostPath(rawUrl: string): string {
  let url = rawUrl.trim();
  if (url.startsWith("git@")) {
    url = `https://${url.slice("git@".length).replace(":", "/")}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) {
    url = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "https://");
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    return parsed.hostname + pathname;
  } catch {
    url = url.replace(/^https?:\/\//i, "");
    url = url.replace(/[?#].*$/, "");
    url = url.replace(/\/+$/, "");
    url = url.replace(/\.git$/i, "");
    url = url.replace(/\/+$/, "");
    return url;
  }
}
