/**
 * The files the host keeps that are its own, and that a box's store therefore excludes.
 *
 * They are the host's state — an upgrade it can resume, obligations it owes an acknowledgement for, wakes it has
 * pending, nonces it has seen, reminders it has queued — and none of them belong in a box's store.
 */
export const SLATE_UPGRADE_RESUME_FILE_NAME = "host-upgrade-resume.json";
export const SLATE_ACK_OBLIGATIONS_FILE_NAME = "ack-obligations.json";
export const SLATE_PENDING_WAKE_FILE_NAME = "host-pending-wakes.json";
export const SLATE_XUSER_TURN_DEDUPE_FILE_NAME = "host-xuser-turn-nonces.json";
export const SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME = "host-disk-pressure-reminders.json";
export const BOX_STORE_SLATE_DATA_EXCLUDED_FILE_NAMES = [SLATE_UPGRADE_RESUME_FILE_NAME, SLATE_ACK_OBLIGATIONS_FILE_NAME, SLATE_PENDING_WAKE_FILE_NAME, SLATE_XUSER_TURN_DEDUPE_FILE_NAME, SLATE_DISK_PRESSURE_REMINDERS_FILE_NAME] as const;
