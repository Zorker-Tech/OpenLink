/**
 * The platform's error registry.
 *
 * Every condition the Work platform reports has one entry here: a stable code, the domain it belongs
 * to, whether a retry can help, the only fields allowed to travel with it, and where it is raised.
 * The catalogue *is* the contract at the emit boundary: `slateErrorTags` refuses a code it does not
 * know, drops payload fields the entry does not declare and bounds every value it does tag, so an
 * error crossing into telemetry can never carry an unbounded or unvetted string.
 *
 * Adding a condition means adding an entry and using the constructor it generates — nothing reports
 * an ad-hoc code, which is what keeps a dashboard stable across releases.
 */

export interface SlateErrorDefinition {
  readonly name: string
  readonly domain: string
  /** Whether repeating the operation can succeed; a fatal condition repeats its outcome. */
  readonly retryable: boolean
  readonly summary: string
  /** The only payload fields this code may ship. */
  readonly payload: readonly string[]
  /** Subsystem and condition, in this platform's own terms. */
  readonly raisedBy: string
}

export const SLATE_ERROR_DEFINITIONS = {
  "SLATE-E0001": {
    "name": "unregistered",
    "domain": "registry",
    "retryable": false,
    "summary": "A value that is not a registered platform error reached the emit boundary and was reclassified; the original code and payload never ship.",
    "payload": [],
    "raisedBy": "shared/errors · the emit boundary itself"
  },
  "SLATE-E0101": {
    "name": "gatewayRefused",
    "domain": "transport",
    "retryable": true,
    "summary": "Nothing accepted the connection to the gateway.",
    "payload": [
      "errno"
    ],
    "raisedBy": "gateway reachability · connection refused"
  },
  "SLATE-E0102": {
    "name": "gatewayTimeout",
    "domain": "transport",
    "retryable": true,
    "summary": "A gateway attempt hit its deadline with no reply.",
    "payload": [
      "errno"
    ],
    "raisedBy": "gateway reachability · deadline"
  },
  "SLATE-E0103": {
    "name": "gatewayHttp5xx",
    "domain": "transport",
    "retryable": true,
    "summary": "The gateway answered 5xx: the route arrived but the gateway or the host errored.",
    "payload": [
      "httpStatus"
    ],
    "raisedBy": "gateway reachability · server error response"
  },
  "SLATE-E0104": {
    "name": "gatewayDns",
    "domain": "transport",
    "retryable": true,
    "summary": "The gateway host name did not resolve.",
    "payload": [
      "errno"
    ],
    "raisedBy": "gateway reachability · name resolution"
  },
  "SLATE-E0105": {
    "name": "gatewayNetwork",
    "domain": "transport",
    "retryable": true,
    "summary": "The gateway transport failed on a live but broken route.",
    "payload": [
      "errno"
    ],
    "raisedBy": "gateway reachability · transport failure"
  },
  "SLATE-E0106": {
    "name": "backendHttpStatus",
    "domain": "transport",
    "retryable": true,
    "summary": "The cloud backend answered with a non-ok HTTP status.",
    "payload": [
      "httpStatus"
    ],
    "raisedBy": "automation delivery · backend status"
  },
  "SLATE-E0107": {
    "name": "backendUnreachable",
    "domain": "transport",
    "retryable": true,
    "summary": "The cloud backend could not be reached at all.",
    "payload": [
      "errno"
    ],
    "raisedBy": "automation delivery · backend unreachable"
  },
  "SLATE-E0108": {
    "name": "backendDeliveryFailed",
    "domain": "transport",
    "retryable": true,
    "summary": "An automation delivery attempt failed outside the status and errno shapes; the caller retries with backoff.",
    "payload": [],
    "raisedBy": "automation delivery · uncategorized failure"
  },
  "SLATE-E0109": {
    "name": "logShipTimeout",
    "domain": "transport",
    "retryable": true,
    "summary": "Shipping a batch of structured logs hit the submit deadline; the batch requeues and is redelivered.",
    "payload": [
      "batchEntries"
    ],
    "raisedBy": "structured log transport · submit deadline"
  },
  "SLATE-E0110": {
    "name": "streamStalled",
    "domain": "transport",
    "retryable": true,
    "summary": "An established gateway event stream went silent past the stall watchdog and was torn down; the loop reconnects.",
    "payload": [],
    "raisedBy": "gateway client · stall watchdog"
  },
  "SLATE-E0111": {
    "name": "localExecNoProviders",
    "domain": "transport",
    "retryable": true,
    "summary": "A local-machine action was refused: no client is registered on the reverse local-exec channel.",
    "payload": [],
    "raisedBy": "local exec bridge · no provider"
  },
  "SLATE-E0112": {
    "name": "localExecProvidersStale",
    "domain": "transport",
    "retryable": true,
    "summary": "A local-machine action was refused: clients are registered on the reverse local-exec channel but none heartbeat inside the liveness window.",
    "payload": [],
    "raisedBy": "local exec bridge · stale providers"
  },
  "SLATE-E0113": {
    "name": "localExecComputerUnknown",
    "domain": "transport",
    "retryable": true,
    "summary": "A local-machine action was refused: the addressed computer matches no registered connection.",
    "payload": [],
    "raisedBy": "local exec bridge · unknown computer"
  },
  "SLATE-E0201": {
    "name": "boxAccessDenied",
    "domain": "auth",
    "retryable": false,
    "summary": "The backend refused box access for a privacy-mode (no-storage) account.",
    "payload": [],
    "raisedBy": "gateway reachability · no-storage marker"
  },
  "SLATE-E0202": {
    "name": "gatewayAccessDenied",
    "domain": "auth",
    "retryable": false,
    "summary": "An auth or entitlement gate refused the gateway attempt (401/403); retrying cannot fix it.",
    "payload": [
      "httpStatus"
    ],
    "raisedBy": "gateway reachability · access denied"
  },
  "SLATE-E0203": {
    "name": "connectorAuthStartRefused",
    "domain": "auth",
    "retryable": false,
    "summary": "A connector's sign-in flow could not start: the connector cannot mint a sign-in link in its current state.",
    "payload": [
      "reason"
    ],
    "raisedBy": "connector auth watch · start refused"
  },
  "SLATE-E0204": {
    "name": "connectorAuthStartFailed",
    "domain": "auth",
    "retryable": true,
    "summary": "A connector's sign-in flow failed to start because the auth status probe failed.",
    "payload": [
      "reason"
    ],
    "raisedBy": "connector auth watch · start failed"
  },
  "SLATE-E0205": {
    "name": "connectorOauthCallbackFailed",
    "domain": "auth",
    "retryable": true,
    "summary": "The loopback listener for a connector's OAuth callback failed to handle the request.",
    "payload": [
      "reason"
    ],
    "raisedBy": "connector OAuth loopback · callback failure"
  },
  "SLATE-E0206": {
    "name": "connectorAuthAbandoned",
    "domain": "auth",
    "retryable": true,
    "summary": "A pending connector sign-in was abandoned when its watch expired.",
    "payload": [],
    "raisedBy": "connector auth watch · expiry"
  },
  "SLATE-E0207": {
    "name": "webauthnNoProvider",
    "domain": "auth",
    "retryable": true,
    "summary": "A presence ceremony was refused: no client is registered on the reverse WebAuthn channel.",
    "payload": [],
    "raisedBy": "webauthn bridge · no provider"
  },
  "SLATE-E0208": {
    "name": "webauthnProviderStale",
    "domain": "auth",
    "retryable": true,
    "summary": "A presence ceremony was refused: clients are registered but none heartbeat inside the liveness window.",
    "payload": [],
    "raisedBy": "webauthn bridge · stale providers"
  },
  "SLATE-E0209": {
    "name": "webauthnCeremonyTimedOut",
    "domain": "auth",
    "retryable": true,
    "summary": "A presence ceremony hit its deadline with no settlement.",
    "payload": [],
    "raisedBy": "webauthn bridge · ceremony deadline"
  },
  "SLATE-E0210": {
    "name": "webauthnConsentDeclined",
    "domain": "auth",
    "retryable": false,
    "summary": "The user declined the presence prompt.",
    "payload": [],
    "raisedBy": "webauthn provider · consent declined"
  },
  "SLATE-E0211": {
    "name": "webauthnSignFailed",
    "domain": "auth",
    "retryable": true,
    "summary": "The signing leg of a presence ceremony failed: the signer reported an error instead of an assertion.",
    "payload": [
      "domError",
      "signErrorClass"
    ],
    "raisedBy": "webauthn provider · signing failure"
  },
  "SLATE-E0212": {
    "name": "webauthnDesktopFailed",
    "domain": "auth",
    "retryable": true,
    "summary": "A presence ceremony failed on the client side outside the declined and signing shapes, or the client reported no stage attribution.",
    "payload": [
      "domError",
      "signErrorClass"
    ],
    "raisedBy": "webauthn bridge · unattributed failure"
  },
  "SLATE-E0213": {
    "name": "webauthnDispatchFailed",
    "domain": "auth",
    "retryable": true,
    "summary": "Dispatching a presence ceremony failed: the selected client's request stream refused the write.",
    "payload": [],
    "raisedBy": "webauthn bridge · dispatch failure"
  },
  "SLATE-E0301": {
    "name": "bootStageStalled",
    "domain": "rebuild",
    "retryable": true,
    "summary": "A box rebuild stalled before completing a boot stage.",
    "payload": [
      "stage"
    ],
    "raisedBy": "box boot progress · stage watchdog"
  },
  "SLATE-E0302": {
    "name": "hostLifecycleStalled",
    "domain": "rebuild",
    "retryable": true,
    "summary": "Host startup inside the box stalled inside a lifecycle phase.",
    "payload": [],
    "raisedBy": "host lifecycle progress · watchdog"
  },
  "SLATE-E0303": {
    "name": "hostLifecycleFailed",
    "domain": "rebuild",
    "retryable": true,
    "summary": "Host startup inside the box failed inside a lifecycle phase.",
    "payload": [],
    "raisedBy": "host lifecycle progress · failure"
  },
  "SLATE-E0304": {
    "name": "boxImageCheckTimedOut",
    "domain": "rebuild",
    "retryable": true,
    "summary": "A box image-update check hit its deadline before the backend answered.",
    "payload": [],
    "raisedBy": "box image check · deadline"
  },
  "SLATE-E0305": {
    "name": "boxImageCheckFailed",
    "domain": "rebuild",
    "retryable": true,
    "summary": "A box image-update check failed before its deadline.",
    "payload": [],
    "raisedBy": "box image check · failure"
  },
  "SLATE-E0401": {
    "name": "providerOverloaded",
    "domain": "agent",
    "retryable": true,
    "summary": "The model provider is overloaded: capacity exhausted or rate limited.",
    "payload": [
      "connectCode"
    ],
    "raisedBy": "turn error classification · capacity"
  },
  "SLATE-E0402": {
    "name": "firstTokenStall",
    "domain": "agent",
    "retryable": true,
    "summary": "The provider streamed nothing within the first-token deadline.",
    "payload": [],
    "raisedBy": "turn error classification · first-token stall"
  },
  "SLATE-E0403": {
    "name": "streamReset",
    "domain": "agent",
    "retryable": true,
    "summary": "The turn stream dropped on a transient transport reset.",
    "payload": [
      "connectCode",
      "errno"
    ],
    "raisedBy": "turn error classification · stream reset"
  },
  "SLATE-E0404": {
    "name": "contextWindowOverflow",
    "domain": "agent",
    "retryable": false,
    "summary": "The turn hit a context-window overflow that a retry would repeat.",
    "payload": [],
    "raisedBy": "turn error classification · context window"
  },
  "SLATE-E0405": {
    "name": "backendRejected",
    "domain": "agent",
    "retryable": false,
    "summary": "The backend rejected the turn with a terminal structured error.",
    "payload": [
      "connectCode"
    ],
    "raisedBy": "turn runtime · terminal rejection"
  },
  "SLATE-E0406": {
    "name": "turnRetryable",
    "domain": "agent",
    "retryable": true,
    "summary": "The turn failed retryably outside every more specific shape.",
    "payload": [
      "connectCode"
    ],
    "raisedBy": "turn runtime · retryable failure"
  },
  "SLATE-E0407": {
    "name": "agentUnclassified",
    "domain": "agent",
    "retryable": false,
    "summary": "An agent-path operation failed outside every classified shape.",
    "payload": [],
    "raisedBy": "turn runtime · unclassified failure"
  },
  "SLATE-E0408": {
    "name": "backendCapacityDeferred",
    "domain": "agent",
    "retryable": true,
    "summary": "The backend deferred the turn at capacity and asked for a paced retry; the runner sleeps the advertised delay and retries.",
    "payload": [
      "connectCode",
      "retryAfterMs"
    ],
    "raisedBy": "turn runtime · capacity deferral"
  },
  "SLATE-E0409": {
    "name": "memorySynthesisInvalidOutput",
    "domain": "agent",
    "retryable": false,
    "summary": "A memory synthesis run produced an invalid proposal: unparseable output, an unknown evidence citation, or a change the memory state rejected.",
    "payload": [],
    "raisedBy": "memory synthesis · invalid proposal"
  },
  "SLATE-E0410": {
    "name": "memorySynthesisRejected",
    "domain": "agent",
    "retryable": false,
    "summary": "Verification did not approve a memory synthesis proposal.",
    "payload": [],
    "raisedBy": "memory synthesis · not approved"
  },
  "SLATE-E0411": {
    "name": "memorySynthesisStale",
    "domain": "agent",
    "retryable": true,
    "summary": "Memory changed under a synthesis run; the pending evidence is re-queued against the fresh state.",
    "payload": [],
    "raisedBy": "memory synthesis · stale evidence"
  },
  "SLATE-E0412": {
    "name": "memorySynthesisEvidenceDropped",
    "domain": "agent",
    "retryable": false,
    "summary": "Pending synthesis evidence was shed by a capacity cap before any run consumed it.",
    "payload": [],
    "raisedBy": "memory synthesis · evidence shed"
  },
  "SLATE-E0413": {
    "name": "memorySynthesisFailed",
    "domain": "agent",
    "retryable": true,
    "summary": "A memory synthesis run failed outside the classified shapes (transport or deadline).",
    "payload": [],
    "raisedBy": "memory synthesis · run failure"
  },
  "SLATE-E0414": {
    "name": "conversationTooLarge",
    "domain": "agent",
    "retryable": false,
    "summary": "A turn was refused at the conversation-size hard cap: the live conversation tree is over the limit and compaction could not shrink it, so the refusal repeats until compaction succeeds or the conversation is replaced.",
    "payload": [],
    "raisedBy": "conversation size gate · hard cap"
  },
  "SLATE-E0720": {
    "name": "journalAppendFailed",
    "domain": "storage",
    "retryable": true,
    "summary": "Committing the prepared transcript write-ahead log into the canonical journal failed; the checkpoint stays durable and the turn path surfaces the error.",
    "payload": [
      "errno"
    ],
    "raisedBy": "transcript journal · append"
  },
  "SLATE-E0721": {
    "name": "journalCheckpointFailed",
    "domain": "storage",
    "retryable": true,
    "summary": "Deriving or writing the pending write-ahead checkpoint failed before anything was committed.",
    "payload": [
      "errno"
    ],
    "raisedBy": "transcript journal · checkpoint"
  },
  "SLATE-E0722": {
    "name": "journalCorruptTail",
    "domain": "storage",
    "retryable": false,
    "summary": "The transcript journal was missing, truncated or torn at open for a conversation with durable history; it was discarded and rebuilt from the checkpoint.",
    "payload": [
      "tail",
      "errno"
    ],
    "raisedBy": "transcript journal · corrupt tail"
  },
  "SLATE-E0723": {
    "name": "journalReplayFailed",
    "domain": "storage",
    "retryable": true,
    "summary": "Reconciling the pending write-ahead log against the durable checkpoint failed; the journal cannot advance until the mismatch resolves.",
    "payload": [
      "errno"
    ],
    "raisedBy": "transcript journal · replay"
  },
  "SLATE-E0724": {
    "name": "journalRebuildFailed",
    "domain": "storage",
    "retryable": true,
    "summary": "Re-deriving the transcript journal from the durable checkpoint failed after a corrupt or absent journal was discarded; the next recovery retries the rebuild.",
    "payload": [
      "tail",
      "errno"
    ],
    "raisedBy": "transcript journal · rebuild"
  }
} as const satisfies Readonly<Record<string, SlateErrorDefinition>>

