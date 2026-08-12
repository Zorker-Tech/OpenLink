// Compatibility path for local development and older launch specifications.
// Immutable worker images copy the canonical extension from
// services/agent-browser-extension into their own node_modules scope.
export { default } from '../../agent-browser-extension/openlink-browser.ts'
