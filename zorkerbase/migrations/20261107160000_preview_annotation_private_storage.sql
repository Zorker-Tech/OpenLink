alter table openlink.preview_annotations
  add column if not exists screenshot_object_path text;

alter table openlink.preview_annotations
  alter column screenshot_data_url drop not null;

alter table openlink.preview_annotations
  drop constraint if exists preview_annotations_screenshot_check;

alter table openlink.preview_annotations
  add constraint preview_annotations_screenshot_storage_check check (
    (
      screenshot_object_path is not null
      and screenshot_data_url is null
      and screenshot_object_path ~ (
        '^' || project_id::text || '/' || created_by::text || '/' || id::text || '-[a-f0-9]{64}[.]jpg$'
      )
    )
    or
    (
      screenshot_object_path is null
      and screenshot_data_url is not null
      and screenshot_data_url like 'data:image/jpeg;base64,%'
      and char_length(screenshot_data_url) <= 2800050
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'openlink-preview-annotations',
  'openlink-preview-annotations',
  false,
  2100000,
  array['image/jpeg']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "preview_annotation_objects_select_project_members" on storage.objects;
create policy "preview_annotation_objects_select_project_members"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'openlink-preview-annotations'
    and exists (
      select 1
      from openlink.projects as project
      where project.id::text = split_part(storage.objects.name, '/', 1)
    )
  );

drop policy if exists "preview_annotation_objects_insert_project_members" on storage.objects;
create policy "preview_annotation_objects_insert_project_members"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'openlink-preview-annotations'
    and split_part(storage.objects.name, '/', 2) = (select auth.uid())::text
    and storage.objects.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-f0-9]{64}[.]jpg$'
    and exists (
      select 1
      from openlink.projects as project
      where project.id::text = split_part(storage.objects.name, '/', 1)
    )
  );

drop policy if exists "preview_annotation_objects_delete_unreferenced_owner_uploads" on storage.objects;
create policy "preview_annotation_objects_delete_unreferenced_owner_uploads"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'openlink-preview-annotations'
    and split_part(storage.objects.name, '/', 2) = (select auth.uid())::text
    and exists (
      select 1
      from openlink.projects as project
      where project.id::text = split_part(storage.objects.name, '/', 1)
    )
    and not exists (
      select 1
      from openlink.preview_annotations as annotation
      where annotation.screenshot_object_path = storage.objects.name
    )
  );

notify pgrst, 'reload schema';
