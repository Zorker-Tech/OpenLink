# agent-desktop vendoring record

- Upstream: <https://github.com/vercel-labs/agent-desktop>
- Version: `1.0.2`
- Imported commit: `9eb9b296192fcb70bda25e918cd6dd66abfa3d0d`
- License: Apache-2.0 (`LICENSE`)
- Import method: `git subtree add --prefix=services/agent-desktop`
  with the full upstream history (no squash, no nested `.git`, no submodule).
- Local source changes: none.

The upstream Cargo workspace is kept independently buildable and is not part of
the root pnpm/Next.js workspace.

OpenLink packages the pinned Linux x86_64 release archive into the T2 Project
VM base image:

- archive: `agent-desktop-v1.0.2-x86_64-unknown-linux-gnu.tar.gz`
- archive SHA-256:
  `d4f57bb0a8e86c96b2e3dff96c2875d56cb737dc2dccc177784cf520eefa6310`
- installed paths: `/usr/local/bin/agent-desktop` and
  `/usr/local/bin/agent-desktop-linux-clipboard-owner`
- runtime requirement: the Ubuntu GNOME session's AT-SPI bus under
  `/run/user/1000`, which `openlink-desktop.service` starts for the project
  desktop.

The upstream `LICENSE` is retained at the root of this directory. The release
archive's Apache-2.0 license is also installed in the T2 image under
`/usr/share/doc/agent-desktop/LICENSE`.
