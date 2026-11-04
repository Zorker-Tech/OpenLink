import { exchangeApiKeyForTokens } from "./login-api-key.ts";
import { generateAuthParams } from "./login-link.ts";
import { pollAuthenticationStatus } from "./login-polling.ts";
import {
  resolveApiBaseUrl,
  resolveWebsiteUrl,
  type CursorTokens,
  type ExchangeApiKeyOptions,
  type LoginLinkHandler,
  type LoginManagerOptions,
  type LoginMetadata,
} from "./login-contracts.ts";

/** The caller that opens a browser keeps control of its own window and follows the resulting token flow. */
export class LoginManager {
  readonly redirectTarget: string;
  readonly apiUrl: string;
  readonly websiteUrl: string;

  constructor(options: LoginManagerOptions = {}) {
    this.redirectTarget = options.redirectTarget ?? "cli";
    this.apiUrl = resolveApiBaseUrl(options.apiUrl);
    this.websiteUrl = resolveWebsiteUrl(options.websiteUrl);
  }

  startLogin(): { metadata: LoginMetadata; loginUrl: string } {
    const browserFlow = generateAuthParams(this.redirectTarget, this.websiteUrl);
    return {
      metadata: { uuid: browserFlow.uuid, verifier: browserFlow.verifier },
      loginUrl: browserFlow.loginUrl,
    };
  }

  waitForResult(metadata: LoginMetadata, signal?: AbortSignal): Promise<CursorTokens | null> {
    return pollAuthenticationStatus({
      uuid: metadata.uuid,
      verifier: metadata.verifier,
      apiBaseUrl: this.apiUrl,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  loginWithApiKey(apiKey: string, options?: ExchangeApiKeyOptions): Promise<CursorTokens | null> {
    return exchangeApiKeyForTokens(apiKey, { endpoint: options?.endpoint ?? this.apiUrl });
  }

  async login(linkHandler: LoginLinkHandler, signal?: AbortSignal): Promise<CursorTokens | null> {
    const { metadata, loginUrl } = this.startLogin();
    await linkHandler.openUrl(loginUrl);
    return await this.waitForResult(metadata, signal);
  }
}
