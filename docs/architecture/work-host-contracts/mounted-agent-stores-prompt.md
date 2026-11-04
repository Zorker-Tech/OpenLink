# Mounted agent stores prompt contract

The user-info prompt omits the store section when no stores are mounted. Otherwise it lists stores in their input order
with absolute paths and identifies known self, user, team, automation, named-agent, peer, and shared-store kinds. An
unknown kind or principal alias is represented by its path without inventing an identity.

Read-only state is shown beside the path and changes the shared write guidance: read-only stores must not be written;
other listed stores may be read and written. The personal-store shortcut is included only when the user's own store is
present. The prompt also says that omitted stores are unavailable.
