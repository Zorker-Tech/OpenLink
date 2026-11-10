/** The page a browser is shown after an MCP server's authentication comes back. */

/** The five characters HTML would otherwise read as structure, written as the entities it reads instead. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

/** The page's own styling: a dark, centred sentence and a quieter line under it. */
const PAGE_STYLE =
  "html,body{margin:0;min-height:100%;}" +
  'body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0c0c0d;color:#f4f4f5;}' +
  ".page{display:flex;min-height:100vh;flex:1;align-items:center;justify-content:center;}" +
  ".content{text-align:center;}" +
  ".message{font-size:1.125rem;line-height:1.75rem;margin:0;font-weight:400;}" +
  ".hint{margin:0.5rem 0 0;font-size:1rem;line-height:1.5rem;color:#a1a1aa;}";

/** One page: what happened, in a sentence, and what the reader should do about it. */
function renderCallbackPage(args: { title: string; message: string; hint: string }): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(args.title)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    '<main class="page">',
    '<div class="content">',
    `<p class="message">${escapeHtml(args.message)}</p>`,
    `<p class="hint">${escapeHtml(args.hint)}</p>`,
    "</div>",
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

/** The name a server was given, when it has one worth saying. */
function serverNameOf(args: { serverName?: string } | undefined): string | undefined {
  const name = args?.serverName?.trim();
  return name != null && name.length > 0 ? name : undefined;
}

/** The page a user sees when a server's authentication succeeded. */
export function renderMcpOAuthSuccessPage(args?: { serverName?: string }): string {
  const serverName = serverNameOf(args);
  return renderCallbackPage({
    title: serverName != null ? `${serverName} connected` : "Authentication complete",
    message: "Authorization complete!",
    hint: "You can close this tab.",
  });
}

/** The page a user sees when it failed, which names the server when there is one to name. */
export function renderMcpOAuthErrorPage(args?: { serverName?: string }): string {
  const serverName = serverNameOf(args);
  return renderCallbackPage({
    title: serverName != null ? `${serverName} — Authentication failed` : "Authentication failed",
    message: "OAuth callback failed.",
    hint: "Close this tab and try connecting again.",
  });
}
