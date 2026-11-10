# Tmux-backed shell instructions contract

Commands that need interaction, follow-up input, later inspection, or continued execution use tmux. The bootstrap
command checks for the chosen session and creates it only when absent, detached in the current directory with a login
shell. It always names the host's tmux configuration and defaults to `descriptive-task-name` when no shared name is
provided.

Without a shared session, instructions use short descriptive session names. With one, ordinary setup and verification
work is routed through that session, reserving separate names for long-lived side processes. Both prompt renderers carry
the same core requirements, including attach and send-keys guidance and the rule that a zero wait uses a tmux-backed
session.
