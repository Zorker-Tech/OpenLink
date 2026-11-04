# Notification host event routing contract

The notification extension depends on account authentication, creates one mobile-push notifier, subscribes to the host's
notification stream, and removes that subscription when stopped.

The host stream has four Slate-owned event cases: a baseline seeds state silently; a complete agent update forwards its
snapshot and window presence; one-agent upserts forward that agent and presence; and a forgotten-agent event removes its
ID from the decider. Event routing does not construct remote payloads. The notifier projects qualifying transitions to
the mobile-push interop adapter.
