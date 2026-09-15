# Platform SDK artifact boundary

OpenLink Cloud consumes the built Hydite product SDK, not files imported from an
adjacent repository and not Bifrost/Studio private implementation modules.

The normal build consumes the immutable `@vtslx/platform-sdk@0.2.0` release from
the internal Nexus consumer registry:

```sh
NPM_DOWNLOAD_REGISTRY=http://192.168.3.5:8081/repository/npm-public/
pnpm install --frozen-lockfile --registry "$NPM_DOWNLOAD_REGISTRY"
pnpm platform-sdk:verify
```

The lockfile records the exact version and SHA-512 integrity. npm/pnpm is used
at build time only; OpenLink startup never downloads a package. The local
`manifest.json` archive is retained only as a break-glass offline rollback:

```sh
node scripts/sync-platform-sdk.mjs --artifact /path/to/reviewed-package.tgz
pnpm install --offline --frozen-lockfile
node scripts/sync-platform-sdk.mjs --check
```

The tarball is generated release input under `tarballs/`, like the existing Pi
artifact boundary. It is not hand-edited source. Build/release delivery must supply
the matching archive before package installation. Ordinary startup never downloads
it, and Local mode never starts a cloud login or network request.

The registry release is internal and the local archive is not a second source of
truth. Replacing either requires a new immutable version, reviewed integrity
metadata and lockfile update. Retain the preceding archive for rollback. SDK
source of truth remains the AoAPI platform-sdk package; do not implement a fork
here.
