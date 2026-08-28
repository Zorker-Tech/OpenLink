-- Add session-level and project-level agent selection.
-- Supported agents: 'codex' (default for new projects) and 'pi'.
-- Sessions are bound to one agent at creation and cannot switch within the same session.

alter table openlink.chat_sessions
  add column if not exists agent text not null default 'codex';

alter table openlink.chat_sessions
  drop constraint if exists chat_sessions_agent_check;

alter table openlink.chat_sessions
  add constraint chat_sessions_agent_check
  check (agent in ('codex', 'pi'));

alter table openlink.projects
  add column if not exists default_agent text not null default 'codex';

alter table openlink.projects
  drop constraint if exists projects_default_agent_check;

alter table openlink.projects
  add constraint projects_default_agent_check
  check (default_agent in ('codex', 'pi'));

notify pgrst, 'reload schema';
