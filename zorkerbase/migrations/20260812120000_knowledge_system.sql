-- Knowledge system metadata and backend governance.
-- PostgreSQL stores ownership, source text, chunk metadata, and lifecycle
-- state. Zero stores only the vector index projection and is never exposed
-- directly to browser clients or Project VMs.

create schema if not exists openlink;

create table if not exists openlink.knowledge_backends (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references openlink.workspaces(id) on delete cascade,
  mode text not null default 'standalone',
  status text not null default 'provisioning',
  endpoint text,
  collection_name text not null default 'openlink_knowledge_chunks_v1',
  vector_dimension integer not null default 1536,
  embedding_provider text,
  embedding_model text,
  schema_version integer not null default 1,
  deployment_target jsonb not null default '{}'::jsonb,
  -- Distributed targets are persisted as encrypted connection material. The
  -- Knowledge Service is the only process that reads these columns; the
  -- browser receives deployment status, never private keys.
  ssh_host text,
  ssh_port integer not null default 22,
  ssh_user text,
  ssh_remote_root text,
  ssh_known_hosts text,
  ssh_encrypted_private_key text,
  ssh_private_key_iv text,
  ssh_private_key_tag text,
  ssh_encryption_version integer,
  last_error text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_backends_mode_check check (mode in ('standalone', 'distributed')),
  constraint knowledge_backends_status_check check (status in ('provisioning', 'ready', 'migrating', 'stopped', 'error')),
  constraint knowledge_backends_endpoint_check check (endpoint is null or endpoint ~ '^https://|^http://'),
  constraint knowledge_backends_collection_check check (collection_name ~ '^[a-zA-Z][a-zA-Z0-9_]{0,127}$'),
  constraint knowledge_backends_dimension_check check (vector_dimension between 2 and 32768),
  constraint knowledge_backends_ssh_port_check check (ssh_port between 1 and 65535),
  constraint knowledge_backends_ssh_material_check check (
    mode = 'standalone'
    or (
      ssh_host is not null and ssh_user is not null and ssh_remote_root is not null
      and ssh_known_hosts is not null and ssh_encrypted_private_key is not null
      and ssh_private_key_iv is not null and ssh_private_key_tag is not null
      and ssh_encryption_version is not null
    )
  ),
  constraint knowledge_backends_error_length check (last_error is null or char_length(last_error) <= 4000)
);

create table if not exists openlink.knowledge_collections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references openlink.workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  name text not null,
  slug text not null,
  description text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_collections_workspace_slug_unique unique (workspace_id, slug),
  constraint knowledge_collections_name_length check (char_length(name) between 1 and 120),
  constraint knowledge_collections_slug_length check (char_length(slug) between 1 and 120),
  constraint knowledge_collections_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint knowledge_collections_description_length check (char_length(description) <= 4000),
  constraint knowledge_collections_status_check check (status in ('active', 'archived'))
);

create table if not exists openlink.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references openlink.workspaces(id) on delete cascade,
  collection_id uuid not null references openlink.knowledge_collections(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  title text not null,
  source_type text not null default 'text',
  source_uri text,
  mime_type text,
  source_content text,
  content_hash text not null,
  status text not null default 'queued',
  chunk_count integer not null default 0,
  embedding_provider text,
  embedding_model text,
  metadata jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_documents_source_type_check check (source_type in ('text', 'file', 'url', 'markdown', 'code')),
  constraint knowledge_documents_status_check check (status in ('queued', 'processing', 'ready', 'failed', 'deleting', 'deleted')),
  constraint knowledge_documents_title_length check (char_length(title) between 1 and 300),
  constraint knowledge_documents_source_content_length check (source_content is null or char_length(source_content) <= 10000000),
  constraint knowledge_documents_hash_length check (content_hash ~ '^[a-f0-9]{64}$'),
  constraint knowledge_documents_chunk_count_check check (chunk_count between 0 and 100000),
  constraint knowledge_documents_error_length check (last_error is null or char_length(last_error) <= 4000)
);

alter table openlink.knowledge_documents
  add column if not exists source_content text;

create table if not exists openlink.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references openlink.workspaces(id) on delete cascade,
  collection_id uuid not null references openlink.knowledge_collections(id) on delete cascade,
  document_id uuid not null references openlink.knowledge_documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  content_hash text not null,
  token_count integer not null default 0,
  zero_id text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint knowledge_chunks_document_index_unique unique (document_id, chunk_index),
  constraint knowledge_chunks_index_check check (chunk_index >= 0),
  constraint knowledge_chunks_content_length check (char_length(content) between 1 and 100000),
  constraint knowledge_chunks_hash_length check (content_hash ~ '^[a-f0-9]{64}$')
);

create table if not exists openlink.knowledge_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references openlink.workspaces(id) on delete cascade,
  collection_id uuid references openlink.knowledge_collections(id) on delete set null,
  document_id uuid references openlink.knowledge_documents(id) on delete set null,
  kind text not null,
  status text not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint knowledge_jobs_kind_check check (kind in ('ingest', 'delete', 'reindex', 'distributed_deploy', 'distributed_migrate')),
  constraint knowledge_jobs_status_check check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

create table if not exists openlink.knowledge_backend_deployments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references openlink.workspaces(id) on delete cascade,
  backend_id uuid not null references openlink.knowledge_backends(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete restrict,
  mode text not null,
  target jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  endpoint text,
  job_id uuid references openlink.knowledge_jobs(id) on delete set null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_deployments_mode_check check (mode = 'distributed'),
  constraint knowledge_deployments_status_check check (status in ('queued', 'connecting', 'deploying', 'migrating', 'ready', 'failed', 'cancelled'))
);

