# Local workspace runtime hint

Superseding user correction: the prompt must not carry runtime or success hints. Goal, Plan, queued work, paused state, and recoverable errors belong above the input; successful permission/plugin operations stay silent.

- Reuse `projectRuntimeDisplay` and existing 2.5-second server refresh; no synthetic progress or changes to provisioning/readiness policy.
- Keep the input body empty until the user types. Runtime readiness still disables submission, but no status or success copy is associated with the textarea.
- Preserve draft state across runtime refreshes and control operations.
- Remove the separate status/details card from the home composer. Keep submit errors and project selector behavior intact.

Verification target: the focused Node test and production WorkspacePrompt story assert that queued and starting runtimes expose no input hint, readiness still gates input availability, and drafts survive refresh. The authenticated chat must show Goal/Plan/error/queue state above the composer and no success notice below it.