export type SlateErrorCode = keyof typeof SLATE_ERROR_DEFINITIONS
export type SlateErrorName = (typeof SLATE_ERROR_DEFINITIONS)[SlateErrorCode]["name"]
export type SlateErrorValue = { readonly code: string } & Readonly<Record<string, unknown>>

type SlateErrorConstructors = {
  readonly [Code in SlateErrorCode as (typeof SLATE_ERROR_DEFINITIONS)[Code]["name"]]:
    (payload?: Readonly<Record<string, unknown>>) => { readonly code: Code } & Readonly<Record<string, unknown>>
}

/**
 * One constructor per registered code, keyed by name: `SlateError.gatewayTimeout({ errno })`. Raisers
 * name the condition, never the code, and the code they ship is the one the catalogue assigns.
 */
export const SlateError = Object.fromEntries(
  Object.entries(SLATE_ERROR_DEFINITIONS).map(([code, definition]) => [
    definition.name,
    (payload?: Readonly<Record<string, unknown>>) => ({ code, ...payload }),
  ]),
) as SlateErrorConstructors

export const UNREGISTERED_CODE = "SLATE-E0001" as const

/** Tag values are short and opaque: no whitespace, no free text, no quoting to escape. */
const BOUNDED_TAG_VALUE = /^[0-9A-Za-z._|:-]{1,64}$/

