export const UNBOUND_EXECUTION_MESSAGE = "Slate turn execution is not bound: the host asked for a runner before the composition root handed the turn-execution extension its executor.";
export const DOUBLE_BIND_MESSAGE = "Slate turn execution is already bound: a second executor would mint a second runner for the same agent.";

export interface TurnExecutor {
  isInferenceReady(): Promise<boolean>;
  createRunner(session: unknown, hooks: unknown): unknown;
  createGroupMemberRunner(session: unknown, hooks: unknown, overrides: unknown): unknown;
}

/** The refusal both halves of the bound-once rule share; they differ only in what the host is told. */
function refuse(message: string): never {
  throw new Error(message);
}

/**
 * The executor a host's turns run on, bound once.
 *
 * The composition root hands the extension its executor exactly once: asking for a runner before that is refused, and
 * binding a second executor is refused too, since it would mint a second runner for the same agent.
 */
export class TurnExecutionRegistry {
  private executor: TurnExecutor | undefined;

  /** Bind the one executor this registry will ever have; a second one is a composition error. */
  bindExecutor(executor: TurnExecutor): void {
    if (this.canExecute) refuse(DOUBLE_BIND_MESSAGE);
    this.executor = executor;
  }

  /** Whether the composition root has handed the executor over yet. */
  get canExecute(): boolean {
    return this.executor !== undefined;
  }

  /** Whether a turn could run now: without an executor it could not, and with one the executor answers. */
  async isRunReady(): Promise<boolean> {
    const executor = this.executor;
    return executor === undefined ? false : await executor.isInferenceReady();
  }

  createRunner(session: unknown, hooks: unknown): unknown {
    const executor = this.require();
    return executor.createRunner(session, hooks);
  }

  createGroupMemberRunner(session: unknown, hooks: unknown, overrides: unknown): unknown {
    const executor = this.require();
    return executor.createGroupMemberRunner(session, hooks, overrides);
  }

  /** The bound executor, or the refusal a host gets for asking for a runner too early. */
  private require(): TurnExecutor {
    const executor = this.executor;
    if (executor === undefined) refuse(UNBOUND_EXECUTION_MESSAGE);
    return executor;
  }
}
