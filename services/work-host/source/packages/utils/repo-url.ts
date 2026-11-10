/**
 * Whether a host is the platform's own plugin origin.
 *
 * Plugin artifacts are fetched from an origin that is ours, and a URL from it is read differently from a URL from a
 * public host: its paths are its own. Which hosts those are is not defined yet — the platform has no plugin origin
 * service — so nothing is recognized as one for now, and the one place that decides is here rather than spread through
 * the parsing that asks.
 */
export const isOriginGitHost = (_host: string): boolean => false;
