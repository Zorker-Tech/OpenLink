/** Public room-sharing coordinator for turns that cross between different hosts. */
import { RemoteTurnInboundRequests } from "./xuser-remote-turn-inbound.ts";
import { RemoteTurnOutboundRequests } from "./xuser-remote-turn-outbound.ts";
import {
  type RemoteMemberTurnArgs,
  type RemoteTurnsHost,
  type SharedRoom,
} from "./xuser-remote-turn-contracts.ts";

export {
  REMOTE_MEMBER_UNREACHABLE_BACKOFF_MS,
  REMOTE_TURN_BUDGET_MAX,
  REMOTE_TURN_BUDGET_WINDOW_MS,
} from "./xuser-remote-turn-contracts.ts";
export type { RemoteMemberTurnArgs, RemoteTurnsHost, SharedRoom } from "./xuser-remote-turn-contracts.ts";

export class SlateXuserRemoteTurns {
  readonly #inbound: RemoteTurnInboundRequests;
  readonly #outbound: RemoteTurnOutboundRequests;

  constructor(readonly host: RemoteTurnsHost) {
    this.#inbound = new RemoteTurnInboundRequests(host);
    this.#outbound = new RemoteTurnOutboundRequests(host);
  }

  stop(): void {
    this.#outbound.stop();
    this.#inbound.stop();
  }

  handleTurnRequest(event: Record<string, unknown>): boolean {
    return this.#inbound.handleRequest(event);
  }

  runRequestedTurn(event: Record<string, unknown>, room: SharedRoom): Promise<void> {
    return this.#inbound.runRequestedTurn(event, room);
  }

  handleTurnResult(event: Record<string, unknown>): boolean {
    return this.#outbound.handleResult(event);
  }

  runRemoteMemberTurn(args: RemoteMemberTurnArgs): Promise<string[]> {
    return this.#outbound.run(args);
  }
}
