alter table openlink.preview_annotations
  add column if not exists target_revision text;

alter table openlink.preview_annotations
  drop constraint if exists preview_annotations_target_revision_check;

alter table openlink.preview_annotations
  add constraint preview_annotations_target_revision_check check (
    target_revision is null
    or target_revision ~ '^git-sha256:[a-f0-9]{64}$'
  );

notify pgrst, 'reload schema';
