/** Noticing that a conversation's own files changed.

 * The profile, the settings and the picture beside an agent's database are watched, and a change to any of them is
 * coalesced into one roster update and one announcement — so what the platform shows follows what is on disk, whether
 * the change came from this host or from a person editing the file. */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import type { EventEmitter } from "node:events";

import { SLATE_DEFAULT_AGENT_NAME } from "../../shared/agents/agents.ts";
import {
  invalidateAvatarDataUrlCache,
  isConventionalAvatarFilename,
} from "../agents/agent-avatar.ts";
import {
  getSlateProfilePath,
  readSlateProfileFile,
  SLATE_PROFILE_FILENAME,
} from "../agents/agent-profile.ts";
import {
  getSlateSettingsPath,
  SLATE_SETTINGS_FILENAME,
} from "../agents/settings-file.ts";
import type { RosterEmit } from "./roster-emit.ts";
import type { Disposable, TranscriptManagerLike } from "./transcript-hub.ts";

export const PROFILE_WATCH_DEBOUNCE_MS = 50;

export class ProfileWatch {
  readonly lastKnownAgentNames = new Map<string, string>();
  private profileWatcher: FSWatcher | undefined;
  private profileWatchTimer: Disposable | undefined;
  private watchedProfileAgentId: string | undefined;

  constructor(
    readonly tm: TranscriptManagerLike,
    readonly emitter: EventEmitter,
    readonly rosterEmit: RosterEmit,
  ) {}

  emitProfileChanged(profileAgentId: string): void {
    this.recordNameChangeEvent(profileAgentId);
    this.emitter.emit("profile-changed", { agentId: profileAgentId });
  }

  recordNameChangeEvent(profileAgentId: string): void {
    const resolvedName =
      this.tm.sessionStore.getAgentProfileText(profileAgentId)?.name.trim() ?? "";
    if (resolvedName.length === 0) return;
    const knownName = this.lastKnownAgentNames.get(profileAgentId);
    this.lastKnownAgentNames.set(profileAgentId, resolvedName);
    if (knownName == null || knownName === resolvedName) return;
    this.tm.emitTimelineEvent(profileAgentId, {
      type: "name-changed",
      from: knownName,
      to: resolvedName,
    });
  }

  seedKnownAgentName(profileAgentId: string): void {
    if (this.lastKnownAgentNames.has(profileAgentId)) return;
    const displayName =
      this.tm.sessionStore.getAgentProfileText(profileAgentId)?.name.trim() ?? "";
    if (displayName.length > 0) this.lastKnownAgentNames.set(profileAgentId, displayName);
  }

  subscribeProfileChanged(
    changeListener: (watchEvent: { agentId: string }) => void,
  ): () => void {
    this.emitter.on("profile-changed", changeListener);
    return () => this.emitter.off("profile-changed", changeListener);
  }

  watchSessionProfile(profileSession: { id: string; dbPath: string }): void {
    if (this.watchedProfileAgentId === profileSession.id) return;
    this.stopWatchingProfile();
    this.watchedProfileAgentId = profileSession.id;
    this.seedKnownAgentName(profileSession.id);
    try {
      this.profileWatcher = watch(
        dirname(profileSession.dbPath),
        (_event, changedFilename) => {
          if (
            changedFilename !== SLATE_PROFILE_FILENAME &&
            changedFilename !== SLATE_SETTINGS_FILENAME &&
            (changedFilename == null || !isConventionalAvatarFilename(changedFilename))
          )
            return;
          this.scheduleProfileEmit();
        },
      );
    } catch {
      // A missing/unwatchable directory is refreshed by normal roster emits.
    }
  }

  scheduleProfileEmit(): void {
    if (this.profileWatchTimer != null) return;
    this.profileWatchTimer = this.tm.clock.schedule(
      PROFILE_WATCH_DEBOUNCE_MS,
      () => {
        this.profileWatchTimer = undefined;
        const profileAgentId = this.watchedProfileAgentId;
        if (profileAgentId == null) {
          void this.rosterEmit.emitAgents();
          return;
        }
        const activeSession = this.tm.sessions.activeSession;
        if (activeSession?.id === profileAgentId)
          invalidateAvatarDataUrlCache(dirname(activeSession.dbPath));
        void this.rosterEmit.emitAgentUpdate(profileAgentId);
        this.emitProfileChanged(profileAgentId);
      },
    );
  }

  stopWatchingProfile(): void {
    this.profileWatcher?.close();
    this.profileWatcher = undefined;
    this.profileWatchTimer?.dispose();
    this.profileWatchTimer = undefined;
    this.watchedProfileAgentId = undefined;
  }

  async getAgentDisplayProfile(profileAgentId: string): Promise<{
    name: string;
    description: string;
  } | null> {
    const agentDirectory = this.tm.sessionStore.getAgentDir(profileAgentId);
    if (!existsSync(agentDirectory)) return null;
    const storedProfile = readSlateProfileFile(getSlateProfilePath(agentDirectory));
    return {
      name: storedProfile?.name.trim() || SLATE_DEFAULT_AGENT_NAME,
      description: storedProfile?.description ?? "",
    };
  }

  resolveAgentProfile(profileSession: { dbPath: string }): {
    name: string;
    description: string;
    filePath: string;
    settingsFilePath: string;
  } {
    const agentDirectory = dirname(profileSession.dbPath);
    const filePath = getSlateProfilePath(agentDirectory);
    const storedProfile = readSlateProfileFile(filePath);
    return {
      name: storedProfile?.name.trim() || SLATE_DEFAULT_AGENT_NAME,
      description: storedProfile?.description ?? "",
      filePath,
      settingsFilePath: getSlateSettingsPath(agentDirectory),
    };
  }
}
