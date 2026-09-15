# Cloud project references

## Meaning and authority

An OpenLink application project ID is not a Hydite platform project ID.
`openlink.cloud_project_links` records their explicit relationship. It is a
resource reference, **not** a remote permission grant, exclusive ownership of a
cloud project, file migration or change of execution backend. Multiple references
must not be interpreted as isolated copies of the same remote filesystem.

Personal workspace owners and organization owners/admins can configure links.
Members can read links where existing project RLS permits access. Every resolved
use asks the current member's own Cloud SDK for their accessible projects; the
configuring administrator's OAuth credentials are never stored in the link or
shared with other members. Remote APIs independently authorize the actual request.

An SSH project may reference cloud resources without changing its SSH execution
target. Agent Host must still honor the immutable execution target and a reviewed
migration/cutover workflow. It must never use a link as an implicit fallback when
SSH or the existing VM fails. No runtime execution cutover is implemented here.

## Data and concurrency

Each application project has at most one link. The row stores project ID, remote
project UUID, revision, updating actor and timestamp—no credential or connection
secret. No global uniqueness claim is made over remote project IDs: an unverified
reference must not let one tenant reserve another tenant's resource.

The command and policies are security-invoker. Existing project/workspace RLS and
role helpers remain authoritative. Mutations repeat authorization after the SDK
directory check. Creating requires revision 0; subsequent updates and removal
require the observed revision. Conflicts are returned rather than blindly replayed.
After an ambiguous response, reread the reference before deciding the next action.

A database trigger also guards direct Data API writes: project identity cannot
be changed in place, revision must advance by one, actor/timestamp are canonical,
and archived projects cannot acquire/update links. Deleting a reference affects
metadata only, not the remote project or its files. A finalized actor FK cleanup
may clear its audit pointer without changing the reference generation.

## BFF contracts implemented in source

`/api/platform/projects/[projectId]/cloud` supports:

- GET: project-authorized metadata; with `connectionId`, also confirms the
  current caller can see the remote project through their SDK.
- PUT: exact configured Origin, authenticated application user, bounded JSON
  `{connectionId, platformProjectRef, revision}`, admin role and remote visibility.
- DELETE: exact Origin, authenticated admin and `?revision=...`; no remote delete.

All responses are private/no-store. Bodies are bounded to 2 KiB with a five-second
read deadline; oversized/aborted streams are cancelled. Caller-supplied user or
project identity overrides are ignored. Client objects and credentials are not
serialized. `executionMigrated:false` deliberately distinguishes a reference from
a completed Workspace/Agent Host migration.

The internal `resolve` result includes the explicit `AuthorizedCloudProjectBinding`
and the caller's SDK for the next owned service integration. Do not persist that
client, bypass its user identity, or import BFF source into privileged services.

## Schema and compatibility findings

Applied Cloud migration: `20260912182303_openlink_cloud_project_links.sql`.
SHA256: `b42adec37d0007882d2e05a2ebaf2374c5bc5dd82c9b56c79c8abbca3a7706fd`.
The source filename matches the actual remote migration version; SQL bytes were
not changed after application. Existing project/workspace rows and VM state were
not modified.

The real Cloud database's `projects` table lacks current source's `execution_mode`
and SSH fields. That belongs to the separate runtime-schema migration, not to
resource references. This implementation does not infer an unknown execution
mode as Local, add a guessed default, or change VM queue initialization. Full
Cloud application/runtime deployment must still reconcile that schema baseline.

## Verification and remaining gates

Twelve focused mapping/RLS/route tests passed; all Cloud-focused tests total 48.
Targeted TypeScript checks pass. Coverage includes member-vs-admin permissions,
remote visibility rechecks, revision conflicts, direct-write guards, body limits,
identity override rejection, no native SSH change and metadata-only unlink.

Real Cloud preflight used the designated account via ordinary authenticated
PostgREST: no visible application projects; missing project reads/writes denied;
anonymous RPC denied; no Cloud credential resolution occurred. The test login was
signed out. There were no mapping rows or VM/file mutations to clean up.

**Positive authenticated mapping has not been accepted live.** It requires the
test account's normal OpenLink project creation flow and its runtime/schema
prerequisites. Do not replace that with guessed IDs or call the negative checks
a successful Workspace integration. BFF deployment, UI, actual runtime/Agent
Host adoption, migration/rollback and first-party end-to-end checks remain required.

The read-only operator preflight is `scripts/live-platform-project-link-preflight.mjs`;
it takes credentials through hidden stdin and never creates a project or VM.
