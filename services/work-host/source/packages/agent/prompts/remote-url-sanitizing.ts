/**
 * A remote URL with its credentials taken out before it is written into a prompt.
 *
 * The prompt tells the agent which remote the repository has, and a remote URL may carry a user name and a token in
 * its userinfo — `https://user:token@host/…` — which would then travel into the transcript and every summary of it.
 * A URL that cannot be parsed is left as it came rather than dropped: an unparsable remote is still worth naming, and
 * rewriting it would lose the only description there is.
 */

/** The userinfo of a URL is the user name and the token it carries; neither belongs in a prompt. */
function withoutUserInfo(url: URL): URL {
  url.username = "";
  url.password = "";
  return url;
}

/** A remote URL as it may appear in a prompt: trimmed, and without the credentials it was reached with. */
export function sanitizeRemoteUrlForPrompt(remoteUrl: string): string {
  const candidate = remoteUrl.trim();
  if (candidate === "") return candidate;
  try {
    return withoutUserInfo(new URL(candidate)).toString();
  } catch {
    return candidate;
  }
}
