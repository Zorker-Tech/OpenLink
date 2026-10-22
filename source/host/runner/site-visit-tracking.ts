/**
 * Noticing the sites an agent's browser visited.
 *
 * A browser navigation is recorded like any other action, and the host is told which site was visited — without the
 * www prefix, since that is not the site — so what the agent looked at can be reported without reading every record.
 */

/** One action of a browser navigating to a page. */
export interface BrowserNavigationAction {
  readonly kind: "browserNavigation";
  readonly url: string;
  readonly pageTitle?: string;
}

/** A record an auditor is handed: a browser navigation, or any other action with whatever it carries. */
export interface AuditRecord {
  readonly action: BrowserNavigationAction | { readonly kind: string; readonly [key: string]: unknown };
  readonly [key: string]: unknown;
}

/** Something that records actions. */
export interface ActionAuditor {
  record(record: AuditRecord): void;
}

/** The www prefix a host name may carry, which is not the site. */
const WWW_PREFIX = /^www\./;

/** The host name a URL visits, without the www prefix; undefined when the URL cannot be parsed or names no host. */
export function visitedSiteHost(raw: string): string | undefined {
  if (!URL.canParse(raw)) return undefined;
  const hostname = new URL(raw).hostname.replace(WWW_PREFIX, "");
  return hostname.length === 0 ? undefined : hostname;
}

/** The URL a record navigated to, or undefined when the record is not a browser navigation with a URL. */
function navigatedUrlOf(entry: AuditRecord): string | undefined {
  const action = entry.action;
  if (action.kind !== "browserNavigation") return undefined;
  return typeof action.url === "string" ? action.url : undefined;
}

/** An auditor that reports the sites the agent visits, after recording the visit like any other action. */
export function withSiteVisitTracking(
  inner: ActionAuditor,
  notify: (visit: { host: string }, record: AuditRecord) => void,
): ActionAuditor {
  return {
    record(entry) {
      inner.record(entry);
      const url = navigatedUrlOf(entry);
      if (url === undefined) return;
      const host = visitedSiteHost(url);
      if (host !== undefined) notify({ host }, entry);
    },
  };
}
