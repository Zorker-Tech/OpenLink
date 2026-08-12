-- OpenLink's exposed application schema must exist before PostgREST starts.
-- The application migrations add its tables and policies later.
create schema if not exists openlink;
grant usage, create on schema openlink to supabase_admin, postgres, anon, authenticated, service_role;
