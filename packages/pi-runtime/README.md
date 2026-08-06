# Pinned Pi runtime artifacts

This directory is the build boundary between the pinned `services/pi`
submodule and OpenLink's Agent Workers. Run `pnpm agent:sync-pi` to build Pi
with its upstream release process, pack the Node.js SDK/CLI packages, and write
verified tarballs plus `manifest.json` under `tarballs/`.

The generated archives are local build artifacts. Worker lockfiles reference
their stable filenames, while `manifest.json` binds every archive to the Pi
submodule commit and a SHA-256 digest.
