# Settings Skills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the Figma-defined user Skills settings list and `SKILL.md` editor with durable Local ZOKERBASE persistence.

**Architecture:** Store user-owned skills in an RLS-protected `openlink.user_skills` table. Server pages load authenticated skill records, while a shared client workspace renders the 288px skill navigator, creation/import controls, and editor. Server actions validate every mutation and revalidate both list and detail routes.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS utilities, ZOKERBASE/Postgres, Supabase SSR client, Zod.

---

### Task 1: Persist user skills

**Files:**
- Create: `supabase/migrations/20260811130000_user_skills.sql`
- Create: `lib/user-skill-types.ts`
- Create: `lib/user-skills.server.ts`

1. Add the user-owned skills table, constraints, indexes, grants, and RLS policies.
2. Add typed list/detail records and server query helpers.
3. Apply the migration to Local ZOKERBASE and verify the table through PostgREST.

### Task 2: Add validated skill mutations

**Files:**
- Create: `app/settings/skills/actions.ts`

1. Add create/import, save, and delete schemas.
2. Require an authenticated user for every mutation.
3. Revalidate `/settings/skills` and affected detail routes.

### Task 3: Build the Figma Skills workspace

**Files:**
- Create: `components/settings/skills-workspace.tsx`
- Create: `app/settings/skills/page.tsx`
- Create: `app/settings/skills/[skill_id]/page.tsx`

1. Build the 288px Skills navigation with User/Team tabs and skill tree rows.
2. Build the empty-state creation/import actions.
3. Build the `SKILL.md` editor header, character count, save state, and delete menu.
4. Add ZIP import using the existing application bundle and a small ZIP codec dependency.

### Task 4: Extend Settings navigation

**Files:**
- Modify: `components/settings/settings-shell.tsx`

1. Add Memories and Skills under 工作区 in Figma order.
2. Keep Memories disabled until its page exists.
3. Mark Skills active for list and editor routes and align the collapsed-sidebar control with the secondary panel.

### Task 5: Verify

1. Run a scoped TypeScript check for the new routes/components/helpers.
2. Run `git diff --check` on touched files.
3. Verify Local ZOKERBASE migration status.
4. Exercise create, edit/save, ZIP import, and delete through the local application.
