/** Create a runner context whose log sink is intentionally silent. */
import { createContext, type Context } from "../packages/context/context.ts";
import { loggerKey, type ContextLoggerBackend } from "../packages/context/logging.ts";

export function createRunnerContext(): Context {
  const logger: ContextLoggerBackend = { log: () => undefined };
  return createContext().with(loggerKey, logger);
}
