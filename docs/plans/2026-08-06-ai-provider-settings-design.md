# AI provider settings

OpenLink exposes account-level AI provider settings at `/settings/ai-providers`. The settings surface mirrors the Figma settings shell: a 250px settings navigation, a provider index, and a provider detail view with enablement, API credentials, endpoint override, connectivity test, and model selection.

Provider and model metadata comes from the vendored Pi source. OpenLink does not maintain a competing runtime catalog. The UI catalog maps the 39 Pi built-in providers to presentation metadata while model rows are loaded from `services/pi/packages/ai/src/providers/data/*.json`.

Provider secrets are encrypted on the Next.js server with AES-256-GCM before being stored in Supabase. The browser receives only a short key hint. The authenticated chat route resolves the selected provider/model, decrypts the secret server-side, and forwards a validated runtime configuration over the bearer-authenticated loopback Agent Host API. OpenSandbox receives only a sentinel inside the workload. Its Credential Vault replaces that sentinel on egress to the configured provider host. The desktop sandbox-runtime path uses its host-scoped credential masker in the same way.

Changing provider, model, endpoint, or configuration revision rotates the live Agent Host session. This prevents a session created with one credential from silently retaining it after the user changes settings. OAuth-only providers remain visible in the Pi catalog; API-key and ambient-token providers are configurable in this first slice, while OAuth authorization uses Pi's native login flow when that host flow is exposed.

All Supabase tables use RLS and owner-only policies. Inputs are validated with Zod, provider ids must exist in the Pi catalog, model ids must belong to the selected provider, endpoints must be HTTP(S), and secrets are never included in logs or error responses.
