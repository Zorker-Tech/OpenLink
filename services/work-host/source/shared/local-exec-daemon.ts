/**
 * The files a local-exec daemon and its supervisor are discovered through, and how long a window counts as supervised.
 */

/** Every daemon file is one of the platform's own JSON files, named by what it carries. */
const DAEMON_FILE_PREFIX = "local-exec-";
const JSON_SUFFIX = ".json";

/** The file a running daemon publishes its connection through. */
export const LOCAL_EXEC_DAEMON_CONNECTION_FILENAME = `${DAEMON_FILE_PREFIX}daemon-connection${JSON_SUFFIX}`;

/** The file a daemon publishes its discovery record through. */
export const LOCAL_EXEC_DAEMON_DISCOVERY_FILENAME = `${DAEMON_FILE_PREFIX}daemon${JSON_SUFFIX}`;

/** The file the daemon reads its credential from. */
export const LOCAL_EXEC_DAEMON_CREDENTIAL_FILENAME = `${DAEMON_FILE_PREFIX}daemon-credential${JSON_SUFFIX}`;

/** The file the supervisor's heartbeat is read from. */
export const LOCAL_EXEC_SUPERVISOR_HEARTBEAT_FILENAME = `${DAEMON_FILE_PREFIX}supervisor${JSON_SUFFIX}`;

/** How long after its last heartbeat a supervised daemon still counts as supervised. */
export const SLATE_LOCAL_EXEC_SUPERVISED_WINDOW_MS = 90_000;
