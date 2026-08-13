-- A Cloud chat session is permanently scoped to its Project VM. The earlier
-- projects migration used ON DELETE SET NULL, but project_id is now NOT NULL
-- and every session is backfilled to Draft. Keep history safe and reject an
-- accidental project deletion; callers should archive projects instead.
alter table openlink.chat_sessions
  drop constraint if exists chat_sessions_project_id_fkey;

alter table openlink.chat_sessions
  add constraint chat_sessions_project_id_fkey
  foreign key (project_id)
  references openlink.projects(id)
  on delete restrict;

notify pgrst, 'reload schema';
