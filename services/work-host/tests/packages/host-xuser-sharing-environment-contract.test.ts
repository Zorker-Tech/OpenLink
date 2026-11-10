import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isProductionBackendUrl,
  resolveXuserSharingEnvironment,
  SLATE_DEV_XUSER_SHARING_ENV,
  SLATE_XUSER_SHARING_ALLOW_PROD_ENV,
} from "../../source/host/rooms/xuser-sharing-environment.ts";

const productionBackend = "https://api.slate.invalid";
const developmentBackend = "https://staging.slate.invalid";

describe("cross-user sharing environment gate", () => {
  it("recognizes the production origin, ignores its path, and fails closed on invalid URLs", () => {
    assert.equal(isProductionBackendUrl(productionBackend), true);
    assert.equal(isProductionBackendUrl(`${productionBackend}/v2`), true);
    assert.equal(isProductionBackendUrl(developmentBackend), false);
    assert.equal(isProductionBackendUrl("not a URL"), true);
  });

  it("allows packaged builds while treating the developer-detail override as a dev build", () => {
    assert.deepEqual(resolveXuserSharingEnvironment({
      backendUrl: productionBackend,
      env: { SLATE_PACKAGED: "1" } as NodeJS.ProcessEnv,
    }), { isAllowed: true });

    const development = resolveXuserSharingEnvironment({
      backendUrl: productionBackend,
      env: { SLATE_PACKAGED: "1", SLATE_HOST_DEV_ERROR_DETAIL: "1" } as NodeJS.ProcessEnv,
    });
    assert.equal(development.isAllowed, false);
    assert.match(development.reason ?? "", new RegExp(SLATE_DEV_XUSER_SHARING_ENV));
  });

  it("requires a dev opt-in, then separately requires consent for the production origin", () => {
    const disabled = resolveXuserSharingEnvironment({ backendUrl: developmentBackend, env: {} as NodeJS.ProcessEnv });
    assert.equal(disabled.isAllowed, false);
    assert.match(disabled.reason ?? "", new RegExp(SLATE_DEV_XUSER_SHARING_ENV));

    const staging = resolveXuserSharingEnvironment({
      backendUrl: developmentBackend,
      env: { [SLATE_DEV_XUSER_SHARING_ENV]: "1" } as NodeJS.ProcessEnv,
    });
    assert.deepEqual(staging, { isAllowed: true });

    const productionWithoutSecondOptIn = resolveXuserSharingEnvironment({
      backendUrl: productionBackend,
      env: { [SLATE_DEV_XUSER_SHARING_ENV]: "1" } as NodeJS.ProcessEnv,
    });
    assert.equal(productionWithoutSecondOptIn.isAllowed, false);
    assert.match(productionWithoutSecondOptIn.reason ?? "", new RegExp(SLATE_XUSER_SHARING_ALLOW_PROD_ENV));

    const productionWithBothOptIns = resolveXuserSharingEnvironment({
      backendUrl: productionBackend,
      env: {
        [SLATE_DEV_XUSER_SHARING_ENV]: "1",
        [SLATE_XUSER_SHARING_ALLOW_PROD_ENV]: "1",
      } as NodeJS.ProcessEnv,
    });
    assert.deepEqual(productionWithBothOptIns, { isAllowed: true });
  });
});
