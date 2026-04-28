# Native Host: yt-dlp + ffmpeg

Video Catcher can optionally use a local Native Messaging host to run `yt-dlp` and `ffmpeg`. This is the recommended path for sites that do not expose a simple downloadable media file, such as YouTube, TikTok, X/Twitter, Facebook, Instagram, Vimeo and other extractor-supported platforms.

The browser extension still works without this host. In that case it keeps using direct download, HLS fetch and recording.

## What It Does

- Runs `yt-dlp.exe` locally from the extension popup.
- Uses `ffmpeg.exe` for muxing, merging and remuxing streams.
- Prioritizes compatible MP4 downloads: H.264/AVC video plus AAC/M4A audio when available.
- Saves files by default to `%USERPROFILE%\Downloads\Video Catcher`.
- Supports canceling the active Pro download.
- Supports opt-in cookies per site using `--cookies-from-browser brave`.

## Install For Brave Or Chrome

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1 -Browser Both
```

The installer will:

- Build `native-host\target\release\video-catcher-host.exe` if Cargo is available.
- Download `yt-dlp.exe` and `ffmpeg.exe` into `native-host\tools` if they are missing.
- Copy the host and tools to `%LOCALAPPDATA%\VideoCatcher\NativeHost`.
- Register the Native Messaging manifest for Brave and Chrome under `HKCU`.

Restart Brave or Chrome after installing the host.

## Verify

1. Load the extension unpacked from this repository folder.
2. Open the popup.
3. Press `Verificar Pro`.
4. The panel should report `Host Pro listo para yt-dlp + ffmpeg`.

The extension ID is pinned by `manifest.json`:

```text
jjmpkelicjdcdmiiiopaipbpcbnnfalj
```

The native manifest allows:

```text
chrome-extension://jjmpkelicjdcdmiiiopaipbpcbnnfalj/
```

If you publish to the Chrome Web Store, the store may assign a different ID. In that case update `native-host\host-manifest\com.video_catcher.host.json.template` and reinstall the host with the final extension ID:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-native-host.ps1 -ExtensionId "FINAL_EXTENSION_ID"
```

## Download Tools Only

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\download-tools.ps1
```

This stores the tools in:

```text
native-host\tools
```

That folder is ignored by Git.

## Package A Release Zip

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

The release zip is created in `.release\` and includes:

- The extension files.
- The compiled native host binary.
- `yt-dlp.exe` and `ffmpeg.exe`.
- Install/uninstall scripts.
- Native host documentation.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-native-host.ps1
```

Use `-KeepFiles` to remove only the registry entries and keep `%LOCALAPPDATA%\VideoCatcher\NativeHost`.

## Cookies

The popup has a `Cookies` toggle next to `Descargar Pro`. It is off by default and stored per domain.

When enabled, the host runs:

```text
--cookies-from-browser brave
```

Use it only on sites where you are logged in and allowed to save the content. Cookies are not sent to the extension UI; `yt-dlp` reads them locally from Brave.

## Limits

- This does not bypass DRM, paywalls or access controls.
- Only one Pro download runs at a time.
- Some sites may still block automation or require updated `yt-dlp`.
- Brave may need to be closed for cookie extraction on some systems.
