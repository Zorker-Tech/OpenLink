create table if not exists openlink.preview_annotations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references openlink.projects(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  target_id text not null,
  page_path text not null,
  element_selector text,
  element_label text,
  bounds jsonb not null,
  viewport jsonb not null,
  comment text not null,
  screenshot_data_url text not null,
  created_at timestamptz not null default now(),
  constraint preview_annotations_target_id_check check (target_id ~ '^[A-Za-z0-9_-]{43}$'),
  constraint preview_annotations_page_path_check check (page_path like '/%' and page_path not like '//%' and page_path !~ '[?#[:cntrl:]]'),
  constraint preview_annotations_selector_length_check check (element_selector is null or char_length(element_selector) <= 1000),
  constraint preview_annotations_label_length_check check (element_label is null or char_length(element_label) <= 240),
  constraint preview_annotations_bounds_check check (
    jsonb_typeof(bounds) = 'object'
    and jsonb_typeof(bounds->'x') = 'number'
    and jsonb_typeof(bounds->'y') = 'number'
    and jsonb_typeof(bounds->'width') = 'number'
    and jsonb_typeof(bounds->'height') = 'number'
  ),
  constraint preview_annotations_viewport_check check (
    jsonb_typeof(viewport) = 'object'
    and jsonb_typeof(viewport->'width') = 'number'
    and jsonb_typeof(viewport->'height') = 'number'
  ),
  constraint preview_annotations_comment_length_check check (char_length(comment) between 1 and 2000),
  constraint preview_annotations_screenshot_check check (
    screenshot_data_url like 'data:image/jpeg;base64,%'
    and char_length(screenshot_data_url) <= 2800050
  )
);

create index if not exists preview_annotations_project_target_created_idx
  on openlink.preview_annotations(project_id, target_id, created_at desc);

alter table openlink.preview_annotations enable row level security;

drop policy if exists "preview_annotations_select_project_members" on openlink.preview_annotations;
create policy "preview_annotations_select_project_members"
  on openlink.preview_annotations
  for select
  to authenticated
  using (
    exists (
      select 1 from openlink.projects as project
      where project.id = preview_annotations.project_id
    )
  );

drop policy if exists "preview_annotations_insert_project_members" on openlink.preview_annotations;
create policy "preview_annotations_insert_project_members"
  on openlink.preview_annotations
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from openlink.projects as project
      where project.id = preview_annotations.project_id
    )
  );

revoke all on table openlink.preview_annotations from anon, authenticated;
grant select, insert on table openlink.preview_annotations to authenticated;
grant select, insert, update, delete on table openlink.preview_annotations to service_role;

notify pgrst, 'reload schema';