export function isRegisteredCode(code: unknown): code is SlateErrorCode {
  return typeof code === "string" && Object.hasOwn(SLATE_ERROR_DEFINITIONS, code)
}

/** The code that will actually be reported: anything unregistered is reclassified. */
export function slateErrorWireCode(error: { readonly code?: unknown }): SlateErrorCode {
  return isRegisteredCode(error.code) ? error.code : UNREGISTERED_CODE
}

/** `httpStatus` → `http_status`, so a tag key is stable regardless of TypeScript spelling. */
function tagName(field: string): string {
  return field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

/**
 * The tags an error contributes: always the code, domain and retryability; then only the payload
 * fields the registry declares for that code, each one bounded. An error whose code is not
 * registered ships the three base tags and nothing else, so an unexpected value cannot smuggle a
 * message or an unbounded string out of the process.
 */
export function slateErrorTags(error: SlateErrorValue): Record<string, string> {
  const code = slateErrorWireCode(error)
  const definition = SLATE_ERROR_DEFINITIONS[code]
  const tags: Record<string, string> = {
    error_code: code,
    error_domain: definition.domain,
    error_retryable: String(definition.retryable),
  }
  if (code !== error.code) return tags
  const declared = new Set<string>(definition.payload)
  for (const [field, value] of Object.entries(error)) {
    if (field === "code" || value === undefined || !declared.has(field)) continue
    if (typeof value === "number" && Number.isFinite(value)) {
      tags[tagName(field)] = String(value)
    } else if (typeof value === "boolean") {
      tags[tagName(field)] = String(value)
    } else if (typeof value === "string" && BOUNDED_TAG_VALUE.test(value)) {
      tags[tagName(field)] = value
    }
  }
  return tags
}
