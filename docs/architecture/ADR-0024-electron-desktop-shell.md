# ADR-0024: Keep Electron as a thin desktop shell

## Status

Accepted

## Context

OpenLink already provides product screens, authentication, and server-side
backend access through its Next.js Web/BFF application. A desktop entry point
is useful, but duplicating product screens or privileged service access in a
second renderer would create another application boundary to maintain.

## Decision

The Electron package is a thin shell around the existing OpenLink Web/BFF.
It has its own Vite build and loads the URL configured by
`OPENLINK_DESKTOP_URL`, defaulting to `http://127.0.0.1:3000`. The renderer
only forwards to that URL; product screens and backend calls remain in the
existing Next.js application.

The shell uses an isolated, sandboxed renderer with Node integration disabled.
It exposes no backend credentials or general Electron APIs to the loaded page.
Starting or building the shell does not start or replace the OpenLink
application lifecycle. Local development starts the full stack with
`pnpm dev:local`, then starts the shell separately with `pnpm desktop:dev`.

## Consequences

- Browser and desktop use the same authentication, UI, and Web/BFF routes.
- The desktop package can be built independently without merging its
  dependencies into the root Next.js dependency graph.
- Desktop operation depends on a reachable OpenLink Web/BFF URL.
- Native desktop-only features require an explicit, narrowly scoped bridge and
  a separate security review.

## Alternatives considered

- Rebuild product screens in an Electron renderer: rejected because it would
  fork UI and authentication behavior.
- Give the renderer direct service credentials: rejected because those
  credentials belong to the server-side Web/BFF and owned services.
