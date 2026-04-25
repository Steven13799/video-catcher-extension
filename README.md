# Video Catcher

Video Catcher is a Manifest V3 browser extension for Chromium-based browsers. It detects media resources in the active tab and offers direct download, HLS download for simple playlists, or local recording when the site does not expose a downloadable file.

The project is designed for personal backups, debugging media delivery, and legitimate access to media you are allowed to save.

## Features

- Detects direct video files and stream manifests through `webRequest`.
- Scans the DOM, resource timing entries, embedded JSON/script URLs, `blob:` video usage, and media element changes.
- Supports common media/CDN patterns used by YouTube, TikTok, X/Twitter, Facebook, Instagram, Vimeo, Dailymotion, Reddit, Twitch, and generic CDNs.
- Downloads direct resources through `chrome.downloads` first.
- Downloads simple unencrypted HLS playlists (`.m3u8`) by concatenating segments.
- Falls back to recording the main `<video>` element with `MediaRecorder` when direct download is not possible.
- Optional `Descargar Pro` mode through a local Native Messaging host with `yt-dlp` and `ffmpeg`.
- Per-site cookie opt-in for Pro downloads using Brave cookies locally.
- Provides a popup UI with safe DOM rendering and debug logs.

## Installation For Brave Or Chrome

1. Open `brave://extensions` or `chrome://extensions`.
2. Enable `Developer mode`.
3. Choose `Load unpacked`.
4. Select this repository folder.
5. Open a page with a video, play it, and then open the extension popup.

## Optional Pro Downloads With yt-dlp

For better support on sites such as YouTube, TikTok, X/Twitter, Facebook, Instagram and Vimeo, install the local native host:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1 -Browser Both
```

Then restart Brave/Chrome and press `Verificar Pro` in the popup. More details are in [docs/native-host.md](docs/native-host.md).

## Usage

- `Descargar`: starts a direct browser download.
- `Descargar HLS`: downloads a simple unencrypted HLS playlist.
- `Descargar Pro`: uses local `yt-dlp` + `ffmpeg` through the optional native host.
- `Cookies`: opt-in per site for `yt-dlp --cookies-from-browser brave`.
- `Grabar`: records the currently selected/main video element in the active tab.
- `Preview`: attempts to preview direct video URLs.
- `Logs`: opens internal detection/download logs for debugging.

## Limits

- This extension does not remove DRM or bypass protected media.
- Encrypted HLS is not downloaded; use recording only when allowed.
- DASH/MPD is detected; use Pro mode or recording when browser direct download cannot handle it.
- Some platforms change media delivery frequently, so detection may need updates.
- Downloads may fail when a resource requires short-lived signed URLs, cookies, referer checks, range requests, or anti-automation logic.
- Pro mode depends on current `yt-dlp` extractor support and local `ffmpeg`.
- Recording depends on browser support for `HTMLMediaElement.captureStream()`.

## Legal Notice

Use this project only with content you own, content you are authorized to download, or content whose license allows saving local copies. Respect website terms of service, copyright law, and local regulations. This project is not intended to circumvent DRM, access controls, paywalls, or private content.

## Project Structure

- `manifest.json`: extension manifest and permissions.
- `shared.js`: shared detection, URL, filename, and safety helpers.
- `background.js`: network detection, state, download dispatch, recording state.
- `content.js`: DOM detection, HLS download, preview, and recording.
- `injected.js`: page-context hooks for fetch/XHR/media assignment.
- `popup.html` / `popup.js`: popup interface.
- `icons/`: generated extension icons.
- `native-host/`: Rust Native Messaging host for `yt-dlp` + `ffmpeg`.
- `scripts/`: install, uninstall, tool download, and release packaging helpers.
- `docs/`: operational documentation.
- `tests/`: local tests and Brave smoke test.

## Development

Run syntax checks:

```powershell
node --check shared.js
node --check background.js
node --check content.js
node --check injected.js
node --check popup.js
cargo test --manifest-path native-host/Cargo.toml
```

Run tests:

```powershell
node tests/video-utils.test.mjs
node tests/brave-smoke.mjs
```

The Brave smoke test launches Brave headless with a temporary profile, loads the unpacked extension, serves a local fixture page, and checks MP4, HLS, embedded media URL, and recording-candidate detection.

## Screenshots

Add screenshots of the popup and extension icon before publishing a public release.

Suggested paths:

- `docs/screenshot-popup.png`
- `docs/screenshot-detected-videos.png`

## Release Checklist

- Test on Brave and Chrome.
- Confirm no temporary files or personal files are included.
- Confirm the legal notice is visible in the README.
- Create a version tag matching `manifest.json`.
- Package only the extension files needed by Chromium.

## License

MIT. See [LICENSE](LICENSE).
