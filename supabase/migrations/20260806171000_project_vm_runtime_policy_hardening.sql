drop policy if exists "project_runtimes_update_governed" on openlink.project_runtimes;
create policy "project_runtimes_update_governed"
  on openlink.project_runtimes
  for update
  to authenticated
  using (
    exists (
      select 1
      from openlink.projects as project
      join openlink.workspaces as workspace on workspace.id = project.workspace_id
      where project.id = project_runtimes.project_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(workspace.organization_id, array['owner', 'admin'])
          )
        )
    )
  )
  with check (
    exists (
      select 1
      from openlink.projects as project
      join openlink.workspaces as workspace on workspace.id = project.workspace_id
      where project.id = project_runtimes.project_id
        and (
          (workspace.scope_type = 'personal' and workspace.owner_id = (select auth.uid()))
          or (
            workspace.scope_type = 'organization'
            and openlink_private.has_organization_role(workspace.organization_id, array['owner', 'admin'])
          )
        )
    )
  );
