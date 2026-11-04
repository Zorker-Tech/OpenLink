/** Bind the two read operations to the protocol cases used by the remote executor. */

import type { ReadArgs, ReadResult } from "../proto/generated/agent/v1/read_exec_pb.ts";
import { SimpleControlledExecHandler } from "./controlled-exec-manager-adapter.ts";
import { ExecutorResource, type Executor, type RemoteExecManager } from "../../../packages/agent-exec/executor-resources.ts";
import { createResource, type ControlledExecManager } from "../../../packages/agent-exec/resource-provider.ts";
import {
  createClientDeserializer,
  createClientSerializer,
  createServerDeserializer,
  createServerSerializer,
} from "./exec-message-adapter.ts";

export type ReadExecutorArgs = ReadArgs;
export type ReadExecutor = Executor<ReadExecutorArgs, ReadResult>;

function readResource(
  requestCase: "readArgs" | "redactedReadArgs",
  responseCase: "readResult" | "redactedReadResult",
) {
  return createResource<ReadExecutor, RemoteExecManager, ControlledExecManager>(
    manager => new ExecutorResource(
      manager,
      createServerSerializer(requestCase),
      createClientDeserializer(responseCase),
    ),
    (implementation, manager) => manager.register(new SimpleControlledExecHandler(
      implementation,
      createServerDeserializer(requestCase),
      createClientSerializer(responseCase),
    )),
  );
}

/** A read request whose result follows the ordinary read response case. */
export const readExecutorResource = readResource("readArgs", "readResult");

/** A privacy-filtered read carried in its own request and response cases. */
export const redactedReadExecutorResource = readResource("redactedReadArgs", "redactedReadResult");
