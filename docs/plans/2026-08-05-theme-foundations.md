# Theme Foundations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish one semantic light/dark design foundation and make all main-app surfaces, controls, and portaled overlays render consistently in the active workspace theme.

**Architecture:** The app shell and every portaled popup share the same semantic token contract. The workspace keeps its theme preference local, while `data-openlink-theme` propagates resolved light/dark values into portal roots without changing unrelated marketing or authentication pages.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, Base UI, ai-elements.

---

### Task 1: Define the semantic theme contract

**Files:**
- Create: `docs/design-system/theme-foundations.md`
- Modify: `app/globals.css`

**Steps:**
1. Document semantic roles, allowed exceptions, portal requirements, geometry, and review criteria.
2. Define dark and light app tokens once for the app shell and portaled theme scopes.
3. Map app tokens onto the standard shadcn tokens consumed by shared UI primitives.
4. Add centralized icon and transition behavior.

### Task 2: Propagate theme into portaled surfaces

**Files:**
- Modify: `components/app-workspace.tsx`
- Modify: `components/workspace-switcher.tsx`
- Modify: `components/ui/feature-dialog.tsx`
- Create: `components/ui/theme-scope.tsx`
- Modify: `components/ui/dropdown-menu.tsx`
- Modify: `components/ui/dialog.tsx`
- Modify: `components/ui/popover.tsx`
- Modify: `components/ui/select.tsx`
- Modify: `components/ui/hover-card.tsx`
- Modify: `components/ui/tooltip.tsx`

**Steps:**
1. Provide the resolved `light|dark` theme once at the workspace root.
2. Make every shared portal primitive inherit and set `data-openlink-theme` automatically.
3. Remove product-level theme prop drilling from the workspace switcher, model selector, and organization dialog.
4. Replace popup-specific literal colors with semantic surface, border, foreground, and shadow tokens.

### Task 3: Normalize product components

**Files:**
- Modify: `components/account-drawer.tsx`
- Modify: `components/organization-setup.tsx`
- Modify: `components/app-workspace.tsx`

**Steps:**
1. Convert the account drawer to raised-surface and semantic interaction tokens.
2. Convert organization tabs, inputs, errors, and primary/secondary buttons to shared semantic roles.
3. Centralize inverted submit-icon behavior for light mode.

### Task 4: Verify implementation

**Files:**
- Inspect: `app/globals.css`
- Inspect: `components/**/*.tsx`

**Steps:**
1. Run `pnpm build` and expect a successful Next.js production build.
2. Run `git diff --check` and expect no whitespace errors.
3. Audit touched components for new theme-dependent literal colors.
4. Open workspace menus, model selector, account drawer, and organization dialog in light mode.
5. Repeat the same interaction checks in dark mode.
6. Verify opaque raised surfaces, readable text, visible borders, and correct selected/hover states.
