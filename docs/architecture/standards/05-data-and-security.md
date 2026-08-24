# Data, identity, and security standards

## Identity and tenancy

ZOKERBASE Auth is the identity issuer for its own runtime domain. Local and
Cloud users may represent the same human but are not the same stored identity,
session, or JWT.

Every persistent application entity is owned by a user, organization,
workspace, or project. Server-side services receive explicit user/workspace
context and independently verify access. Authorization must not rely on
user-editable metadata.

Exposed ZOKERBASE tables use RLS. Privileged writes use a server-only service
role behind a service boundary, with the same workspace authorization checked
before every operation.

## Authoritative data map

| Data | Authority | Notes |
| --- | --- | --- |
| identities, sessions, memberships | ZOKERBASE Auth/PostgreSQL | Separate per Local/Cloud domain |
| workspaces, projects, runtime status | ZOKERBASE PostgreSQL | Transactional application state |
| chat events and Pi session entries | ZOKERBASE PostgreSQL | Ordered and append-safe |
| provider configuration | ZOKERBASE PostgreSQL | Secrets encrypted; summaries may be client-visible |
| project files and Git history | Project VM `/workspace` | Durable per project |
| generated application identities/data/objects | Project VM Supabase | Independent per Project; never OpenLink control-plane state |
| browser profiles/downloads | Browser Host runtime storage | Isolated per session/user |
| knowledge source, chunks, jobs | ZOKERBASE PostgreSQL | Auditable source of truth |
| vector entities/indexes | Zero | Rebuildable projection |
| image archives and VM bases | release/runtime artifact store | Immutable, versioned inputs |

## Secrets

Secrets are generated or entered at trusted server boundaries and must never
be returned in list/detail APIs. At minimum this includes:

- ZOKERBASE service-role and JWT signing material;
- Agent Host, Browser Host, and Knowledge Service bearer tokens;
- provider API keys and embedding-provider tokens;
- Zero credentials;
- SSH private keys and known-host policy;
- browser/session capability signing keys.
- Project VM Supabase database passwords, service/secret keys, JWT signing
  keys, dashboard credentials, pooler and encryption keys.

Project VM Supabase secrets are generated in the guest after cloning. They are
root-owned mode `0600`, are absent from the Golden Image and control-plane
rows, and are never returned to a browser or Agent response. Browser-safe
project integration may expose only the project gateway URL, publishable key,
legacy anon key and observed release. Direct PostgreSQL/Supavisor credentials
and service/secret keys require a separately authorized server capability.

Local mode may render upstream Supabase Studio only through the dedicated
`studio.localhost` BFF virtual host defined by ADR-0018. Its capability is
short-lived and project/session scoped; it is not a Supabase credential. The
VM controller injects Studio's Basic credential inside the guest. Cloud mode
must not expose this upstream administrative surface or Project VM ports.

Provider and SSH private material is encrypted with AES-256-GCM using the
OpenLink provider-secret boundary. Encryption binds ciphertext to its owner and
purpose through associated data. Database rows store ciphertext, IV, tag,
version, and a non-sensitive hint only.

`NEXT_PUBLIC_*` variables are public browser configuration and can never carry
a secret. Compatibility aliases are server-only unless their name explicitly
declares them public.

## Internal authentication

Long-lived service tokens remain server-side. Browser clients receive scoped,
short-lived, session-bound capabilities. Capabilities include only the exact
surface required by the operation and cannot be exchanged for a service token.

Internal services bind to loopback by default. Remote access uses an
authenticated gateway or SSH tunnel with strict host-key checking. Project VM
control ports, CDP, code-server, OpenSandbox, ZOKERBASE service APIs, and Zero
must not be exposed directly to the public network.

## Network policy

Execution workloads default to explicit network policy. A network grant
contains:

- normalized host/domain scope;
- requesting user/session/project;
- temporary or persistent mode;
- expiry for temporary grants;
- audit state and the decision source.

The Agent may request access but cannot silently grant it to itself. Persistent
grants survive only in the appropriate project/workspace policy store; they do
not become global host policy.

Browser URL policy rejects non-HTTP schemes and applies DNS-aware loopback,
private-network, allow-list, and deny-list checks. Local development loopback
exceptions are explicit and do not become production defaults.

## Knowledge isolation

Project VMs and clients call Knowledge APIs, never Zero directly. Knowledge
Service generates workspace and collection filters and does not accept raw
filter expressions from callers.

Embedding provider, model, and vector dimension form one index identity. A
different configuration requires a new/rebuilt Zero collection; vectors from
different embedding spaces must never be mixed.

No real embedding configuration means no knowledge ingestion or semantic
search. Deterministic/fake vectors are test fixtures only and must not appear as
a configured model in the product.

## Migrations and deletion

Schema changes are append-only SQL migrations under `zorkerbase/migrations/`,
applied in filename order and recorded in migration history. A migration must
be safe for both a new installation and an existing supported installation.

Deletion crosses every owned projection:

- deleting a knowledge document/collection deletes or tombstones PostgreSQL
  state and deletes its Zero vectors;
- deleting a project requires an explicit Project VM/runtime cleanup workflow;
- deleting a user or organization must respect ownership and retention rules.

Never declare deletion complete while an authoritative or security-sensitive
copy remains accessible.

## Logging and observability

Logs may contain IDs, status, timing, and redacted error context. They must not
contain raw provider keys, JWT signing secrets, cookies, SSH private keys,
authorization headers, full encrypted-secret envelopes, or unredacted user
documents.

Every long-running component exposes a health check that verifies its actual
critical dependency, not merely that a process exists. Health and readiness
are distinct where initialization can continue after process start.
