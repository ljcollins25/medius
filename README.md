# Medius

Medius is a C# file browser and local-first media player. The UI is shared Avalonia code; the browser head uses an HTML5 `<video>` element for native browser playback and ffmpeg.wasm when a container or codec needs conversion.

## Features

- Azure Blob Storage via container SAS URL, account key, or Entra OAuth token
- Azure Files via share SAS URL, account key, or Entra OAuth token
- OneDrive via Microsoft Graph OAuth
- Hierarchical folder browsing and configurable provider root
- Direct MP4/M4V/WebM playback
- Segmented local ffmpeg.wasm AVI/MKV transcoding for faster startup, MOV/TS remuxing with fallback transcoding, and first embedded subtitle extraction
- Adjacent `.vtt`, `.srt`, `.ass`, `.ssa`, and `.sub` discovery using names such as `Movie.en.srt`
- Explicit local or cloud subtitle selection
- Positive and negative subtitle offsets; SRT and VTT are converted to WebVTT before playback
- Optional Nexis-compatible Azure ghost hydration
- Multiple named provider mounts shown at the explorer root
- Browser `localStorage` and desktop local-disk mount persistence

## Run

```powershell
Set-Location src\Medius\Medius.Browser
npm install
npm run build
Set-Location ..\..\..
dotnet run --project src\Medius\Medius.Browser\Medius.Browser.csproj
```

The generated ffmpeg bundle and single-threaded core are served locally from `wwwroot`; media is not sent to a transcoding service. Unsupported formats are converted into fragmented MP4 pieces and playback starts after the first 5-second piece, while later 15-second pieces convert in the background. The source is mounted through WORKERFS so ffmpeg reads it in place instead of copying it into the wasm heap, audio and video streams that are already browser-compatible are copied rather than re-encoded, and the output resolution steps down automatically if conversion falls behind playback.

`wwwroot/harness.html` runs the player against local files in `wwwroot/testmedia/` without the Avalonia app or cloud storage, which is the quickest way to debug playback:

```powershell
Set-Location src\Medius\Medius.Browser
npm run build
python -m http.server 8090 --directory wwwroot
```

Use **File → Add storage mount** to attach a provider. Each mount requires a unique display name and appears as a folder at the explorer root. Browser mounts are stored under `medius.mounts.v1` in that origin's `localStorage`; desktop mounts are stored in `%LOCALAPPDATA%\Medius\mounts.json`. These records include credentials, so use a trusted local browser profile or OS account.

## Authentication

For SAS, paste the container/share SAS URL and leave the credential empty. For account-key authentication, enter the account name and key; the key remains in browser memory and is used to generate time-limited read SAS URLs for the HTML5 player.

Web-only OAuth requires an Entra app registration because Microsoft cannot issue a token from only a storage account name:

1. Register a **Single-page application** with the Medius URL as a redirect URI.
2. Enter its application/client ID and tenant (`common` is supported).
3. Select the provider and choose **Sign in**.
4. Grant `https://storage.azure.com/user_impersonation` for Azure Storage or `Files.Read User.Read` for OneDrive.

No token or key is persisted by Medius. Azure Storage must allow the SPA origin in its CORS rules. Permit `GET, HEAD, OPTIONS`; ghost hydration additionally needs `PUT` and authorization capable of reading tags/block lists and committing blocks.

## Ghost blobs

Azure Blob hydration is automatic when tags match the protocol in `Nexis.Azure.Utilities`: a zero-length committed blob tagged `ghostd_state=ghost`, `ghostd_size=<logical bytes>`, and `ghostd_block_prefix=<prefix>`. The explorer displays `ghostd_size` rather than the zero-byte committed length. On content access Medius:

1. Reads tags and the uncommitted block list.
2. Selects matching blocks in ordinal block-ID order.
3. Verifies their total exactly equals `ghostd_size`.
4. Commits using the current blob ETag and marks the state active.

Malformed or concurrently changed ghosts fail visibly rather than serving partial content.

Uncommitted Azure blocks expire after seven days unless refreshed. A blob can therefore remain tagged as a ghost after its staged content has expired; Medius rejects that blob rather than committing an empty or partial file.

To run the opt-in live listing test without storing a SAS in this repository:

```powershell
$env:MEDIUS_TEST_AZURE_BLOB_SAS = '<container SAS URL>'
dotnet test tests\Medius.Core.Tests\Medius.Core.Tests.csproj
Remove-Item Env:\MEDIUS_TEST_AZURE_BLOB_SAS
```

## Projects

| Project | Purpose |
|---|---|
| `Medius.Core` | Provider contracts, media planning, subtitle discovery/conversion |
| `Medius.Providers.Azure` | Azure Blob, Azure Files, OneDrive, ghost hydration |
| `Medius` | Shared Avalonia UI and view model |
| `Medius.Browser` | WebAssembly head, HTML5 player, ffmpeg.wasm, OAuth PKCE |
| `Medius.Desktop` | Native test shell for the shared Avalonia UI |

The browser head is the playback reference implementation. The desktop head intentionally does not replace the browser media engine; a production desktop wrapper should host the published browser app in WebView2 so playback behavior remains identical.
