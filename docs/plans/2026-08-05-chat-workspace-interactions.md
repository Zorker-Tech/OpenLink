# Chat Workspace Interactions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add accessible chat-panel resizing/collapse, mobile/browser preview switching, and Figma-accurate adaptive composer behavior.

**Architecture:** Keep `ChatWorkspace` as the state owner. Use shadcn Resizable primitives for desktop panel layout, an imperative panel ref for toolbar collapse, AI Elements WebPreview for preview behavior, and PromptInput state derived from textarea wrapping for compact/expanded layout.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui Base Nova, react-resizable-panels v4, AI Elements PromptInput and WebPreview.

---

### Task 1: Add shadcn Resizable primitives

**Files:**
- Create: `components/ui/resizable.tsx`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Steps:**
1. Install the official shadcn Resizable component using the project's pnpm 11 runtime.
2. Confirm the wrapper exports `ResizablePanelGroup`, `ResizablePanel`, and `ResizableHandle`.
3. Verify the package resolves with React 19.

### Task 2: Implement panel and preview state

**Files:**
- Modify: `components/chat-workspace.tsx`

**Steps:**
1. Add `chatPanelCollapsed` and `previewMode` state.
2. Pass a chat-toggle handler and active state into `ChatTopbar`.
3. Replace the desktop chat/preview flex row with a horizontal `ResizablePanelGroup`.
4. Configure chat `defaultSize="390px"`, `minSize="390px"`, `maxSize="50%"`, `collapsedSize="0px"`, and `collapsible`.
5. Use `ResizableHandle` with an accessible label and visible drag affordance.
6. Render the existing responsive full-width chat layout below `lg`.
7. Wrap the preview in AI Elements `WebPreview`; switch only the frame geometry between mobile and browser modes.

### Task 3: Implement adaptive composer

**Files:**
- Modify: `components/chat-workspace.tsx`

**Steps:**
1. Track whether textarea content exceeds one 20px line using `scrollHeight` and newline detection.
2. Keep the compact state identical to node `3:10576`.
3. Render the expanded state as a column with 12px padding, a minimum 54px textarea, and a bottom action row matching node `3:13035`.
4. Add height, padding, and border transitions; preserve keyboard submit and model-selector behavior.
5. Return to compact mode after submit or when content becomes one line again.

### Task 4: Verify

**Steps:**
1. Run `pnpm build` and `git diff --check`.
2. In the authenticated chat route, verify compact composer is 373×42 and expanded composer is at least 373×108.
3. Verify toolbar collapse and drag collapse restore to 390px.
4. Verify chat cannot exceed 50% of the available content area.
5. Verify mobile/browser preview toggling and responsive behavior.
6. Confirm browser runtime logs contain no new errors.
