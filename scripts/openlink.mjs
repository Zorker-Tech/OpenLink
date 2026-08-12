// Root lifecycle entry point. The implementation remains in dev-browser.mjs
// for backward compatibility with existing local tooling, but all supported
// root commands now enter through this supervisor.
await import('./dev-browser.mjs')
