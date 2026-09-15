# Cloud connection settings

## User-facing integration

The existing `/settings` page now includes a Cloud account section **only when
the server runtime mode is Cloud**. Local omits the component entirely. The
section reuses the preferences page's setting row, typography, width and theme
variables; it does not introduce a separate settings layout.

The browser talks only to same-origin BFF routes using cookies. It never receives
OAuth/model keys, encrypted vault records or refresh credentials, and it does
not write Cloud credentials to localStorage. Userinfo subject verification stays
in the BFF/SDK. Chinese and English copy follow the stored settings locale.

| Observed condition | Display / action |
| --- | --- |
| Initial fetch pending | Loading, not an empty connection claim |
| Fetch failed | Status unavailable; Connect remains disabled |
| Stored active authorization | Stored but unverified until status check succeeds |
| Verified matching subject | Identity verified; no claim about project/runtime readiness |
| Reauthentication needed | Clear the old connection explicitly before reconnecting |
| Revocation pending | Pending state and retry action, not successful cleanup |
| Login flag disabled | Explicit unavailable notice; no new login initiation |

Connect accepts an authorization destination only on `https://auth.hydite.com`,
without URL credentials or a fragment. Unmount/cancellation prevents a delayed
response from navigating afterward. Mutations are not automatically retried;
a synchronous in-flight guard prevents duplicate clicks. Refresh and action
responses cannot overwrite a newer request after cancellation.

The browser client validates response shapes, bounds responses to 64 KiB and
lists to 100 entries, uses HTTP deadlines, refuses redirects and projects only
safe metadata. Server-side list pagination and pending-connection quotas still
need closure before claiming full scale/abuse-resistance; browser bounds do not
prove bounded database aggregation.

Buttons expose keyboard focus, loading regions use aria-busy, messages use a
polite status region, and busy icons respect reduced motion. Long identifiers
wrap inside the existing setting-row width.

## Verification

- Five browser-client tests and six DOM/page tests pass: safe metadata, issuer
  restriction, subject matching, no mutation replay, response bounds/cancellation,
  stored-vs-verified state, unavailable-vs-empty state, disconnect double-click,
  pending revocation, disabled login, cancellation before navigation and Local
  page omission.
- All Cloud-focused tests total **59 passing**.
- Focused TypeScript verification passed for the changed UI and dependencies.
- `pnpm build:web` passed with Next 16.2.11; the settings and Cloud API/callback
  routes are dynamic in the build output. The repository's existing build config
  skips full-project type checking; that was not represented as a full type pass.
- JSDOM 28.1.0 is a test-only dependency. DOM checks are logic/markup tests, not
  visual browser screenshots or production authentication acceptance.

No production deployment, login-flag enablement, VM creation or user-data mutation
occurred in this UI batch. Actual visual/browser acceptance remains outstanding.
The designated test account still requires normal OpenLink onboarding/project
creation and the known Cloud schema/runtime prerequisites before the full flow
can be accepted. See the login, storage and project-reference guides.
