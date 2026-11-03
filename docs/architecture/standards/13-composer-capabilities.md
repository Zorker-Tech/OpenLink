# 13 — Composer capability architecture

Status: binding
Owner: chat UI

The prompt composer is a projection of the active session runtime. It must not
hard-code capabilities that the runtime did not report.

## Runtime resource contract

`GET /api/chat/:session_id/runtime-resources` returns one display-safe model:

```text
agent, source, accessMode
mcpServers[]        id, name, status, auth, toolCount
skills[]            id, name, description, source
permissionProfiles[] id, label, description
instructions[]      id, name, description, text
computer            available, desktop, browser
commands[]          name, description, source
```

- MCP status/auth/tool counts come from the native runtime (`mcpServerStatus/list`
  for Codex, extension inventory for Pi).
- Pi runtime skills come from the Resource Loader; saved User Skills remain a
  separate app-owned source and are merged by name in the UI.
- Permission profiles come from Codex `permissionProfile/list`; the Pi adapter
  reports its three sandbox modes.
- Instructions are bounded project files discovered inside the workspace
  (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.openlink/instructions.md`) plus
  the user's saved custom instructions.
- `computer` reports whether the runtime exposes Desktop and/or Browser tools.

No proxy URL, bearer token, provider key or MCP credential may enter this
payload.

## Prompt add menu

The menu is a capability inventory with explicit actions:

- Uploads and imports remain local UI actions.
- Skills insert the agent-native token (`$skill` or `/skill:name`).
- MCPs are read-only status rows; agents invoke MCP through native tools, not
  by inserting a slash command.
- Instructions attach the selected file/preference text as an instruction
  attachment for the next prompt.
- Permissions change the session access mode only while idle and show Codex
  native profiles as insertable `/permissions <id>` candidates.
- The home composer uses the same menu and receives saved Skills, custom
  instructions and the access-mode setter from the server entry page.

## Computer activity capsule

While a turn is streaming and the active tool is a desktop/computer tool, the
composer shows the same glass status capsule used by the task-position bar,
with `正在使用 Computer`. Browser tools show `正在使用 Live Browser`. The
capsule is derived from the active timeline execution and is removed as soon
as the execution settles or the turn terminates.

## Validation

1. Codex and Pi menus show the exact native MCP/skill/permission inventory.
2. A disabled or unauthenticated MCP is visible with that status.
3. Selecting a project instruction attaches its text and does not submit it
   immediately.
4. A permission change during streaming is rejected without mutating session
   state.
5. A desktop tool makes the Computer capsule appear above the composer and a
   browser tool makes the Live Browser capsule appear.
