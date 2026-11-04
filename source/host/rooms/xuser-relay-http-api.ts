import { getSlateBackendClientHeaders } from "../../adapters/interop/backend/slate-client-metadata-adapter.ts";
import { SlateXuserRelayHttpError, type XuserRelayClientDependencies } from "./xuser-relay-contracts.ts";

type RelayHttpDependencies = Pick<XuserRelayClientDependencies, "getBackendUrl" | "getAccessToken" | "fetchImpl">;

/** The authenticated JSON transport shared by every room-relay route. */
export class XuserRelayHttpApi {
  readonly #fetch: typeof fetch;

  constructor(private readonly deps: RelayHttpDependencies) {
    this.#fetch = deps.fetchImpl ?? fetch;
  }

  async call<Result>(path: string, body: unknown): Promise<Result> {
    const backendUrl = this.deps.getBackendUrl();
    const token = await this.deps.getAccessToken({ backendUrl });
    const request = await this.#fetch(new URL(path, backendUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...getSlateBackendClientHeaders(),
      },
      body: JSON.stringify(body),
    });
    if (!request.ok) throw new SlateXuserRelayHttpError(request.status, path);
    return await request.json() as Result;
  }
}
