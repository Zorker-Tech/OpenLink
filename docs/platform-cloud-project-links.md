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

## Cloud sign-in onboarding

After Cloud identity sign-in, OpenLink uses the account's VTSLX OAuth
connection and `sdk.directory.listProjects()` to show projects the signed-in
Studio account can access. The SDK's Directory API is read-only: it returns
project IDs, names and organization IDs, but does not create organizations or
projects. Those actions open Studio's own creation pages; returning to
OpenLink refreshes the directory list.

Choosing a Studio project associates it with the OpenLink personal Draft
project through the same revision-checked `cloud_project_links` command used by
the Cloud project settings API. The selection is checked before workspace
creation and revalidated through the user's SDK before the write. This is an
authorization-aware project reference only: it does not create a VTSLX
Workspace session, route chat execution to that session, copy data, start a
Studio project creation request, or change the OpenLink project's execution
target. Those runtime consumers remain a separate integration step.

The product SDK OAuth grant is separate from Hydite identity sign-in. If no
active SDK connection exists, onboarding requests that grant and returns to the
project picker after the callback. The OAuth return path is restricted to the
Cloud onboarding route and is stored inside the encrypted, single-use login
transaction. Identity sign-in and the SDK connection share the registered
callback URL, so the callback selects a flow only when its `state` matches that
flow's own cookie; a leftover identity cookie cannot consume the SDK callback.
Cloud sign-in defaults to onboarding, and the account menu's project settings
entry reopens the same project picker.

## BFF contracts implemented in source

`/api/platform/projects/[projectId]/cloud` supports:

- GET: project-authorized metadata; with `connectionId`, also confirms the
  current caller can see the remote project through their SDK.
- PUT: exact configured Origin, authenticated application user, bounded JSON
  `{connectionId, platformProjectRef, revision}`, admin role and remote visibility.
- DELETE: exact Origin, authenticated admin and `?revision=...`; no remote delete.

`/api/platform/projects/[projectId]/computer` supports a Cloud-only GET. It
resolves the caller's active SDK connection and linked project, then asks the
loopback Cloud SDK Host for `computer.info()`. The BFF forwards only the
caller-bound OAuth access token with its remaining lifetime; the Host verifies
the Hydite subject before calling Computer. It returns a narrow status summary
and exposes no arbitrary command execution endpoint.

All responses are private/no-store. Bodies are bounded to 2 KiB with a five-second
read deadline; oversized/aborted streams are cancelled. Caller-supplied user or
project identity overrides are ignored. Client objects and credentials are not
serialized. `executionMigrated:false` deliberately distinguishes a reference from
a completed Workspace/Agent Host migration.

The internal `resolve` result includes the explicit `AuthorizedCloudProjectBinding`
and the caller's SDK for the next owned service integration. Do not persist that
client, bypass its user identity, or import BFF source into privileged services.

## Schema and compatibility findings

Applied Cloud migrations:

- `20260912182303_openlink_cloud_project_links.sql` was already applied
  (SHA256: `b42adec37d0007882d2e05a2ebaf2374c5bc5dd82c9b56c79c8abbca3a7706fd`).
- The following missing runtime-schema migrations were then applied separately:
  - `20260810200000_project_ssh_execution_targets.sql`
  - `20260810201000_project_runtime_execution_modes.sql`
  - `20260810202000_project_ssh_known_hosts.sql`
- Later UI-required columns were missing as well; these repository migrations
  were applied when the live page identified them:
  - `20260908090000_project_runtime_progress.sql`
  - `20260827000000_chat_sessions_agent_selection.sql`

The `openlink.projects` execution, SSH, and agent-selection columns, and the
`project_runtimes` execution and provisioning-phase columns now exist on
`supabase-us`. Migration versions were recorded in
`supabase_migrations.schema_migrations`; RLS remains enabled on `projects` and
`project_runtimes`.

The canonical project/runtime migration files define `local` as the default
execution mode. Adding those NOT NULL columns with that default classified the
five projects present at migration time as `local`; the three existing runtime
rows read as `local`/`provisioning` and the new phase column is `queued`. The
agent-selection migration defaults existing projects/sessions to `codex`.
These are schema defaults and display-state backfills, not evidence that the
migrations started a VM, Agent Host, or image pull. No service was started or
restarted by the migrations. Cloud onboarding must continue to avoid invoking
the Local supervisor; VTSLX Workspace execution is not yet wired into chat.

## Verification and remaining gates

The earlier mapping/RLS/route checks cover member-vs-admin permissions, remote
visibility rechecks, revision conflicts, direct-write guards, body limits,
identity override rejection, no native SSH change and metadata-only unlink.
They do not verify the Cloud onboarding UI added afterward. No test suite or
browser automation was run for this onboarding change.

The source now starts a loopback SDK Host in Cloud mode and includes the
Computer status route, but positive authenticated Computer access has not been
accepted live. A successful project-list response, metadata link or Computer
status call is not proof that OpenLink chat execution uses Studio Computer.
Streaming chat execution, runtime adoption, reconnection/revocation cleanup,
migration rollback and first-party end-to-end checks remain required.

The read-only operator preflight is `scripts/live-platform-project-link-preflight.mjs`;
it takes credentials through hidden stdin and never creates a project or VM.
