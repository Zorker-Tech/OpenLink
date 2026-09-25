/**
 * The precheck that decides whether a web fetch may proceed before it is made.
 *
 * Every operation has two sides that must not be wired up by hand: the client calls it, the host runs it, and
 * the resource is the name that introduces them. This module is that name for this operation, together with
 * whatever the operation needs to be called and answered.
 */

import { SimpleControlledExecHandler } from "./controlled-exec.ts";
import type { WebFetchAllowlistPrecheckArgs, WebFetchAllowlistPrecheckResult } from "../proto/generated/agent/v1/web_fetch_allowlist_precheck_exec_pb.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "./executor-resources.ts";
import { createResource, type ControlledExecManager } from "./resource-provider.ts";
import { createClientDeserializer, createClientSerializer, createServerDeserializer, createServerSerializer } from "./exec-serialization.ts";

export const webFetchAllowlistPrecheckExecutorResource = createResource<Executor<WebFetchAllowlistPrecheckArgs, WebFetchAllowlistPrecheckResult>, RemoteExecManager, ControlledExecManager>(
  (execManager) => new ExecutorResource(execManager, createServerSerializer("webFetchAllowlistPrecheckArgs"), createClientDeserializer("webFetchAllowlistPrecheckResult")),
  (implementation, controlledExecManager) => controlledExecManager.register(new SimpleControlledExecHandler(implementation, createServerDeserializer("webFetchAllowlistPrecheckArgs"), createClientSerializer("webFetchAllowlistPrecheckResult"))),
);
