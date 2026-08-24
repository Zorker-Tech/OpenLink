# Project Supabase runtime

This directory defines the upstream Supabase backend embedded in every Project
VM. It is not ZOKERBASE and must not import, copy, query or share secrets with
the OpenLink control plane.

`runtime.lock.json` pins one complete official `self-hosted/v*` release,
configuration and all amd64/arm64 platform manifests. `release-trust.json`
contains only Ed25519 public release keys used by a Project VM to authenticate
offline upgrade bundles. Release private keys never enter this repository or a
Golden Image.

This directory defines the upstream Supabase release embedded in OpenLink
Project VM Golden Images. It is intentionally independent from `backend/` and
ZOKERBASE. ZOKERBASE is the OpenLink control plane; this runtime is one
application backend per Project VM.

`runtime.lock.json` is the reviewed release authority. It records:

- the stable upstream `self-hosted/vX.Y.Z` annotated tag object and peeled Git
  commit;
- hashes of the exact official `docker/` configuration tree and upgrade
  manifest;
- the complete default self-hosted service set;
- immutable Linux `amd64` and `arm64` platform manifest digests;
- upstream breaking-change and migration gates.

To propose the newest stable upstream release:

```bash
pnpm runtime:project-supabase:sync -- --update-lock
```

Review the upstream changelog, configuration diff, image digest changes and
upgrade gates before committing the lock. Formal artifact production runs the
same command without `--update-lock`; it fails if upstream content differs from
the reviewed lock.

Generated configuration and OCI artifacts live under
`.openlink-runtime/project-supabase/`. They are release state, not source, and
must not be committed. Project VM startup never contacts an image registry.
