/** The channels a client's own storage is read, written and migrated over. */
export const CLIENT_PERSISTENCE_CHANNELS = {
  read: "slate:client-persistence-read",
  write: "slate:client-persistence-write",
  remove: "slate:client-persistence-remove",
  listKeys: "slate:client-persistence-list-keys",
  migrate: "slate:client-persistence-migrate",
} as const;
