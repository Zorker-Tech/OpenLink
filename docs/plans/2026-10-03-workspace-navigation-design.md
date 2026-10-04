# Workspace navigation layout

Scope: `/Volumes/Windows/openlink`, product Web UI. The running development
server uses this checkout. No input/composer implementation changes, runtime
service changes, schema changes, or changes to sibling checkouts.

## Design reference

Figma file `iw3kbqW6lTdCldLAvNa07R`:

- `140:171`: 52px app rail, 36px buttons, 20px icons, 16px vertical gaps,
  account avatar at the bottom.
- `140:857`, `140:1073`: pinned 288px conversation sidebar.
- `140:2`, `140:852`: collapsed quick preview, 284px panel, 4px inset,
  14px radius, #212121 background.
- User screenshot: retain actual OpenLink composer, workspace selection and
  conversation/preview behavior; apply the new chrome to conversation details.

The rail owns Home, Projects, Knowledge, chat search and account/settings entry
points. Library and Templates had no destinations in the existing implementation;
they remain explicitly unavailable instead of pointing at fabricated routes.
The sidebar owns the workspace selector, new conversation, project shortcuts and
real recent conversations. The reference's sample ChatGPT branding, mock chat
history and input controls are not product data.

The expanded sidebar occupies layout space. Collapsed preview overlays the main
content without resizing it; hover Home or the expand control to reveal it,
click the expand control to pin it. Escape dismisses the preview. Ctrl/Cmd+B
changes desktop sidebar state outside editable controls. Existing localStorage
collapse persistence remains shared across page shells. Mobile has its own
closeable drawer; hidden sidebar and collapsed groups are inert.

Knowledge navigation remains available as a content-area panel, opened from the
Knowledge header. It no longer replaces conversation history. Project and
Knowledge routes load history through the existing authenticated, workspace-
scoped server query.

## Assets

`public/openlink/navigation/*.svg` are the original Figma exports. Rail assets
come from `140:171`; search, collapse, and the two new-chat vector layers come
from `140:852`. Native SVG width/height attributes are preserved. Profile images
and workspace identity remain driven by existing user data.

## Verification

- Seven DOM-only interaction tests pass in `scripts/test/workspace-navigation.test.mjs`.
- Tailwind/PostCSS compiles the stylesheet successfully.
- Storybook inventory: 125 modules, 152 stories, no missing component coverage.
  Expanded, collapsed and light-theme navigation fixtures are available.
- TypeScript compiler comparison against HEAD (using an in-memory source overlay):
  82 baseline diagnostics, 82 current diagnostics, zero added diagnostics.
- `git diff --check` passes.
- Live browser acceptance confirms the account menu opens over the chat sidebar
  instead of the outer rail. At the minimum 240px sidebar width, the menu narrows
  to 224px; the default 288px width was restored after the check.
- The restarted local stack returns HTTP 200 from `/api/healthz` with Knowledge
  and Zero healthy.
