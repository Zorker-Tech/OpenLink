# Architecture principles

## 1. One product lifecycle, multiple process boundaries

OpenLink is one product, but it is not one process. The root supervisor owns
installation, build, startup, health checks, and shutdown. Privileged execution
stays in dedicated services rather than Next.js request handlers.

The separation exists for authority and failure isolation, not because users
must operate independent products. A normal Local start is a single root
command.

## 2. Local and Cloud share capabilities, not state

Local and Cloud use the same application contracts, migrations, authorization
model, and service semantics. They are independent identity and data domains.

Local must never require Cloud URLs, JWT signing material, database rows, API
keys, or an online login. Moving data between modes is an explicit migration,
not login synchronization or runtime replication.

## 3. ZOKERBASE is authoritative; projections are replaceable

ZOKERBASE owns identity, authorization, workspace and project metadata, chat
events, provider settings, knowledge source text, chunks, and job state.

Zero owns a vector-search projection. Project VM disks own project files and
Git history. Pi JSONL is the native agent-session representation and is also
persisted through the application data contract. Derived state must be
rebuildable from its authoritative source.

## 4. A Project VM and a chat Worker are different lifecycles

A Project VM belongs to a project and owns `/workspace` plus long-lived project
services. An Agent Worker belongs to one chat session. Idle Workers may pause;
chat inactivity must not physically power off the Project VM while the
application is running.

Project initialization starts when a project is created. A project cannot
create or enter a chat until its runtime is ready. The Git repository is
initialized in `/workspace` on first session preparation and all change
statistics come from Git.

## 5. Privileged services are never browser dependencies

The browser talks to Next.js BFF routes. Project VMs and browser clients do not
receive service-role keys, Zero credentials, Browser Host service tokens,
OpenSandbox control-plane credentials, or SSH private keys.

Next.js does not import privileged runtime source. Agent Host, Browser Host,
Knowledge Service, and execution workers communicate through explicit,
authenticated contracts.

## 6. Default deny, explicit capability

Filesystem, process, browser, credential, and network authority is scoped to
the user, workspace, project, session, and operation. Outbound network access
is policy-controlled and can be granted temporarily or persistently through an
auditable user/agent decision flow.

## 7. Runtime artifacts are produced before serving requests

Ordinary startup runs product-owned images and immutable artifacts. It must not
pull an upstream machine OS, rebuild a Project VM base image, or compose an
image dynamically into every service start. Image production is an explicit
build/release activity.

Project disks use thin/sparse allocation where supported: logical capacity is
not the same as immediate host disk consumption.

## 8. Upstream source is vendored, reviewed, and isolated

Vendored projects are source inputs inside the root repository, not nested Git
repositories and not root workspace packages. Their revisions are pinned and
recorded. Product integrations live in OpenLink-owned adapters and overlays so
upstream updates remain reviewable.

## 9. Branding and compatibility are separate concerns

User-facing names are Zorker/OpenLink for the application, ZOKERBASE for the
Supabase-compatible data platform, Zero for the vector runtime, and ZeroLink
for its management surface. Upstream names may appear in source attribution,
wire-compatibility notes, and vendored code, but must not leak into product
runtime identity or ordinary user-facing configuration.

## 10. No fake readiness or fake capabilities

The UI and APIs must represent actual runtime state. A missing model, failed
VM, unavailable browser, or unhealthy service is reported as such. Tests may
use deterministic fixtures, but production and ordinary Local flows must not
present fixtures or fallback hashes as a real model or completed service.
