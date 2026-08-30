# Chat Sessions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add authenticated, persisted 11-character chat sessions at `/{user_id}/chat/{chat_sessions_id}` and render the Figma chat workspace.

**Architecture:** A server action creates a row in `openlink.chat_sessions` and returns the canonical route. The dynamic server page validates the current Supabase user and session ownership before rendering a client chat shell that reuses OpenLink sidebar, theme, PromptInput, and ModelSelector components.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase SSR/Postgres/RLS, Base UI, ai-elements, Tailwind CSS 4.

---

### Task 1: Add the session table and RLS

**Files:**
- Create: `supabase/migrations/20260805000000_chat_sessions.sql`

**Steps:**
1. Add `openlink.chat_sessions` with an 11-character alphanumeric ID check, owner, workspace, title, prompt, and timestamps.
2. Enable RLS and add authenticated select/insert/update/delete policies scoped to `auth.uid()` and accessible workspaces.
3. Apply the migration with Supabase MCP `apply_migration` and verify the table, RLS, and policies with a read-only query.

### Task 2: Implement session creation and loading

**Files:**
- Create: `lib/chat-sessions.ts`
- Create: `app/chat/actions.ts`
- Modify: `lib/workspaces.ts`

**Steps:**
1. Add rejection-sampled server ID generation and a strict ID validator.
2. Add server helpers to create and load a session using the authenticated Supabase client.
3. Add a server action that uses the personal or requested accessible workspace and returns `{ path, id }`.
4. Add workspace-by-ID lookup for the server page.

### Task 3: Add the dynamic route

**Files:**
- Create: `app/[user_id]/chat/[chat_sessions_id]/page.tsx`

**Steps:**
1. Authenticate with `supabase.auth.getUser()`.
2. Validate the URL user ID against the authenticated user and validate the 11-character session ID.
3. Load the owned session, workspace, profile, avatar, and organization summaries.
4. Render `ChatWorkspace` or return 404 for invalid/foreign state.

### Task 4: Build the Figma chat workspace

**Files:**
- Create: `components/chat-workspace.tsx`
- Modify: `components/app-workspace.tsx`
- Modify: `components/openlink-home.tsx`

**Steps:**
1. Export the existing sidebar with active navigation/chat options.
2. Build the 250px sidebar + 49px toolbar + 390px chat column + preview canvas layout.
3. Reuse the existing theme provider, PromptInput, ModelSelector, account drawer, and workspace switcher.
4. Make home and authenticated app composers create sessions and navigate to the canonical route.
5. Add mobile behavior that keeps the composer usable and hides the preview canvas below the desktop breakpoint.

### Task 5: Verify

**Steps:**
1. Run `pnpm build` and `git diff --check`.
2. Verify ID generation and validation with a focused Node/TypeScript check.
3. Verify an authenticated session route loads and a mismatched user ID returns 404.
4. Compare a browser screenshot at the Figma reference viewport and verify composer, toolbar, sidebar, and preview geometry.
