/** The lightweight state script used when a shell's functions should stay local to each command. */
export const ZSH_STATE_LIGHT_MARKER = "__SLATE_ZSH_STATE_LIGHT_VALID__";

const lightSnapshotScript = String.raw`#!/usr/bin/env zsh

function dump_zsh_state_light() {
  emulate -L zsh -o errreturn -o pipefail
  set -u

  local started_at step_started
  if [[ -n "\${DUMP_ZSH_STATE_TIMING:-}" ]]; then
    started_at="\${EPOCHREALTIME}"
    step_started="\${EPOCHREALTIME}"
    _slate_log_timing() {
      local step_name="$1"
      local now="\${EPOCHREALTIME}"
      local step_duration=$((now - step_started))
      local total_duration=$((now - started_at))
      builtin printf "[TIMING] %-20s: %6.3fs (total: %6.3fs)\n" "$step_name" "$step_duration" "$total_duration" >&2
      step_started="$now"
    }
  else
    _slate_log_timing() { :; }
  fi

  builtin zmodload -F zsh/parameter p:parameters p:options p:aliases p:galiases p:saliases 2>/dev/null || true
  _slate_log_timing "zmodload"

  _slate_emit() {
    builtin print -r -- "$1"
  }

  _slate_emit_encoded() {
    local content="$1"
    local variable_name="$2"
    if [[ -n "$content" ]]; then
      builtin printf "slate_state_%s=\$(command base64 -d <<'SLATE_STATE_EOF_%s'\n" "$variable_name" "$variable_name"
      command base64 <<<"$content" | command tr -d '\n'
      builtin printf '\nSLATE_STATE_EOF_%s\n)\n' "$variable_name"
      builtin printf 'builtin eval "$slate_state_%s"\n' "$variable_name"
    fi
  }

  _slate_log_timing "initialization"
  _slate_emit "__SLATE_ZSH_STATE_LIGHT_VALID__"
  _slate_emit "$PWD"
  _slate_emit "# Slate light-shell snapshot created on $(command date +'%Y-%m-%d %H:%M:%S %z')"
  _slate_log_timing "header"

  _slate_log_timing "working directory"
  local exported_state
  exported_state=$(builtin typeset -xp 2>/dev/null | command grep -viE '_proxy=|SLATE_SANDBOX|SUDO_ASKPASS|SLATE_ASKPASS|SLATE_CONVERSATION_ID|SLATE_AGENT_STORE' || true)
  _slate_emit_encoded "$exported_state" "ENV_VARS_B64"
  _slate_log_timing "environment"

  local reusable_options
  reusable_options=$(setopt 2>/dev/null | command grep -vE '^(errreturn|nounset|pipefail)$' | command awk '{printf "builtin setopt %s 2>/dev/null || true\\n", $0}' || true)
  _slate_emit_encoded "$reusable_options" "ZSH_OPTS_B64"
  _slate_log_timing "options"

  # Functions stay in the shell that defined them; this variant only carries simple aliases.
  {
    builtin alias -L 2>/dev/null || true
    builtin alias -gL 2>/dev/null || true
    builtin alias -sL 2>/dev/null || true
  }
  _slate_log_timing "aliases"

  _slate_emit "# end of Slate light-shell snapshot"
  _slate_log_timing "complete"
}
`;

const lightSnapshot = lightSnapshotScript.replace(/\\\$\{/g, "${");

export default lightSnapshot;
