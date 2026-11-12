-- Bot groups are a projection of a Work-host group agent onto the same durable
-- Bot identity table. A group has no Project VM or hidden execution session of
-- its own: each member Bot keeps its isolated Pi/OpenSandbox runtime.

alter table openlink.bots
  add column if not exists kind text not null default 'bot',
  add column if not exists member_ids uuid[] not null default '{}';

alter table openlink.bots
  drop constraint if exists bots_kind_check;

alter table openlink.bots
  add constraint bots_kind_check
  check (kind in ('bot', 'group'));

alter table openlink.bots
  drop constraint if exists bots_group_shape_check;

alter table openlink.bots
  add constraint bots_group_shape_check
  check (
    (kind = 'bot' and cardinality(member_ids) = 0)
    or
    (kind = 'group' and runtime_session_id is null and project_id is null and cardinality(member_ids) between 1 and 6)
  );

alter table openlink.bots
  drop constraint if exists bots_group_members_format;

alter table openlink.bots
  add constraint bots_group_members_format
  check (member_ids is null or cardinality(member_ids) <= 6);

create index if not exists bots_user_workspace_kind_updated_idx
  on openlink.bots(user_id, workspace_id, kind, updated_at desc);

-- A group transcript is owned by the application so a lost Work-host store can
-- be rebuilt without losing the visible conversation. The Work-host group
-- remains the live projection; this table is the recovery source.

create table if not exists openlink.bot_group_entries (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references openlink.bots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references openlink.workspaces(id) on delete cascade,
  entry_id text not null,
  sequence bigint generated always as identity,
  entry_kind text not null,
  author_id uuid,
  author_name text,
  content text,
  payload jsonb not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint bot_group_entries_entry_id_length check (char_length(entry_id) between 1 and 256),
  constraint bot_group_entries_kind_check check (entry_kind in ('user-message', 'agent-message', 'activity', 'system')),
  constraint bot_group_entries_author_name_length check (author_name is null or char_length(author_name) <= 64),
  constraint bot_group_entries_content_length check (content is null or char_length(content) <= 100000),
  constraint bot_group_entries_unique_entry unique (bot_id, entry_id)
);

create index if not exists bot_group_entries_bot_sequence_idx
  on openlink.bot_group_entries(bot_id, sequence);

create index if not exists bot_group_entries_user_workspace_idx
  on openlink.bot_group_entries(user_id, workspace_id, occurred_at desc);

alter table openlink.bot_group_entries enable row level security;

drop policy if exists "bot_group_entries_select_own" on openlink.bot_group_entries;
create policy "bot_group_entries_select_own"
  on openlink.bot_group_entries
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from openlink.bots as bot
      where bot.id = bot_group_entries.bot_id
        and bot.user_id = (select auth.uid())
        and bot.workspace_id = bot_group_entries.workspace_id
        and bot.kind = 'group'
    )
  );

drop policy if exists "bot_group_entries_insert_own" on openlink.bot_group_entries;
create policy "bot_group_entries_insert_own"
  on openlink.bot_group_entries
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from openlink.bots as bot
      where bot.id = bot_group_entries.bot_id
        and bot.user_id = (select auth.uid())
        and bot.workspace_id = bot_group_entries.workspace_id
        and bot.kind = 'group'
    )
  );

drop policy if exists "bot_group_entries_delete_own" on openlink.bot_group_entries;
create policy "bot_group_entries_delete_own"
  on openlink.bot_group_entries
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table openlink.bot_group_entries from anon, authenticated;
grant select, insert, delete on table openlink.bot_group_entries to authenticated;
grant select, insert, update, delete on table openlink.bot_group_entries to service_role;

notify pgrst, 'reload schema';