create index if not exists knowledge_collections_workspace_idx
  on openlink.knowledge_collections(workspace_id, updated_at desc);
create index if not exists knowledge_documents_collection_idx
  on openlink.knowledge_documents(collection_id, updated_at desc);
create index if not exists knowledge_documents_status_idx
  on openlink.knowledge_documents(status, updated_at desc);
create index if not exists knowledge_chunks_document_idx
  on openlink.knowledge_chunks(document_id, chunk_index);
create index if not exists knowledge_jobs_workspace_idx
  on openlink.knowledge_jobs(workspace_id, created_at desc);
create index if not exists knowledge_deployments_workspace_idx
  on openlink.knowledge_backend_deployments(workspace_id, created_at desc);

alter table openlink.knowledge_backends enable row level security;
alter table openlink.knowledge_collections enable row level security;
alter table openlink.knowledge_documents enable row level security;
alter table openlink.knowledge_chunks enable row level security;
alter table openlink.knowledge_jobs enable row level security;
alter table openlink.knowledge_backend_deployments enable row level security;

-- Writes are performed by the privileged Knowledge Service after it has
-- authenticated the caller and checked workspace membership. Keeping the
-- public role read-only prevents a client from changing endpoints, embedding
-- configuration, or deployment state directly through PostgREST.
drop policy if exists knowledge_backends_manage_accessible on openlink.knowledge_backends;
drop policy if exists knowledge_backends_read_accessible on openlink.knowledge_backends;
create policy knowledge_backends_read_accessible on openlink.knowledge_backends
  for select to authenticated using (
    exists (select 1 from openlink.workspaces w where w.id = knowledge_backends.workspace_id and (
      (w.scope_type = 'personal' and w.owner_id = (select auth.uid()))
      or (w.scope_type = 'organization' and openlink_private.is_organization_member(w.organization_id))
    ))
  );

-- Collections, documents, and chunks use the same workspace boundary. The
-- Knowledge API performs the same check with the service role before every
-- operation; these policies protect direct PostgREST access as well.
drop policy if exists knowledge_collections_accessible on openlink.knowledge_collections;
create policy knowledge_collections_accessible on openlink.knowledge_collections
  for select to authenticated using (
    exists (select 1 from openlink.workspaces w where w.id = knowledge_collections.workspace_id and (
      (w.scope_type = 'personal' and w.owner_id = (select auth.uid()))
      or (w.scope_type = 'organization' and openlink_private.is_organization_member(w.organization_id))
    ))
  );

drop policy if exists knowledge_documents_accessible on openlink.knowledge_documents;
create policy knowledge_documents_accessible on openlink.knowledge_documents
  for select to authenticated using (
    exists (select 1 from openlink.workspaces w where w.id = knowledge_documents.workspace_id and (
      (w.scope_type = 'personal' and w.owner_id = (select auth.uid()))
      or (w.scope_type = 'organization' and openlink_private.is_organization_member(w.organization_id))
    ))
  );

drop policy if exists knowledge_chunks_accessible on openlink.knowledge_chunks;
create policy knowledge_chunks_accessible on openlink.knowledge_chunks
  for select to authenticated using (
    exists (select 1 from openlink.workspaces w where w.id = knowledge_chunks.workspace_id and (
      (w.scope_type = 'personal' and w.owner_id = (select auth.uid()))
      or (w.scope_type = 'organization' and openlink_private.is_organization_member(w.organization_id))
    ))
  );

drop policy if exists knowledge_jobs_accessible on openlink.knowledge_jobs;
create policy knowledge_jobs_accessible on openlink.knowledge_jobs
  for select to authenticated using (
    exists (select 1 from openlink.workspaces w where w.id = knowledge_jobs.workspace_id and (
      (w.scope_type = 'personal' and w.owner_id = (select auth.uid()))
      or (w.scope_type = 'organization' and openlink_private.is_organization_member(w.organization_id))
    ))
  );

drop policy if exists knowledge_deployments_accessible on openlink.knowledge_backend_deployments;
create policy knowledge_deployments_accessible on openlink.knowledge_backend_deployments
  for select to authenticated using (
    exists (select 1 from openlink.workspaces w where w.id = knowledge_backend_deployments.workspace_id and (
      (w.scope_type = 'personal' and w.owner_id = (select auth.uid()))
      or (w.scope_type = 'organization' and openlink_private.is_organization_member(w.organization_id))
    ))
  );

revoke all on table openlink.knowledge_backends, openlink.knowledge_collections,
  openlink.knowledge_documents, openlink.knowledge_chunks, openlink.knowledge_jobs,
  openlink.knowledge_backend_deployments from anon;
grant select on table openlink.knowledge_collections, openlink.knowledge_documents,
  openlink.knowledge_chunks, openlink.knowledge_jobs,
  openlink.knowledge_backend_deployments to authenticated;
-- Column-level defense in depth: authenticated clients may inspect backend
-- status, but SSH connection material is service-role-only. A table-level
-- SELECT grant would override a later column revoke, so grant only this
-- explicit non-secret projection to authenticated.
revoke select on table openlink.knowledge_backends from authenticated;
grant select (
  id, workspace_id, mode, status, endpoint, collection_name,
  vector_dimension, embedding_provider, embedding_model, schema_version,
  deployment_target, last_error, created_by, created_at, updated_at
) on table openlink.knowledge_backends to authenticated;
grant all on table openlink.knowledge_backends, openlink.knowledge_collections,
  openlink.knowledge_documents, openlink.knowledge_chunks, openlink.knowledge_jobs,
  openlink.knowledge_backend_deployments to service_role;

notify pgrst, 'reload schema';
