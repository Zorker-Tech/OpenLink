/**
 * The shell execution package's surface.
 *
 * Everything a caller needs to run a command in a shell: the executor that chooses a shell and the shells it
 * can choose, the parser that reads a command before it runs, the sandbox a command runs inside, and the
 * types they share. It is a barrel rather than a place with behaviour of its own, so what it lists is what
 * the package offers.
 */

export * from "./naive.ts"
export * from "./shell-parser.ts"
export * from "./types.ts"
export * from "./bash.ts"
export * from "./powershell.ts"
export * from "./zsh.ts"
export * from "./zsh-light.ts"
export * from "./core.ts"
