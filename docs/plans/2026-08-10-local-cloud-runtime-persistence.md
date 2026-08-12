# Local and Cloud ZOKERBASE Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the OpenLink-owned ZOKERBASE self-hosted stack as the Local
backend while Cloud uses the same schema and service contracts.

**Architecture:** `backend/` is a sparse upstream-compatible source snapshot.
The OpenLink lifecycle copies `backend/docker` into ZOKERBASE runtime state,
generates persistent secrets, uses only product-owned `zokerbase/*` images,
applies the root OpenLink migrations, and only then starts application
services. Local and Cloud are separate data and identity domains.

**Tech Stack:** Supabase self-hosted Docker stack, Studio, PostgreSQL,
PostgREST, GoTrue, Realtime, Storage, Next.js SSR, Docker Compose.

---

### Task 1: Vendor and document the upstream runtime

1. Keep only `docker/`, Studio and Studio's transitive workspace packages.
2. Record the upstream URL, commit and update procedure in `backend/UPSTREAM.md`.
3. Exclude generated runtime data and secrets from source control.

### Task 2: Implement the ZOKERBASE supervisor

1. Copy immutable runtime assets to `.openlink-runtime/zokerbase/stack`.
2. Reuse the official key-generation scripts and keep generated secrets mode 0600.
3. Build/load the immutable `zokerbase/*` image artifact, start Docker Desktop
   when necessary, run the ZOKERBASE Compose topology,
   wait for health and return server-only connection settings.

### Task 3: Apply the shared OpenLink schema

1. Apply `supabase/migrations/*.sql` in filename order inside a transaction.
2. Record applied versions in `supabase_migrations.schema_migrations`.
3. Notify PostgREST after migrations and verify the exposed `openlink` schema.

### Task 4: Keep Cloud and Local independent

1. Run browser login and cookie refresh against local ZOKERBASE Auth in Local
   mode.
2. Never read Cloud URLs, tokens, JWT secrets, or database data in Local mode.
3. Treat an intentional Cloud-to-Local data transfer as a separate migration,
   never as part of sign-in or normal runtime behavior.

### Task 5: Verify the complete Local runtime

1. Verify Auth, REST, Realtime, Storage and Studio health.
2. Create/reopen/send a chat and check event/Pi persistence through PostgREST.
3. Run Agent Host tests and `pnpm build:web`.
