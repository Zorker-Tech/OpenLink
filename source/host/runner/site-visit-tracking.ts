/**
 * Noticing the sites an agent's browser visited.
 *
 * A browser navigation is recorded like any other action, and the host is told which site was visited — without the
 * www prefix, since that is not the site — so what the agent looked at can be reported without reading every record.
 */
export interface BrowserNavigationAction{readonly kind:"browserNavigation";readonly url:string;readonly pageTitle?:string}
export interface AuditRecord{readonly action:BrowserNavigationAction|{readonly kind:string;readonly [key:string]:unknown};readonly [key:string]:unknown}
export interface ActionAuditor{record(record:AuditRecord):void}
export function visitedSiteHost(rawUrl:string):string|undefined{if(!URL.canParse(rawUrl))return;const host=new URL(rawUrl).hostname.replace(/^www\./,"");return host||undefined}
export function withSiteVisitTracking(auditor:ActionAuditor,onVisit:(visit:{host:string},record:AuditRecord)=>void):ActionAuditor{return{record(record){auditor.record(record);if(record.action.kind!=="browserNavigation"||typeof record.action.url!=="string")return;const host=visitedSiteHost(record.action.url);if(host!==undefined)onVisit({host},record)}}}
