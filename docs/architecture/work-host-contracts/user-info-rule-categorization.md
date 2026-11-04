# User-info rule categorization contract

Run-environment filtering happens before categorization: local runs keep local and shared rules, background runs keep
cloud and shared rules, and bug-report runs remain unscoped.

Skill paths are handled first. Always-on skills join global rules; skills disabled for model invocation are omitted;
other skills remain requestable. For non-skills, user-origin rules go to the user group and team-origin rules are
always-on. Manually attached rules are omitted from requestable lists. Other non-global types are requestable. Global
rules nested below a workspace are requestable; a global at the workspace root remains always-on.

The categorizer consumes Slate-owned rule descriptors. Foreign path and schema details are interpreted by the
dedicated adapters and predicates.
