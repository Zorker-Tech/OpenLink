/**
 * Making a `sudo` that would otherwise stop and ask for a password work in a shell nobody is watching.
 *
 * A command that runs unattended has no terminal to answer sudo's prompt, so a machine that has been
 * configured with an askpass helper is used instead: every `sudo` at the start of a command — after `&&`,
 * `||`, `|` or `;`, or at the very beginning — is rewritten to pass the flag that makes sudo ask the helper.
 * A `sudo` that already carries that flag is left alone, and one that is not at a command position is left
 * alone too, since a `sudo` inside a quoted string or an argument is not the command being run.
 */

export const SUDO_ALIAS = "alias sudo='sudo -A'"
const isWindows = process.platform === "win32"
export const shouldEnableSudoAskpass = (env: NodeJS.ProcessEnv): boolean => !isWindows && Boolean(env.SUDO_ASKPASS)
export const getSudoAliasInjection = (env: NodeJS.ProcessEnv): string => shouldEnableSudoAskpass(env) ? `${SUDO_ALIAS}; ` : ""

/** Rewrites the `sudo` words that start a command so they ask the configured helper. */
export function transformSudoCommand(command: string): string {
  const result: string[] = []
  let index = 0
  while (index < command.length) {
    // A command starts at the beginning, after a separator, or after one followed by whitespace.
    const isCommandStart = index === 0 || command.slice(Math.max(0, index - 2), index) === "&&" || command.slice(Math.max(0, index - 2), index) === "||" || command[index - 1] === "|" || command[index - 1] === ";"
    const lookback = command.slice(Math.max(0, index - 10), index)
    const isAfterOperator = /(?:&&|\|\||[|;])\s*$/.test(lookback) || (index === 0 && /^\s*$/.test(lookback))
    if ((isCommandStart || isAfterOperator) && command.slice(index, index + 4) === "sudo") {
      const afterSudo = index + 4
      // The word has to end there, or it is a longer word that merely starts with sudo.
      if (afterSudo >= command.length || /\s/.test(command[afterSudo]!)) {
        let flagStart = afterSudo
        while (flagStart < command.length && /\s/.test(command[flagStart]!)) flagStart += 1
        let hasAFlag = false
        if (command[flagStart] === "-") {
          let flagEnd = flagStart + 1
          while (flagEnd < command.length && /[^\s]/.test(command[flagEnd]!)) flagEnd += 1
          hasAFlag = /^-[a-zA-Z]*A[a-zA-Z]*$/.test(command.slice(flagStart, flagEnd))
        }
        result.push(hasAFlag ? "sudo" : "sudo -A")
        index = afterSudo
        continue
      }
    }
    result.push(command[index]!)
    index += 1
  }
  return result.join("")
}
