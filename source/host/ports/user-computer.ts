/**
 * The user's own computer as a box.
 *
 * A user has one computer, and it is addressed by the platform's own id: what is listed is that one machine, and a
 * request for it resolves only while it is connected — a request for anything else, or for a machine that is not there,
 * resolves to nothing rather than to a guess.
 */
export const DEFAULT_SLATE_COMPUTER_ID = "this-computer";
export function createSingleUserComputer<Box>(args: { box: Box; label?: string; isConnected?: () => boolean }) { const id = DEFAULT_SLATE_COMPUTER_ID; const label = args.label ?? "this computer"; const connected = () => args.isConnected?.() ?? true; return { list: () => [{ id, label, connected: connected() }], resolve: (requestedId?: string) => requestedId !== undefined && requestedId !== id || !connected() ? undefined : { id, label, box: args.box } }; }
