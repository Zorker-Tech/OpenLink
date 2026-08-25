-- Session-level Supabase access mode for the unified access firewall.
-- 'restricted' — controlled mode: MCP operations pass the firewall (reads only).
-- 'ask'        — confirmation mode: writes require explicit user approval.
-- 'open'       — full access: MCP operations are not restricted.
alter table openlink.chat_sessions
  add column if not exists access_mode text not null default 'restricted';

alter table openlink.chat_sessions
  drop constraint if exists chat_sessions_access_mode_check;

alter table openlink.chat_sessions
  add constraint chat_sessions_access_mode_check
  check (access_mode in ('restricted', 'ask', 'open'));
