/** Persistent channel metadata for one session. */
import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { createDebouncePolicy, realClock } from "../scheduling.ts"
import { isSafeFolderId } from "../../storage/folder-id.ts"
import { WatchedDirectory } from "../../watched-directory.ts"
import { readConfiguredChannelLabel } from "./channel-store-config.ts"
import { channelDisplayName } from "./channel-store-labels.ts"

export const CHANNELS_DIRNAME = "channels"
export const CHANNEL_CONFIG_FILENAME = "connection.json"
export const CHANNEL_CHANGE_DEBOUNCE_MS = 50

export function getAgentChannelsDir(agentDirectory: string): string {
  return join(agentDirectory, CHANNELS_DIRNAME)
}

export class FileChannelStore {
  readonly dir: WatchedDirectory

  constructor(readonly channelsDir: string) {
    this.dir = new WatchedDirectory(
      channelsDir,
      createDebouncePolicy(realClock, {
        name: "slate-channel-store-change",
        delayMs: CHANNEL_CHANGE_DEBOUNCE_MS,
      }),
    )
  }

  getLocation(): string {
    return this.dir.getLocation()
  }

  setOnChange(onChange?: (() => void) | null): void {
    this.dir.setOnChange(onChange)
  }

  configPath(platform: string): string {
    return join(this.channelsDir, platform, CHANNEL_CONFIG_FILENAME)
  }

  listPlatforms(): string[] {
    let children
    try {
      children = readdirSync(this.channelsDir, { withFileTypes: true })
    } catch {
      return []
    }

    return children
      .filter((entry) => entry.isDirectory() && isSafeFolderId(entry.name))
      .map((entry) => entry.name)
      .filter((platform) => this.readLabel(platform) !== null)
      .sort()
  }

  readLabel(platform: string): string | null {
    return readConfiguredChannelLabel(this.configPath(platform))
  }

  listConnections(): Array<{ platform: string; label: string; status: "configured" }> {
    return this.listPlatforms().map((platform) => ({
      platform,
      label: this.readLabel(platform) ?? channelDisplayName(),
      status: "configured",
    }))
  }

  writeMetadata(platform: string, label: string): boolean {
    if (!isSafeFolderId(platform)) return false
    const record = { label: channelDisplayName(label) }
    this.dir.writeFileAtomic(this.configPath(platform), `${JSON.stringify(record, null, 2)}\n`)
    return true
  }

  remove(platform: string): boolean {
    if (!isSafeFolderId(platform)) return false
    const folder = join(this.channelsDir, platform)
    try {
      if (!statSync(folder).isDirectory()) return false
    } catch {
      return false
    }

    rmSync(folder, { recursive: true, force: true })
    this.dir.scheduleNotify()
    return true
  }
}
