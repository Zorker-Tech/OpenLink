# ZOKERBASE upstream source snapshot

This directory is a sparse vendored snapshot of
<https://github.com/supabase/supabase> at commit:

`5b68af1720454884faa18eee16cc2af5aa093181`

Included paths are the official `docker/` self-hosted runtime,
`apps/studio/`, and Studio's transitive internal workspace packages. The
Supabase www/docs/marketing applications are intentionally excluded.

ZOKERBASE retains this source snapshot for compatibility review and image
production. Runtime startup layers `docker/docker-compose.zokerbase.yml` over
the upstream topology and consumes only OpenLink-owned `zokerbase/*` images.
The first local bootstrap produces the immutable product image artifact under
`.openlink-runtime/zokerbase/images`; subsequent starts use `--pull never` and
do not resolve upstream container images.

To update, clone the upstream repository outside this worktree, sparse-check
the same paths, review `docker/CHANGELOG.md` and `docker/versions.md`, then copy
the reviewed snapshot into `backend/` and update the commit above.
