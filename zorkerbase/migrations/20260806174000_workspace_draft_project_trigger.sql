create or replace function openlink_private.initialize_workspace_draft_project()
returns trigger
language plpgsql
security definer
set search_path = openlink, pg_catalog
as $$
declare
  creator uuid;
begin
  select coalesce(new.owner_id, organization.created_by)
    into creator
  from openlink.organizations as organization
  where organization.id = new.organization_id;

  if creator is null then
    return new;
  end if;

  insert into openlink.projects (
    workspace_id,
    created_by,
    name,
    slug,
    kind,
    source_type,
    source_url,
    description,
    status,
    is_default
  ) values (
    new.id,
    creator,
    'Draft',
    'draft',
    'code',
    'blank',
    null,
    '默认项目：未指定项目的聊天会话在此运行。',
    'active',
    true
  )
  on conflict (workspace_id, slug) do update
    set is_default = true,
        status = 'active',
        updated_at = now();
  return new;
end;
$$;

revoke all on function openlink_private.initialize_workspace_draft_project() from public, anon, authenticated;

drop trigger if exists workspaces_initialize_draft_project on openlink.workspaces;
create trigger workspaces_initialize_draft_project
after insert on openlink.workspaces
for each row execute function openlink_private.initialize_workspace_draft_project();

