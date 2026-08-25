# Medius

Medius is a C# file browser and local-first media player. The browser UI is a Blazor WebAssembly app with native HTML/CSS; the HTML5 `<video>` element handles native browser playback and ffmpeg.wasm when a container or codec needs conversion.

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
- Live subtitle replacement by clicking an adjacent subtitle, without restarting or seeking the video
- Subtitle appearance controls for font size and background opacity
- Optional Nexis-compatible Azure ghost hydration
- Multiple named provider mounts shown at the explorer root
- Native browser downloads for cloud and offline files
- Browser Cache Storage for original-file offline media
- Configurable browser cache for converted fragments, with selectable original/1080p/720p/480p output
- Installable/offline-capable browser shell with service-worker caching and Range responses
- Custom playlists with optional start/end ranges and keep-offline pinning
- Automatic History playlist with per-item removal and clearing
- Encrypted app-state synchronization through a designated Azure Blob mount
- Encrypted app-state file export/import and password-equivalent QR transfer from a camera or image
- Browser `localStorage` app-state persistence

## Run

```powershell
Set-Location src\Medius\Medius.Browser
npm install
npm run build
Set-Location ..\..\..
dotnet run --project src\Medius\Medius.Browser\Medius.Browser.csproj
```

The generated ffmpeg bundle and single-threaded core are served locally from `wwwroot`; media is not sent to a transcoding service. Unsupported formats are converted piece by piece into fragmented MP4: playback starts after a 5-second piece, and 10-second pieces are then converted ahead of the playhead so playback continues without gaps. Pieces are placed on the real media timeline, so the scrubber shows the true duration and seeking works — a seek converts from the exact target position, and jumping back into already-converted media resumes immediately. Media that has been watched is released so long files stay within the browser's buffer limits. When the provider supports HTTP Range, ffmpeg reads a lazy range-backed virtual file and playback can start before the complete source downloads; Medius falls back to a full WORKERFS blob only for sources without Range support.

The player status separates **Downloading**, **Converting**, **Buffered**, and **Playing**. During range-backed reads it reports unique source bytes fetched, total source size, and the current ffmpeg range chunk; during segmented conversion it reports the 5- or 10-second segment and its generated size. Source access and ffmpeg initialization run concurrently, Transcode playback starts from a 5-second segment, and later canonical segments continue to fill the converted cache in the background.

Starting another video immediately pauses and clears the current player, cancels its ffmpeg worker, and displays a loading overlay while the replacement video hydrates or converts.

The browser UI is mobile-first: narrow screens keep the library full-height with a collapsible video preview at the bottom, while wider screens keep the library and player side-by-side. Starting playback expands the preview automatically. Click a media-type icon once to open/play/apply it, or double-click the rest of the row. Use the large row ellipsis, desktop right-click, or mobile press-and-hold for playlist and offline actions. Subtitle controls are kept in a collapsible menu. Native HTML inputs are used throughout, so Android keyboard and touch interactions work without a custom text modal.

`wwwroot/harness.html` runs the player against local files in `wwwroot/testmedia/` without the Blazor app or cloud storage, which is the quickest way to debug playback and seeking:

```powershell
Set-Location src\Medius\Medius.Browser
npm run build
python -m http.server 8090 --directory wwwroot
```

Use **••• → Add storage mount** to attach a provider. Each mount requires a unique display name and appears as a folder at the explorer root. Browser state is stored under `medius.mounts.v1` in that origin's `localStorage`.

Use a file's **••• → Download** action to save it through the browser download manager. Medius stages large cross-origin files in browser-managed private storage rather than holding the complete file in JavaScript memory, and includes Azure OAuth headers when required.

## Offline media and playlists

Open **Playlists & offline** to:

- Keep an original media file offline or remove its offline copy from the item's action menu.
- View all current offline files.
- Create playlists and add a video from its action menu, with optional start/end seconds configured in this panel.
- Pin a playlist so all its original files are downloaded for offline use.
- Open or clear the automatic **History** playlist.
- Remove individual playlist/history entries or delete custom playlists.

The browser requests persistent Cache Storage, and a service worker caches the app shell plus media. Cached media is exposed through same-origin URLs with HTTP Range support, so direct video seeking and ffmpeg conversion both work with the network disconnected. Converted fragments are cached separately with an LRU size limit and can be cleared from **Playlists & offline**. AVI/MKV can retain their original resolution or convert to 1080p, 720p, or 480p. The published app must be served over HTTPS (or `localhost`) for service workers and persistent storage.

## Background conversion queue

Use a video's context menu action **Add to background conversion queue** to pre-convert it into the segmented browser cache without starting playback. Open **Menu → Background conversions** to watch queued, downloading, converting, completed, cancelled, or failed jobs, cancel pending work, and clear finished entries. Repeated requests for the same media and resolution are coalesced into one queue entry.

Manual queue jobs run one at a time in a dedicated background ffmpeg.wasm worker so playback remains independent. During Transcode playback, the current video also appears in this panel while Medius fills cache entries ahead of the playhead; cancelling that entry stops future background-only cache fill but does not stop playback.

## Encrypted app-data sync

Choose **Menu → App data sync** to designate an Azure Blob or OneDrive mount and path for synchronized state (the default is `.medius-app-state.json.enc` at the mount root). Mounts, encrypted credentials, playlists, history, and offline intent are serialized into an AES-256-GCM envelope derived from a user passphrase with PBKDF2-SHA256 through Web Crypto.

The passphrase is never persisted. The designated bootstrap mount's own credential also stays local because it is required to retrieve the encrypted document; all other mount credentials are included only inside the encrypted envelope.

The encrypted envelope can also be exported as a file or transferred to another browser by QR camera/image scanning. Importing a file needs its passphrase but does not require a configured mount; scanning a QR adds the encoded mount automatically. A sync QR contains both the bootstrap credential and passphrase, so treat it like a password.

## Authentication

For SAS, paste the container/share SAS URL and leave the credential empty. For account-key authentication, enter the account name and key; the key remains in browser memory and is used to generate time-limited read SAS URLs for the HTML5 player.

Web-only OAuth requires an Entra app registration because Microsoft cannot issue a token from only a storage account name:

1. Register a **Single-page application** with the Medius URL as a redirect URI.
2. Enter its application/client ID and tenant (`common` is supported).
3. Select the provider and choose **Sign in**.
4. Grant `https://storage.azure.com/user_impersonation` for Azure Storage or `Files.Read User.Read` for OneDrive.

Tokens and keys are persisted in local app state when a mount is saved, and can optionally be synchronized only inside the encrypted app-state envelope. Azure Storage must allow the SPA origin in its CORS rules. Permit `GET, HEAD, OPTIONS`; ghost hydration and app-data sync additionally need `PUT` and authorization capable of reading tags/block lists and writing blobs.

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
| `Medius` | Shared view model and services (CommunityToolkit.Mvvm) |
| `Medius.Browser` | Blazor WebAssembly host, HTML5 player, ffmpeg.wasm, OAuth PKCE |

The browser head is the playback reference implementation.
