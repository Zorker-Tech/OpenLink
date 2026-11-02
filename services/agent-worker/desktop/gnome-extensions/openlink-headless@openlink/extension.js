import * as Extension from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';

// GNOME exposes screen sharing and screen recording as clickable top-bar
// indicators. In T2 the remote desktop itself is the shared surface, so the
// orange indicator's stop action terminates the only display attached to the
// headless session and leaves the user on a black screen. The appliance has no
// local seat that could benefit from those controls, so keep them hidden.
const HIDDEN_INDICATORS = ['screenSharing', 'screenRecording'];
const HIDE_INTERVAL_MS = 250;

export default class OpenLinkHeadlessExtension extends Extension.Extension {
  enable() {
    this._hide = () => {
      for (const name of HIDDEN_INDICATORS) {
        const indicator = Main.panel.statusArea[name];
        if (indicator && indicator.visible) indicator.hide();
      }
      return GLib.SOURCE_CONTINUE;
    };
    this._hide();
    this._sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_INTERVAL_MS, this._hide);
  }

  disable() {
    if (this._sourceId) {
      GLib.source_remove(this._sourceId);
      this._sourceId = 0;
    }
  }
}
