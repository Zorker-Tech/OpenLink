// The release builder and the guest controller share one verifier. The
// Containerfile installs the implementation from scripts/lib next to the
// controller; this source-tree facade keeps tests/imports on that same code.
export * from '../../scripts/lib/project-supabase-bundle.mjs'
