/** Convert a shorthand repository address into a URL the platform can inspect. */
export function urlFromGitAddress(address: string): URL | null {
  try {
    const source = address.startsWith("git@") ? `ssh://${address.replace(":", "/")}` : address;
    return new URL(source.includes("://") ? source : `https://${source}`);
  } catch {
    return null;
  }
}
