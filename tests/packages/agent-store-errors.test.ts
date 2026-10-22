import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as errors from "../../source/packages/agent-store-sync/bcs-client.ts";
import {
  AgentStoreDirectoryListingError,
  AgentStoreProtocolError,
  AgentStoreUnauthorizedError,
} from "../../source/packages/agent-store-sync/bcs-client.ts";

const classes = [AgentStoreUnauthorizedError, AgentStoreDirectoryListingError, AgentStoreProtocolError];

describe("the errors a store operation raises", () => {
  it("are three classes with the names a caller switches on", () => {
    assert.deepEqual(Object.keys(errors).sort(), ["AgentStoreDirectoryListingError", "AgentStoreProtocolError", "AgentStoreUnauthorizedError"]);
    assert.deepEqual(classes.map((errorClass) => errorClass.name), ["AgentStoreUnauthorizedError", "AgentStoreDirectoryListingError", "AgentStoreProtocolError"]);
    assert.deepEqual(classes.map((errorClass) => new errorClass("x").name), ["AgentStoreUnauthorizedError", "AgentStoreDirectoryListingError", "AgentStoreProtocolError"]);
    assert.equal(new Set(classes.map((errorClass) => new errorClass("x").name)).size, 3);
  });

  it("are Errors that say what happened", () => {
    for (const errorClass of classes) {
      const error = new errorClass("something went wrong");
      assert.equal(error instanceof Error, true);
      assert.equal(error.message, "something went wrong");
      assert.equal(error.constructor, errorClass);
      assert.equal(String(error), `${errorClass.name}: something went wrong`);
      // The name is an own, enumerable property, as it is on an error the platform names.
      assert.deepEqual(Object.getOwnPropertyDescriptor(error, "name"), { value: errorClass.name, writable: true, enumerable: true, configurable: true });
      assert.deepEqual(Object.getPrototypeOf(Object.getPrototypeOf(error)), Error.prototype);
    }
  });

  it("give an unauthorized token a default message, and take a message otherwise", () => {
    assert.equal(new AgentStoreUnauthorizedError().message, "Agent store token is unauthorized");
    assert.equal(new AgentStoreUnauthorizedError("the token was revoked").message, "the token was revoked");
    assert.equal(new AgentStoreUnauthorizedError(undefined).message, "Agent store token is unauthorized");
    assert.equal(new AgentStoreDirectoryListingError("the listing failed").message, "the listing failed");
    assert.equal(new AgentStoreProtocolError("the body was not a body").message, "the body was not a body");
  });

  it("do not answer for one another", () => {
    const unauthorized = new AgentStoreUnauthorizedError();
    assert.equal(unauthorized instanceof AgentStoreUnauthorizedError, true);
    assert.equal(unauthorized instanceof AgentStoreDirectoryListingError, false);
    assert.equal(unauthorized instanceof AgentStoreProtocolError, false);
  });
});
