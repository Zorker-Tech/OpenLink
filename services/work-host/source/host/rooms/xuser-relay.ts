/** Public room relay client, composed from its HTTP routes and polling coordinator. */
import { XuserRelayHttpApi } from "./xuser-relay-http-api.ts";
import { XuserRelayPolling } from "./xuser-relay-polling.ts";
import { XuserRelayRoomRoutes } from "./xuser-relay-room-routes.ts";
import type { XuserRelayClientDependencies } from "./xuser-relay-contracts.ts";

export { describeRelayError } from "./xuser-relay-room-routes.ts";
export { SlateXuserRelayHttpError, XUSER_RELAY_ERROR_BACKOFF_MS, XUSER_RELAY_POLL_INTERVAL_MS } from "./xuser-relay-contracts.ts";
export type { XuserRelayClientDependencies } from "./xuser-relay-contracts.ts";

export class SlateXuserRelayClient {
  readonly #http: XuserRelayHttpApi;
  readonly #polling: XuserRelayPolling;
  readonly #routes: XuserRelayRoomRoutes;

  constructor(readonly deps: XuserRelayClientDependencies) {
    this.#http = new XuserRelayHttpApi(deps);
    this.#polling = new XuserRelayPolling(deps, (path, body) => this.call(path, body));
    this.#routes = new XuserRelayRoomRoutes((path, body) => this.call(path, body));
  }

  start(): void {
    this.#polling.start();
  }

  stop(): void {
    this.#polling.stop();
  }

  requestDrain(): void {
    this.#polling.requestDrain();
  }

  tick(): Promise<void> {
    return this.#polling.tick();
  }

  call<Result>(path: string, body: unknown): Promise<Result> {
    return this.#http.call(path, body);
  }

  createRoomFromAgent(args: unknown): Promise<Record<string, unknown>> {
    return this.#routes.createFromAgent(args);
  }

  createRoom<Result>(args: unknown): Promise<Result> {
    return this.#routes.create(args);
  }

  createRoomInvite(roomId: string): Promise<Record<string, unknown>> {
    return this.#routes.invite(roomId);
  }

  joinRoom(link: string): Promise<Record<string, unknown>> {
    return this.#routes.join(link);
  }

  respondToJoinRequest<Result>(args: unknown): Promise<Result> {
    return this.#routes.answerJoin(args);
  }

  addOwnAgent<Result>(args: unknown): Promise<Result> {
    return this.#routes.addAgent(args);
  }

  setRoomPicture<Result>(args: unknown): Promise<Result> {
    return this.#routes.changePicture(args);
  }

  removeOwnAgent<Result>(args: unknown): Promise<Result> {
    return this.#routes.removeAgent(args);
  }

  removeDeletedAgent<Result>(agentId: string): Promise<Result> {
    return this.#routes.forgetAgent(agentId);
  }

  leaveRoom<Result>(roomId: string, targetAuthId?: string): Promise<Result> {
    return this.#routes.leave(roomId, targetAuthId);
  }

  fetchShareState<Result>(): Promise<Result> {
    return this.#routes.fetchState();
  }

  send(payload: unknown): Promise<{ timestampMs?: number }> {
    return this.#routes.send(payload);
  }
}
