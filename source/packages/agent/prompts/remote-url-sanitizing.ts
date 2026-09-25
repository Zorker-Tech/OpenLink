/**
 * A remote URL with its credentials taken out before it is written into a prompt.
 *
 * The prompt tells the agent which remote the repository has, and a remote URL may carry a user name and
 * a token in its userinfo — `https://user:token@host/…` — which would then travel into the transcript
 * and every summary of it. A URL that cannot be parsed is left as it came rather than dropped: an
 * unparsable remote is still worth naming, and rewriting it would lose the only description there is.
 */

export function sanitizeRemoteUrlForPrompt(remoteUrl: string): string {
  const trimmedRemoteUrl = remoteUrl.trim()
  if (trimmedRemoteUrl === "") return trimmedRemoteUrl
  try {
    const parsedRemoteUrl = new URL(trimmedRemoteUrl)
    parsedRemoteUrl.username = ""
    parsedRemoteUrl.password = ""
    return parsedRemoteUrl.toString()
  } catch {
    return trimmedRemoteUrl
  }
}
