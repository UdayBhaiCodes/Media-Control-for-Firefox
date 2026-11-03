# Media Control (Firefox)

A toolbar button that opens a Chrome-style media panel: every tab that has played audio or video, with title, thumbnail, progress bar, previous / back 10s / play-pause / forward 10s / next.

## Load it (to try it now)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and pick `manifest.json` from this folder.
3. Reload any tabs that were already open (the extension can only watch pages loaded after it was installed).
4. Click the puzzle-piece icon, then the pin next to **Media Control** to put it on the toolbar.

Temporary add-ons disappear when Firefox restarts. For a permanent install, see below.

## Install permanently (free, personal use)

Regular Firefox only keeps signed extensions. Mozilla signs them for free, and you don't need to publish anything.

1. Create a free account at https://addons.mozilla.org/developers/
2. **Submit a New Add-on** > **On your own** (unlisted) > upload `media-control.zip`.
3. After the automatic check passes, download the signed `.xpi`.
4. In Firefox: `about:addons` > gear icon > **Install Add-on From File...** > pick the `.xpi`.

Every time you change the code, raise `"version"` in `manifest.json` before uploading again.

## Good to know

- **Private windows:** `about:addons` > Media Control > **Run in Private Windows** > Allow.
- **Permissions:** if nothing shows up, open `about:addons` > Media Control > Permissions and make sure "Access your data for all websites" is on.
- **Previous / next track** only work on sites that provide them (YouTube playlists, YouTube Music, Spotify Web, etc.). Otherwise those buttons are greyed out. Back/forward 10s always work.
- Tabs with a camera/call stream (WebRTC) are ignored, and so are pages that haven't played anything yet.
- Firefox 128 or newer is required.
