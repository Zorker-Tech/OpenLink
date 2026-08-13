create table if not exists openlink.user_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_skills_name_length check (char_length(name) between 1 and 64),
  constraint user_skills_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint user_skills_content_length check (char_length(content) <= 200000),
  unique (user_id, slug)
);

create index if not exists user_skills_user_updated_idx
  on openlink.user_skills(user_id, updated_at desc);

alter table openlink.user_skills enable row level security;

drop policy if exists "user_skills_select_own" on openlink.user_skills;
create policy "user_skills_select_own"
  on openlink.user_skills for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "user_skills_insert_own" on openlink.user_skills;
create policy "user_skills_insert_own"
  on openlink.user_skills for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "user_skills_update_own" on openlink.user_skills;
create policy "user_skills_update_own"
  on openlink.user_skills for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "user_skills_delete_own" on openlink.user_skills;
create policy "user_skills_delete_own"
  on openlink.user_skills for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table openlink.user_skills from anon, authenticated;
grant select, insert, update, delete on table openlink.user_skills to authenticated;
grant select, insert, update, delete on table openlink.user_skills to service_role;

notify pgrst, 'reload schema';
