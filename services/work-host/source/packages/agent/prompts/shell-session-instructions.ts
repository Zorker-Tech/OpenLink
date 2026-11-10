/**
 * What the agent is told about shell sessions that outlive one command.
 *
 * A command that starts a dev server, waits for input, or has to be inspected later cannot be a
 * one-shot process: it has to live somewhere the agent — and the user — can come back to. tmux is that
 * somewhere, and the instructions exist because the alternative is silently wrong: a backgrounded
 * process looks like it worked and is gone by the next command.
 *
 * Where the environment keeps one shared session, ordinary work is routed through it and only genuinely
 * long-lived side processes get names of their own; where it does not, every session is named for what
 * it is doing. The bootstrap command is written to be safe to run repeatedly, since starting or reusing
 * a session is the same instruction.
 */

import { jsx, jsxs, type PromptNode } from "../../prompt-jsx/index.ts"

const DEFAULT_SESSION_NAME = "descriptive-task-name"

export function getTmuxBootstrapCommand(options: { readonly sharedSessionName?: string } = {}): string {
  const sessionName = options.sharedSessionName ?? DEFAULT_SESSION_NAME
  return `SESSION_NAME="${sessionName}"; tmux -f /exec-daemon/tmux.portal.conf has-session -t "=$SESSION_NAME" 2>/dev/null || tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESSION_NAME" -c "$PWD" -- "\${SHELL:-zsh}" -l`
}

function namingGuidance(sharedSessionName: string | undefined): string {
  if (sharedSessionName === undefined) {
    return "Use a descriptive tmux session name for the task or command instead of a single global shared name. Prefer short kebab-case names such as `vite-dev-server`, `backend-tests`, or `db-migration`."
  }
  return `There is one canonical shared tmux session for most recurring shell work — \`${sharedSessionName}\`. Start or reuse that session before ordinary setup work, then use it for every install, build, migration, version check, and verification command. Only create a separate descriptively-named session (short kebab-case, e.g. \`vite-dev-server\`, \`backend-tests\`, \`postgres\`) for long-running side processes that must keep running after a single command finishes. Do NOT invent a new per-task session name for ordinary shell work — route it through \`${sharedSessionName}\`.`
}

export function getTmuxBackedShellSessionsSectionText(options: { readonly sharedSessionName?: string } = {}): string {
  return `<tmux-backed-shell-sessions>
- tmux is the required mechanism for shell work that may outlive a single command. If you need an interactive shell, any background command (such as starting dev servers), a long-running process, follow-up input, later inspection, or a shared session that you or the user may reconnect to later, you MUST use tmux. Do NOT launch those workflows as one-shot background processes. If you are planning to set block_until_ms to 0, you should ALWAYS back this session with tmux.
- On the VM, invoke tmux with \`-f /exec-daemon/tmux.portal.conf\`. If that config path is unavailable, fall back to the same command without \`-f\`.
- ${namingGuidance(options.sharedSessionName)}
- Start or reuse the appropriate session by running \`${getTmuxBootstrapCommand(options)}\`.
- Before creating a new session, list existing sessions with \`tmux -f /exec-daemon/tmux.portal.conf ls\` and reuse an existing one when appropriate.
- To inspect or continue work in an existing session, attach with \`tmux -f /exec-daemon/tmux.portal.conf attach-session -t "$SESSION_NAME"\`.
- To send input to a session without attaching, run \`tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESSION_NAME:0.0" 'your command here' C-m\`.
</tmux-backed-shell-sessions>`
}

export function TmuxBackedShellInstructions(options: { readonly sharedSessionName?: string } = {}): PromptNode {
  return jsxs("li", {
    children: [
      "tmux is the required mechanism for shell work that may outlive a single command. If you need an interactive shell, any background command (such as starting dev servers), a long-running process, follow-up input, later inspection, or a shared session that you or the user may reconnect to later, you MUST use tmux. Do NOT launch those workflows as one-shot background processes. If you are planning to set block_until_ms to 0, you should ALWAYS back this session with tmux.",
      jsxs("ul", {
        children: [
          jsx("li", { children: "On the VM, invoke tmux with `-f /exec-daemon/tmux.portal.conf`. If that config path is unavailable, fall back to the same command without `-f`." }),
          jsx("li", { children: namingGuidance(options.sharedSessionName) }),
          jsxs("li", { children: ["Start or reuse the appropriate session by running", " ", `\`${getTmuxBootstrapCommand(options)}\``, "."] }),
          jsx("li", { children: "Before creating a new session, list existing sessions with `tmux -f /exec-daemon/tmux.portal.conf ls` and reuse an existing one when appropriate." }),
          jsx("li", { children: 'To inspect or continue work in an existing session, attach with `tmux -f /exec-daemon/tmux.portal.conf attach-session -t "$SESSION_NAME"`.' }),
          jsx("li", { children: "To send input to a session without attaching, run `tmux -f /exec-daemon/tmux.portal.conf send-keys -t \"$SESSION_NAME:0.0\" 'your command here' C-m`." }),
        ],
      }),
    ],
  })
}
