# Per-agent workflow enablement contract

Each agent keeps its workflow preferences in `enabled-workflows.json` beside the agent. A missing, unreadable, invalid,
or non-object file means no explicit preference, so workflows default to enabled. Only string IDs are recognized, and
duplicates collapse to one ID.

The current `disabled` list is authoritative: an ID in it is disabled even if the same ID appears in the legacy
`enabled` list. Writes sort IDs, preserve valid legacy enabled IDs, create the agent directory when necessary, and
replace the state file through a temporary sibling file. Repeating a state change, forgetting an absent ID, or enabling
a batch with no disabled matches does not write the file.

Forgetting one workflow and enabling several remove only their matches from the disabled set. Clone behavior copies the
state file as an agent companion file, preserving the source agent's preference state.
