# ADR-0033: Keep upstream commit ancestry out of OpenLink history

- Status: Accepted
- Date: 2026-11-07
- Decision owners: OpenLink engineering
- Supersedes: the upstream-history-preservation choice in ADR-0002 and ADR-0032

## Context

OpenLink vendors complete upstream projects under `services/` so their source,
build files, licenses, and runtime metadata ship together. Importing each
upstream Git history with an ordinary subtree merge also makes its commit
authors appear in GitHub's OpenLink Contributors view, even though those people
did not contribute to OpenLink itself. Project contribution history and
third-party source attribution need separate records.

## Decision

- Keep the complete required upstream source trees in `services/`.
- Use `git subtree add --squash` for initial imports and
  `git subtree pull --squash` or `git subtree merge --squash` for updates. Do not
  attach upstream commit ancestry to OpenLink branches.
- Record the upstream URL and exact source revision in
  `services/source-revisions.json` or the component's upstream record.
- Keep each component's original copyright, license, `NOTICE`, and required
  attribution files. Flattening Git ancestry does not change ownership or
  licensing.
- Keep `git-subtree-dir` and `git-subtree-split` metadata needed to identify a
  component's prefix and pinned source revision. Squash-only import commits must
  not retain a `git-subtree-mainline` trailer that points to a removed merge
  parent.
- Do not use ordinary unsquashed subtree merges or merge an upstream branch
  directly into an OpenLink branch.

The public `dev` history was rewritten to remove upstream parent edges from
both the initial subtree imports and the later OpenSandbox upstream sync, while
preserving OpenLink commits and the exact file tree. This includes ordinary
merge commits that connect an upstream branch even when they do not carry
`git-subtree-*` trailers. Subsequent upstream updates must follow the squash
policy above.

## Consequences

### Positive

- OpenLink's GitHub contributor graph reflects commits in OpenLink's history,
  rather than all commits from vendored upstream projects.
- Upstream source remains reproducible from its URL and pinned revision, and
  license/attribution obligations remain represented in the repository.
- Squash metadata permits future upstream updates without reconnecting the
  upstream commit graph.

### Trade-offs

- The OpenLink history no longer contains each upstream project's individual
  commits. Readers use the recorded source URL and revision to inspect that
  history.
- A vendored directory rename requires an explicit subtree-prefix migration or
  rebaseline; the previous prefix cannot be assumed to remain updateable.
