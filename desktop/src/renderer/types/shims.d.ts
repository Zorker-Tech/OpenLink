/// <reference types="vite/client" />

declare module '*.css'

/**
 * `server-only` is a build-time marker with no runtime behavior. The desktop
 * type-check follows type-only imports into shared server modules; declaring
 * the marker keeps the check focused on contract shape rather than bundler
 * semantics.
 */
declare module 'server-only'

declare module '@novnc/novnc'
