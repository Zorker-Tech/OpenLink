/** Host-owned state filenames, shared by their stores and box-store filtering. */
const HOST_DURABLE_STATE_FILES = {
  upgradeResume: "host-upgrade-resume.json",
  acknowledgementObligations: "ack-obligations.json",
  pendingWakes: "host-pending-wakes.json",
  sharedRoomNonces: "host-xuser-turn-nonces.json",
  diskPressureReminders: "host-disk-pressure-reminders.json",
} as const;

export const {
  upgradeResume: SLATE_UPGRADE_RESUME_FILE_NAME,
  acknowledgementObligations: SLATE_ACK_OBLIGATIONS_FILE_NAME,
  pendingWakes: SLATE_PENDING_WAKE_FILE_NAME,
  sharedRoomNonces: SLATE_XUSER_TURN_DEDUPE_FILE_NAME,
  diskPressureReminders: SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME,
} = HOST_DURABLE_STATE_FILES;

export const BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES = [
  SLATE_UPGRADE_RESUME_FILE_NAME,
  SLATE_ACK_OBLIGATIONS_FILE_NAME,
  SLATE_PENDING_WAKE_FILE_NAME,
  SLATE_XUSER_TURN_DEDUPE_FILE_NAME,
  SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME,
] as const;
