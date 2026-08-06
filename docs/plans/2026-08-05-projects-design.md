# OpenLink Projects Design

## Goal

Add workspace-scoped projects for code work and academic research. Projects are
visible only inside the personal or organization workspace that owns them, can
be selected from the home composer, and are persisted on new chat sessions.

## Product flow

1. The sidebar Projects item opens `/app/{workspace_slug}/projects`.
2. The page follows Figma node `42:814`: a 1070px content column, search field,
   create button, and responsive project-card grid.
3. The New Project dialog follows Figma node `42:320`. Its first step offers:
   blank code project, GitHub import, and research project.
4. The second step collects the project name and, for GitHub imports, the source
   URL. Successful creation refreshes the current workspace project list.
5. Selecting a project card returns to the workspace home with that project
   active. The composer selector can change or clear the active project.
6. New chat sessions store the selected `project_id` so the execution service can
   later resolve the correct workspace checkout and runtime target.

## Data and governance

`openlink.projects` belongs to `openlink.workspaces` and stores the creator,
kind (`code` or `research`), source (`blank` or `github`), status, and optional
source URL. RLS follows the existing governance model:

- Personal workspace: the owner can read and mutate projects.
- Organization workspace: all members can read; owners and admins can mutate.
- Project identity, workspace, kind, source type, and creator are immutable
  through column privileges after creation.
- `chat_sessions.project_id` is nullable for project-less chats, and an insert
  policy requires the chosen project to belong to the same workspace.

## Failure handling

- Invalid names and GitHub URLs are rejected before database writes.
- Slug collisions retry with a short random suffix.
- RLS remains the final authorization boundary even when server actions validate
  workspace access first.
- The UI keeps the dialog open and shows a concise inline error on failure.

## Verification

- Apply the migration and run Supabase security/performance advisors.
- Verify project create/list against the authenticated workspace.
- Run TypeScript, lint/build, and browser checks in dark and light modes.
- Compare page and dialog spacing, typography, colors, and responsive behavior
  with the two Figma screenshots.
