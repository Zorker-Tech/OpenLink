# Chat Sessions Design

## Scope

Implement the route `/{user_id}/chat/{chat_sessions_id}` and the OpenLink chat workspace shown by Figma node `3:10307`. The session identifier is exactly 11 ASCII letters/digits and is generated server-side. URL parameters are routing data only; Supabase Auth and RLS remain the authority for access.

## Design direction

The recommended approach is a server-backed session with a client-rendered shell:

- The server action creates the session, chooses a collision-free 11-character ID, and redirects to the canonical route.
- The server page verifies the signed-in user, validates the ID format, loads the session and accessible workspace, and returns `notFound()` for invalid or foreign sessions.
- The client shell owns composer state, model selection, responsive sidebar state, and the existing light/dark preference.

Two alternatives were rejected: a purely client-generated ID would allow collisions and unowned URLs; a generic `/chat/[id]` route would not match the requested user-scoped URL contract.

## Figma translation

At the 1908×978 reference size, the shell is a 250px sidebar, a 49px application toolbar, a 390px chat column, and a flexible preview canvas. The preview canvas contains a centered 391px-wide, 835px-tall light iframe placeholder with a 12px radius. The chat composer is pinned to the bottom of the chat column at 373×42px. Existing OpenLink sidebar, workspace switcher, account drawer, theme scope, PromptInput, and ModelSelector primitives are reused.

The page is responsive: below the desktop breakpoint the sidebar becomes the existing mobile drawer, the chat column expands to the available width, and the preview canvas is hidden rather than forcing horizontal overflow.

## Data model

`openlink.chat_sessions` stores `id`, `user_id`, `workspace_id`, `title`, `initial_prompt`, and timestamps. RLS allows an authenticated user to read and mutate only their own sessions, and only when the referenced workspace is accessible to them. Organization membership can therefore scope the workspace without granting access to another member's private session.

## Error and security behavior

- Unauthenticated creation redirects to the existing login flow.
- Invalid user IDs, invalid session IDs, missing rows, and rows owned by another user return 404.
- The ID generator uses rejection sampling over a 62-character alphabet and retries unique conflicts.
- No service-role key or user-editable metadata is used for authorization.
