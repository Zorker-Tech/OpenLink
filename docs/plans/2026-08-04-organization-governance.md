# Organization Governance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an optional organization onboarding flow and keep personal and organization governance isolated while allowing users to switch between related workspaces.

**Architecture:** Supabase Auth remains the shared identity layer. Personal settings and personal workspaces stay owned by `user_id`; organizations gain separate organization, membership, role, and invite-code records protected by RLS. An exposed transactional RPC creates organizations under caller RLS, while a private security-definer helper validates join codes without exposing privileged functions through the Data API.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase SSR/Auth/Postgres/RLS, Base UI Dialog, Tailwind CSS.

---

### Task 1: Extend the organization schema

**Files:**
- Create: `supabase/migrations/<timestamp>_openlink_organization_governance.sql`

**Steps:**
1. Add organization onboarding state to profiles.
2. Add `organizations` and `organization_members` with owner/admin/member roles.
3. Extend workspaces with `scope_type` and optional `organization_id` while preserving existing personal rows.
4. Add private membership helpers and minimal grants.
5. Add RLS policies that never authorize organization actions from editable user metadata.
6. Add transactional create/join functions and verify their privileges.
7. Apply the SQL to the connected Supabase project, inspect tables/policies/functions, and run security advisors.

### Task 2: Extend the server data layer

**Files:**
- Modify: `lib/workspaces.ts`
- Create: `lib/organizations.ts`

**Steps:**
1. Model personal and organization workspace types.
2. Resolve any workspace the signed-in user owns or belongs to.
3. List organization memberships for the sidebar and account drawer.
4. Add server helpers for create, join, and skip onboarding.
5. Verify errors are normalized without exposing database internals.

### Task 3: Add optional organization onboarding

**Files:**
- Modify: `app/app/page.tsx`
- Modify: `app/app/onboarding/page.tsx`
- Modify: `app/app/onboarding/onboarding-form.tsx`
- Modify: `app/app/onboarding/actions.ts`

**Steps:**
1. Keep nickname confirmation as the first step.
2. Route new users to a create/join/skip organization step.
3. Mark existing profiles as already completed during migration.
4. Redirect create/join to the organization workspace and skip to the personal workspace.
5. Verify email-confirmation and OAuth callbacks still enter through `/app`.

### Task 4: Build reusable governance UI

**Files:**
- Create: `components/ui/feature-dialog.tsx`
- Create: `components/organization-dialog.tsx`
- Create: `components/workspace-switcher.tsx`
- Modify: `components/account-drawer.tsx`
- Modify: `components/app-workspace.tsx`
- Modify: `app/app/[workspace_name]/page.tsx`

**Steps:**
1. Build a reusable function-dialog SDK on Base UI with the model-selector surface styling.
2. Build an organization dialog with create and invite-code join tabs.
3. Replace the account drawer placeholder organization with live membership data or “添加组织”.
4. Make the sidebar header switch between the personal workspace and organization workspaces.
5. Keep organization management links scoped to organization roles and personal settings scoped to the user.
6. Verify responsive behavior and both light/dark themes in the browser.

### Task 5: Verify and deliver

**Files:**
- Modify only files owned by this feature; preserve unrelated working-tree changes.

**Steps:**
1. Run `pnpm lint` and `pnpm build`.
2. Run `git diff --check`.
3. Inspect the organization dialog, add-organization state, and workspace switcher in the signed-in browser.
4. Run Supabase security and performance advisors and document any pre-existing unrelated findings.
5. Commit only feature-owned files and push `dev`.
