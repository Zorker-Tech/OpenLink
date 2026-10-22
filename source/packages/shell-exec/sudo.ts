/**
 * Making a `sudo` that would otherwise stop and ask for a password work in a shell nobody is watching.
 *
 * A command that runs unattended has no terminal to answer sudo's prompt, so a machine that has been
 * configured with an askpass helper is used instead: every `sudo` at the start of a command — after `&&`,
 * `||`, `|` or `;`, or at the very beginning — is rewritten to pass the flag that makes sudo ask the helper.
 * A `sudo` that already carries that flag is left alone, and one that is not at a command position is left
 * alone too, since a `sudo` inside a quoted string or an argument is not the command being run.
 */

export const SUDO_ALIAS = "alias sudo='sudo -A'";

const isWindows = process.platform === "win32";

/** Whether this machine can answer sudo's prompt without a terminal. */
export const shouldEnableSudoAskpass = (env: NodeJS.ProcessEnv): boolean => !isWindows && Boolean(env.SUDO_ASKPASS);

/** What a shell is given before the command, so its own `sudo` asks the helper. */
export const getSudoAliasInjection = (env: NodeJS.ProcessEnv): string => (shouldEnableSudoAskpass(env) ? `${SUDO_ALIAS}; ` : "");

/** The word itself, and the flag that makes it ask the helper. */
const SUDO = "sudo";
const ASKPASS_FLAGS = "-A";

/** The separators a command may start after. */
const OPERATOR_BEFORE = /(?:&&|\|\||[|;])\s*$/;

/** Whether this position is where a command begins: the start of the line, or after a separator. */
function startsACommand(command: string, index: number): boolean {
  if (index === 0) return true;
  if (command[index - 1] === "|" || command[index - 1] === ";") return true;
  return OPERATOR_BEFORE.test(command.slice(Math.max(0, index - 10), index));
}

/** The flags a sudo was given, read from the text just after it, or nothing when it was given none. */
function flagsAfter(command: string, from: number): string | null {
  let at = from;
  while (at < command.length && /\s/.test(command[at]!)) at += 1;
  if (command[at] !== "-") return null;
  let end = at + 1;
  while (end < command.length && !/\s/.test(command[end]!)) end += 1;
  return command.slice(at, end);
}

/** Whether these flags already carry the one that makes sudo ask the helper, however they are written. */
function carriesAskpassFlag(flags: string | null): boolean {
  return flags !== null && /^-[a-zA-Z]*A[a-zA-Z]*$/.test(flags);
}

/**
 * Rewrites the `sudo` words that start a command so they ask the configured helper.
 *
 * Everything else — a `sudo` in an argument, a longer word that begins with it, a command that already asked — is
 * copied through as it was written.
 */
export function transformSudoCommand(command: string): string {
  const written: string[] = [];
  let index = 0;
  while (index < command.length) {
    const isSudoWord = command.slice(index, index + SUDO.length) === SUDO && (index + SUDO.length >= command.length || /\s/.test(command[index + SUDO.length]!));
    if (isSudoWord && startsACommand(command, index)) {
      const afterSudo = index + SUDO.length;
      written.push(carriesAskpassFlag(flagsAfter(command, afterSudo)) ? SUDO : `${SUDO} ${ASKPASS_FLAGS}`);
      index = afterSudo;
      continue;
    }
    written.push(command[index]!);
    index += 1;
  }
  return written.join("");
}
