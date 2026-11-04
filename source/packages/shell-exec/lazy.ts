/**
 * A shell that is only built when it is first used.
 *
 * Starting a shell means finding its binary, running it, reading its state back and writing a script into
 * it, which costs more than a command does and is wasted on a session that never runs one. So the executor
 * that the rest of the platform holds is a promise of one: the work happens on the first call, and every
 * caller after that waits for the same work rather than starting it again — which is also what keeps two
 * commands from racing to build two shells.
 *
 * Cloning is lazy in the same way, since a clone of a shell that has not been built yet is another promise.
 */

import { createSpan } from "../context/telemetry.ts";
import type { Context } from "../context/context.ts";
import type { TerminalEvent, TerminalExecuteOptions, TerminalExecutor } from "./naive.ts";

export class LazyTerminalExecutor implements TerminalExecutor {
  private readonly materialize: () => Promise<TerminalExecutor>;

  constructor(factory: () => Promise<TerminalExecutor>) {
    this.materialize = memoizedFactory(factory);
  }

  getExecutor(): Promise<TerminalExecutor> {
    return this.materialize();
  }

  async getCwd(): Promise<string> {
    const ready = await this.materialize();
    return ready.getCwd();
  }

  clone(workingDirectory?: string): TerminalExecutor {
    return new LazyTerminalExecutor(async () => (await this.materialize()).clone(workingDirectory));
  }

  async *execute(ctx: Context, command: string, options?: TerminalExecuteOptions): AsyncIterable<TerminalEvent> {
    using span = createSpan(ctx.withName("LazyTerminalExecutor.execute"));
    const ready = await this.materialize();
    yield* ready.execute(ctx, command, options);
  }
}

function memoizedFactory(factory: () => Promise<TerminalExecutor>): () => Promise<TerminalExecutor> {
  let pending: Promise<TerminalExecutor> | undefined;
  return () => {
    if (pending === undefined) pending = factory();
    return pending;
  };
}
