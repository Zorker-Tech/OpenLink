export function parseLoopbackRedirect(redirectUrl: URL): { port: number } {
  const localAddress = redirectUrl.hostname === "127.0.0.1" || redirectUrl.hostname === "localhost";
  if (redirectUrl.protocol !== "http:" || !localAddress) {
    throw new Error("MCP OAuth redirect_uri must be a localhost HTTP URL.");
  }

  const port = Number.parseInt(redirectUrl.port, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("MCP OAuth redirect_uri must include a port.");
  }
  return { port };
}

export function loopbackBindHosts(redirectHost: string): string[] {
  return redirectHost === "localhost" ? ["127.0.0.1", "::1"] : [redirectHost];
}
