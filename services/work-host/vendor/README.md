# Work domain/protocol compatibility packages

The upstream Work workspace publishes `@slate/work-domain` and
`@slate/work-protocol` as sibling packages. This repository imports only the
Work host service, so the packages are vendored here as the minimal runtime
contracts the host actually imports:

- `work-domain` provides the recursive JSON value schema used by local-exec
  and task-progress messages, plus the widget schema/summary helper used by
  the runner and transcript projections.
- `work-protocol` is type-only at runtime; its declarations are intentionally
  empty because the host's gateway command catalogue is the executable wire
  contract.

These packages are private `file:` dependencies of `@slate/work-host`. They
are not published and must stay aligned with the Work host source. When the
full upstream workspace is available, replace this directory with the
published packages and remove the `file:` overrides.
