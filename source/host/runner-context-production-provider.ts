/**
 * The context the host's runner runs in.
 *
 * It is a plain context carrying a logger that keeps quiet — the host does its own logging, so the runner must not
 * add a second voice to it.
 */
import { createContext, type Context } from "../packages/context/context.ts";
import {
  getLoggerBackend,
  loggerKey,
  type ContextLoggerBackend,
} from "../packages/context/logging.ts";

export { getLoggerBackend, loggerKey };

export function createProductionRunnerContext(): Context {
  const silentLogger: ContextLoggerBackend = { log: () => {} };
  return createContext().with(loggerKey, silentLogger);
}
