/** Bind conversation-search calls to their generated executor message cases. */

import type {
  ConversationSearchArgs,
  ConversationSearchResult,
} from "../proto/generated/agent/v1/conversation_search_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export const conversationSearchExecutorResource = createResource<
  Executor<ConversationSearchArgs, ConversationSearchResult>,
  RemoteExecManager,
  ControlledExecManager
>(
  (manager) => new ExecutorResource(
    manager,
    createServerSerializer("conversationSearchArgs"),
    createClientDeserializer("conversationSearchResult"),
  ),
  (implementation, manager) => manager.register(new SimpleControlledExecHandler(
    implementation,
    createServerDeserializer("conversationSearchArgs"),
    createClientSerializer("conversationSearchResult"),
  )),
);
