/** Slate's request and event contract for cancellable, observable shell execution. */

import type { StreamExecutor } from "./executor-resources.ts";
import type { ShellStreamArgs } from "../local-exec/shell-stream-contracts.ts";
import type { LocalShellStreamEvent } from "../local-exec/shell-stream-events.ts";

export type ShellStreamExecutorArgs = ShellStreamArgs;
export type ShellStreamExecutorEvent = LocalShellStreamEvent;
export type ShellStreamExecutor = StreamExecutor<ShellStreamExecutorArgs, ShellStreamExecutorEvent>;

export { shellStreamExecutorResource } from "../../adapters/interop/agent/shell-stream-exec-adapter.ts";
