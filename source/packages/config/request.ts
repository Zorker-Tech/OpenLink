/**
 * How a request says it came from the local command line.
 *
 * The mode travels in the environment and as a header of its own, and it is only read when the process can be asked — so
 * a library that imports this cannot fail for the lack of a process.
 */

/** The environment variable the local command line sets. */
export const LOCAL_CLI_MODE_ENV = "CURSOR_AGENT_CLI_LOCAL_MODE";

/** The header a request carries when it was made from the local command line. */
export const LOCAL_CLI_MODE_HEADER = "local-cli-mode";

/** The one value that means the mode is on: the exact word, not a truthy string. */
const LOCAL_CLI_MODE_VALUE = "true";

/** Whether this process was started by the local command line. */
export const isLocalCliMode = (): boolean => typeof process !== "undefined" && process.env?.[LOCAL_CLI_MODE_ENV] === LOCAL_CLI_MODE_VALUE;

/** Mark a request as made from the local command line, when that is what it is. */
export const applyLocalCliModeHeader = (headers: Headers): void => {
  if (!isLocalCliMode()) return;
  headers.set(LOCAL_CLI_MODE_HEADER, LOCAL_CLI_MODE_VALUE);
};

/** The headers a request carries, with the local command line's own added when it applies. */
export const createLocalCliModeHeaders = <T extends Record<string, string> | undefined>(headers: T): T | (T & Record<string, string>) => {
  if (!isLocalCliMode()) return headers;
  return { ...headers, [LOCAL_CLI_MODE_HEADER]: LOCAL_CLI_MODE_VALUE } as T & Record<string, string>;
};
