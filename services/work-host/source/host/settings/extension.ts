/** The settings as a host extension: the service is wired here and closed with the host. */
import { defineHostExtension } from "../extensions/host-extensions.ts";
import { HostExtensions } from "../extensions/extension-ids.generated.ts";
import { SettingsService } from "./settings-service.ts";

export const settingsExtension = defineHostExtension({ id: HostExtensions.Settings, dependencies: [], start: () => new SettingsService() });
