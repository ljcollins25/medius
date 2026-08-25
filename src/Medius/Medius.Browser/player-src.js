import { FFmpeg } from "@ffmpeg/ffmpeg";
import QRCode from "qrcode";
import { BrowserQRCodeReader } from "@zxing/browser";

let ffmpeg;
let bgFfmpeg;
let mediaObjectUrl;
let subtitleObjectUrl;
let ffmpegLogSink;
let bgFfmpegLogSink;
let segmentedActive = false;
let activeSegmentLoop;
let wholeFileProgress;
let activeDownloadController;
let playbackGeneration = 0;
let subtitleRevision = 0;
let conversionQueueSequence = 0;
let backgroundQueueRunner;
let activeBackgroundJob;
let convertedCacheMutation = Promise.resolve();
let browserAssemblyExports;
const remoteProgressSinks = new Map();
const ffmpegLog = [];
const bgFfmpegLog = [];
const conversionQueue = [];
const stagedDownloadCleanups = new Set();

const video = () => document.getElementById("media-player");
const status = () => document.getElementById("player-status");
const activity = () => document.getElementById("player-activity");
const mountsKey = "medius.mounts.v1";
const ffmpegAssetVersion = "3";
const offlineCacheName = "medius-media-v1";
const convertedCacheName = "medius-converted-v1";
const convertedCacheIndexKey = "medius.converted-cache-index.v1";

// Playback starts after this much media is ready; later pieces are longer for efficiency.
const FIRST_SEGMENT_SECONDS = 5;
const SEGMENT_SECONDS = 10;
const PREFETCH_SEGMENTS = 6;
// Conversion continuously fills this many segments ahead while old media is evicted behind.
const MAX_BUFFER_AHEAD_SECONDS = SEGMENT_SECONDS * PREFETCH_SEGMENTS;
const KEEP_BEHIND_SECONDS = 30;
const RANGE_LOG_PREFIX = "[medius-range]";
const STAGED_DOWNLOAD_PREFIX = "medius-download-";
const STAGED_DOWNLOAD_MAX_AGE_MS = 60 * 60 * 1000;

window.addEventListener("pagehide", () => {
    for (const cleanup of [...stagedDownloadCleanups]) void cleanup();
});

export function loadMounts() {
    return localStorage.getItem(mountsKey);
}

function describeSourceRead(downloadedBytes, totalBytes, currentChunkBytes) {
    const currentChunk = currentChunkBytes > 0
        ? ` · current range read ${formatBytes(currentChunkBytes)}`
        : "";
    return `source fetched ${formatBytes(downloadedBytes)}`
        + `${formatTotalBytes(totalBytes)}${currentChunk}`;
}

export async function clearConvertedCache() {
    await withConvertedCacheLock(async () => {
        await caches.delete(convertedCacheName);
        localStorage.removeItem(convertedCacheIndexKey);
    });
    return true;
}

export async function getConvertedCacheUsage() {
    await convertedCacheMutation;
    return readConvertedCacheIndex()
        .reduce((total, item) => total + item.size, 0);
}

export function saveMounts(json) {
    localStorage.setItem(mountsKey, json);
}

export async function enqueueConversion(
    uri,
    fileName,
    mediaKey,
    maxWidth = 854,
    convertedCacheLimitBytes = 536870912,
    sourceSizeBytes = 0,
    deferStart = false,
    resolverId = null) {
    const normalizedWidth = Math.max(0, Number(maxWidth) || 0);
    const existing = conversionQueue.find(job =>
        job.mediaKey === mediaKey
        && job.maxWidth === normalizedWidth
        && !["cancelled", "error"].includes(job.state));
    if (existing) {
        if (existing.kind === "playback" && existing.state !== "completed") {
            existing.manualRequested = true;
            if (resolverId) {
                if (existing.resolverId) await releaseQueuedUriResolver(existing.resolverId);
                existing.resolverId = resolverId;
            }
        } else if (existing.state === "completed"
            && await getFullyCachedDuration(mediaKey, normalizedWidth) === null) {
            conversionQueue.splice(conversionQueue.indexOf(existing), 1);
            await releaseQueuedUriResolver(existing.resolverId);
        } else {
            await releaseQueuedUriResolver(resolverId);
            return existing.id;
        }
        if (conversionQueue.includes(existing)) return existing.id;
    }
    for (let index = conversionQueue.length - 1; index >= 0; index--) {
        const stale = conversionQueue[index];
        if (stale.mediaKey === mediaKey
            && stale.maxWidth === normalizedWidth
            && ["cancelled", "error"].includes(stale.state)) {
            conversionQueue.splice(index, 1);
            await releaseQueuedUriResolver(stale.resolverId);
        }
    }

    const cachedDuration = await getFullyCachedDuration(mediaKey, normalizedWidth);
    if (cachedDuration !== null) {
        const completed = {
            id: `conversion-${++conversionQueueSequence}`,
            kind: "manual",
            uri,
            fileName,
            mediaKey,
            maxWidth: normalizedWidth,
            convertedCacheLimitBytes: Math.max(0, Number(convertedCacheLimitBytes) || 0),
            sourceSizeBytes: Math.max(0, Number(sourceSizeBytes) || 0),
            state: "completed",
            downloadedBytes: 0,
            totalBytes: 0,
            currentChunkBytes: 0,
            convertedSeconds: cachedDuration,
            durationSeconds: cachedDuration,
            currentSegmentBytes: 0,
            errorMessage: null,
            cancelled: false,
            abortController: null,
            session: null,
            resolverId: null
        };
        conversionQueue.push(completed);
        await releaseQueuedUriResolver(resolverId);
        return completed.id;
    }

    const job = {
        id: `conversion-${++conversionQueueSequence}`,
        kind: "manual",
        uri,
        fileName,
        mediaKey,
        maxWidth: normalizedWidth,
        convertedCacheLimitBytes: Math.max(0, Number(convertedCacheLimitBytes) || 0),
        sourceSizeBytes: Math.max(0, Number(sourceSizeBytes) || 0),
        state: "queued",
        downloadedBytes: 0,
        totalBytes: 0,
        currentChunkBytes: 0,
        convertedSeconds: 0,
        durationSeconds: 0,
        currentSegmentBytes: 0,
        errorMessage: null,
        cancelled: false,
        abortController: null,
        session: null,
        resolverId
    };
    conversionQueue.push(job);
    if (!deferStart) {
        void ensureBackgroundQueueRunner();
    }

    return job.id;
}

export async function startConversionQueue() {
    void ensureBackgroundQueueRunner();
    return true;
}

export async function getConversionQueue() {
    return JSON.stringify(conversionQueue.map(serializeConversionJob));
}

export async function cancelConversion(jobId) {
    const job = conversionQueue.find(item => item.id === jobId);
    if (!job) {
        return false;
    }

    job.cancelled = true;
    if (job.kind === "playback") {
        job.state = "cancelled";
        if (job.session) {
            job.session.backgroundCacheEnabled = false;
            job.session = null;
        }
        await releaseQueuedUriResolver(job.resolverId);
        return true;
    }

    if (job.state === "queued") {
        job.state = "cancelled";
        await releaseQueuedUriResolver(job.resolverId);
        return true;
    }

    job.state = "cancelled";
    job.abortController?.abort();
    if (activeBackgroundJob === job && bgFfmpeg) {
        bgFfmpeg.terminate();
        bgFfmpeg = undefined;
        bgFfmpegLogSink = undefined;
    }
    return true;
}

export async function clearCompletedConversions() {
    for (let index = conversionQueue.length - 1; index >= 0; index--) {
        if (["completed", "error", "cancelled"].includes(conversionQueue[index].state)) {
            await releaseQueuedUriResolver(conversionQueue[index].resolverId);
            conversionQueue.splice(index, 1);
        }
    }
    return true;
}

function serializeConversionJob(job) {
    return {
        id: job.id,
        fileName: job.fileName,
        mediaKey: job.mediaKey,
        state: job.state,
        downloadedBytes: Math.round(job.downloadedBytes ?? 0),
        totalBytes: Math.round(job.totalBytes ?? 0),
        currentChunkBytes: Math.round(job.currentChunkBytes ?? 0),
        convertedSeconds: Number(job.convertedSeconds ?? 0),
        durationSeconds: Number(job.durationSeconds ?? 0),
        currentSegmentBytes: Math.round(job.currentSegmentBytes ?? 0),
        errorMessage: job.errorMessage ?? null
    };
}

async function getFullyCachedDuration(mediaKey, maxWidth) {
    if (!("caches" in window)) {
        return null;
    }

    const first = await readConvertedSegment([
        "v2",
        mediaKey,
        (0).toFixed(3),
        FIRST_SEGMENT_SECONDS.toFixed(3),
        maxWidth
    ].join("|")).catch(() => null);
    if (!first?.probe || !Number.isFinite(first.probe.durationSeconds)) {
        return null;
    }

    const cache = await caches.open(convertedCacheName);
    const durationSeconds = first.probe.durationSeconds;
    let position = 0;
    let duration = FIRST_SEGMENT_SECONDS;
    while (position < durationSeconds - 0.2) {
        const key = ["v2", mediaKey, position.toFixed(3), duration.toFixed(3), maxWidth].join("|");
        if (!await cache.match(convertedSegmentRequest(key))) {
            return null;
        }
        position += duration;
        duration = SEGMENT_SECONDS;
    }

    return durationSeconds;
}

async function ensureBackgroundQueueRunner() {
    if (backgroundQueueRunner) {
        return backgroundQueueRunner;
    }

    backgroundQueueRunner = (async () => {
        while (true) {
            const next = conversionQueue.find(job =>
                job.kind === "manual"
                && job.state === "queued"
                && !job.cancelled);
            if (!next) {
                return;
            }

            activeBackgroundJob = next;
            try {
                await runManualConversionJob(next);
            } finally {
                if (activeBackgroundJob === next) {
                    activeBackgroundJob = undefined;
                }
            }
        }
    })().finally(() => {
        backgroundQueueRunner = undefined;
        if (conversionQueue.some(job => job.kind === "manual" && job.state === "queued" && !job.cancelled)) {
            void ensureBackgroundQueueRunner();
        }
    });

    return backgroundQueueRunner;
}

export async function cacheOfflineMedia(key, uri, bearerToken) {
    if (!("caches" in window)) {
        throw new Error("This browser does not support offline media storage.");
    }

    await navigator.storage?.persist?.();
    const response = await fetch(uri, bearerToken
        ? { headers: { Authorization: `Bearer ${bearerToken}`, "x-ms-version": "2023-11-03" } }
        : undefined);
    if (!response.ok) {
        throw new Error(`Offline download failed (HTTP ${response.status}).`);
    }

    const cache = await caches.open(offlineCacheName);
    await cache.put(offlineMediaRequest(key), response);
    return true;
}

export async function removeOfflineMedia(key) {
    if (!("caches" in window)) return false;
    const cache = await caches.open(offlineCacheName);
    return await cache.delete(offlineMediaRequest(key));
}

export async function getOfflineMediaUri(key) {
    if (!("caches" in window)) return null;
    const cache = await caches.open(offlineCacheName);
    return await cache.match(offlineMediaRequest(key))
        ? offlineMediaRequest(key).url
        : null;
}

export async function getOfflineStorageEstimate() {
    const estimate = await navigator.storage?.estimate?.();
    return JSON.stringify({
        usage: estimate?.usage ?? 0,
        quota: estimate?.quota ?? 0
    });
}

export async function encryptAppState(plaintextJson, passphrase) {
    const iterations = 210000;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAppStateKey(passphrase, salt, iterations, ["encrypt"]);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: nonce,
            additionalData: new TextEncoder().encode("medius-app-state-v1"),
            tagLength: 128
        },
        key,
        new TextEncoder().encode(plaintextJson)));
    const tag = encrypted.slice(encrypted.length - 16);
    const ciphertext = encrypted.slice(0, encrypted.length - 16);
    return JSON.stringify({
        Version: 1,
        Iterations: iterations,
        Salt: bytesToBase64(salt),
        Nonce: bytesToBase64(nonce),
        Tag: bytesToBase64(tag),
        Ciphertext: bytesToBase64(ciphertext)
    });
}

export async function decryptAppState(envelopeJson, passphrase) {
    const envelope = JSON.parse(envelopeJson);
    if (envelope.Version !== 1) {
        throw new Error(`Unsupported app-state envelope version ${envelope.Version}.`);
    }

    const salt = base64ToBytes(envelope.Salt);
    const nonce = base64ToBytes(envelope.Nonce);
    const ciphertext = base64ToBytes(envelope.Ciphertext);
    const tag = base64ToBytes(envelope.Tag);
    const encrypted = new Uint8Array(ciphertext.length + tag.length);
    encrypted.set(ciphertext);
    encrypted.set(tag, ciphertext.length);
    const key = await deriveAppStateKey(passphrase, salt, envelope.Iterations, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: nonce,
            additionalData: new TextEncoder().encode("medius-app-state-v1"),
            tagLength: 128
        },
        key,
        encrypted);
    return new TextDecoder().decode(plaintext);
}

export function exportAppDataFile(fileName, content) {
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadFile(uri, fileName, bearerToken) {
    const response = await fetch(uri, bearerToken
        ? {
            headers: {
                Authorization: `Bearer ${bearerToken}`,
                "x-ms-version": "2023-11-03"
            }
        }
        : undefined);
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);
    const staged = await stageBrowserDownload(response);
    const objectUrl = URL.createObjectURL(staged.file);
    triggerBrowserDownload(objectUrl, fileName);
    setTimeout(async () => {
        URL.revokeObjectURL(objectUrl);
        await staged.cleanup?.();
    }, 300000);
    return true;
}

async function stageBrowserDownload(response) {
    if (response.body && navigator.storage?.getDirectory) {
        const root = await navigator.storage.getDirectory();
        await cleanupStaleBrowserDownloads(root);
        const temporaryName = `${STAGED_DOWNLOAD_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
        const handle = await root.getFileHandle(temporaryName, { create: true });
        try {
            const writable = await handle.createWritable();
            await response.body.pipeTo(writable);
            const cleanup = async () => {
                stagedDownloadCleanups.delete(cleanup);
                await root.removeEntry(temporaryName).catch(() => {});
            };
            stagedDownloadCleanups.add(cleanup);
            return {
                file: await handle.getFile(),
                cleanup
            };
        } catch (error) {
            await root.removeEntry(temporaryName).catch(() => {});
            throw error;
        }
    }
    return { file: await response.blob(), cleanup: null };
}

async function cleanupStaleBrowserDownloads(root) {
    const cutoff = Date.now() - STAGED_DOWNLOAD_MAX_AGE_MS;
    for await (const [name, handle] of root.entries()) {
        if (!name.startsWith(STAGED_DOWNLOAD_PREFIX) || handle.kind !== "file") continue;
        try {
            const file = await handle.getFile();
            if (file.lastModified < cutoff) await root.removeEntry(name);
        } catch {
            await root.removeEntry(name).catch(() => {});
        }
    }
}

function triggerBrowserDownload(uri, fileName) {
    const anchor = document.createElement("a");
    anchor.href = uri;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => anchor.remove(), 0);
}

export function importAppDataFile() {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,.enc,application/json";
        input.hidden = true;
        document.body.appendChild(input);
        const finish = value => {
            input.remove();
            resolve(value);
        };
        input.oncancel = () => finish(null);
        input.onchange = async () => {
            const file = input.files?.[0];
            finish(file ? await file.text() : null);
        };
        input.click();
    });
}

export async function showSyncQr(payload) {
    if (new TextEncoder().encode(payload).byteLength > 650) {
        throw new Error("The sync credential is too large for a reliable QR code.");
    }
    const dataUrl = await QRCode.toDataURL(payload, {
        errorCorrectionLevel: "L",
        margin: 2,
        width: 360,
        color: { dark: "#07111fff", light: "#ffffffff" }
    });
    const overlay = document.getElementById("sync-qr-overlay");
    const image = document.getElementById("sync-qr-image");
    const camera = document.getElementById("sync-qr-camera");
    image.src = dataUrl;
    image.hidden = false;
    camera.hidden = true;
    document.getElementById("sync-qr-title").textContent = "Scan to sync Medius";
    document.getElementById("sync-qr-message").textContent =
        "This code contains the mount credential and passphrase. Treat it like a password.";
    document.getElementById("sync-qr-close").onclick = closeSyncQr;
    overlay.hidden = false;
    return true;
}

export async function scanSyncQrCamera() {
    const overlay = document.getElementById("sync-qr-overlay");
    const image = document.getElementById("sync-qr-image");
    const camera = document.getElementById("sync-qr-camera");
    image.hidden = true;
    camera.hidden = false;
    camera.autoplay = true;
    camera.muted = true;
    document.getElementById("sync-qr-title").textContent = "Scan sync QR";
    document.getElementById("sync-qr-message").textContent = "Requesting access to the rear camera…";
    overlay.hidden = false;

    if (!navigator.mediaDevices?.getUserMedia) {
        overlay.hidden = true;
        throw new Error("Camera access is unavailable. Use Scan image instead.");
    }

    const reader = new BrowserQRCodeReader();
    return await new Promise(async (resolve, reject) => {
        let controls;
        let stream;
        let finished = false;
        const stopStream = () => {
            for (const track of stream?.getTracks?.() ?? []) track.stop();
            camera.srcObject = null;
        };
        const finish = value => {
            if (finished) return;
            finished = true;
            controls?.stop();
            stopStream();
            overlay.hidden = true;
            resolve(value);
        };
        const fail = error => {
            if (finished) return;
            finished = true;
            controls?.stop();
            stopStream();
            overlay.hidden = true;
            reject(error);
        };
        document.getElementById("sync-qr-close").onclick = () => finish(null);
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: "environment" },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            });
            if (finished) {
                stopStream();
                return;
            }
            camera.srcObject = stream;
            await camera.play();
            document.getElementById("sync-qr-message").textContent =
                "Camera active. Point it at a Medius sync code.";
            controls = await reader.decodeFromStream(stream, camera, result => {
                if (result) finish(result.getText());
            });
            if (finished) {
                controls.stop();
                camera.srcObject = null;
            }
        } catch (error) {
            fail(error);
        }
    });
}

export function scanSyncQrFile() {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.hidden = true;
        document.body.appendChild(input);
        const finish = value => {
            input.remove();
            resolve(value);
        };
        input.oncancel = () => finish(null);
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return finish(null);
            const url = URL.createObjectURL(file);
            try {
                finish(await decodeSyncQrImage(url));
            } catch {
                finish(null);
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        input.click();
    });
}

export async function decodeSyncQrImage(url) {
    const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
    return result.getText();
}

export function closeSyncQr() {
    document.getElementById("sync-qr-overlay").hidden = true;
    const camera = document.getElementById("sync-qr-camera");
    for (const track of camera.srcObject?.getTracks?.() ?? []) track.stop();
    camera.srcObject = null;
}

async function deriveAppStateKey(passphrase, salt, iterations, usages) {
    const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(passphrase),
        "PBKDF2",
        false,
        ["deriveKey"]);
    return await crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        usages);
}

function bytesToBase64(bytes) {
    let binary = "";
    for (const value of bytes) binary += String.fromCharCode(value);
    return btoa(binary);
}

function base64ToBytes(value) {
    return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function offlineMediaRequest(key) {
    return new Request(
        new URL(`./__medius_offline/${encodeURIComponent(key)}`, location.href),
        { method: "GET" });
}

export function conversionStrategy(mode) {
    return mode === "Remux" ? "remux" : "transcode";
}

function beginPlaybackTransition(fileName, message) {
    const generation = ++playbackGeneration;
    activeDownloadController?.abort();
    activeDownloadController = undefined;
    window.setPlayerPreviewExpanded?.(true);
    const player = video();
    player.pause();
    player.removeAttribute("src");
    player.load();
    clearSubtitleTracks();
    clearObjectUrls();

    if (segmentedActive && ffmpeg) {
        ffmpeg.terminate();
        ffmpeg = undefined;
        ffmpegLogSink = undefined;
        segmentedActive = false;
    }

    setPlayerStatus(message.startsWith("Loading media") ? "Loading" : "Preparing", message);
    showLoading(`${message} ${fileName}`);
    return generation;
}

function showLoading(message) {
    const overlay = document.getElementById("player-loading");
    document.getElementById("player-loading-text").textContent = message;
    overlay.hidden = false;
}

function hideLoading() {
    document.getElementById("player-loading").hidden = true;
}

function setPlayerStatus(stage, detail) {
    const activityElement = activity();
    if (activityElement) {
        activityElement.textContent = stage;
        activityElement.dataset.stage = stage.toLowerCase();
    }
    const previewActivity = document.getElementById("player-preview-activity");
    if (previewActivity) previewActivity.textContent = stage;
    status().textContent = detail;
}

export async function playVideo(
    uri,
    fileName,
    mode,
    subtitleWebVtt,
    embeddedSubtitleOffsetMilliseconds,
    startSeconds = -1,
    endSeconds = -1,
    mediaKey = null,
    maxWidth = 854,
    convertedCacheLimitBytes = 536870912,
    sourceSizeBytes = 0) {
    const previousSegmentLoop = activeSegmentLoop;
    const generation = beginPlaybackTransition(
        fileName,
        mode === "Direct" ? "Loading media…" : "Loading ffmpeg.wasm…");

    try {
        await previousSegmentLoop?.catch(() => {});
        if (generation !== playbackGeneration) return false;

        if (mode === "Transcode" && "MediaSource" in window) {
            await playTranscodedSegments(
                uri,
                fileName,
                subtitleWebVtt,
                embeddedSubtitleOffsetMilliseconds,
                generation,
                startSeconds,
                endSeconds,
                mediaKey,
                maxWidth,
                convertedCacheLimitBytes,
                sourceSizeBytes);
            return true;
        }

        let source = uri;
        let extractedSubtitle;
        let conversionSummary;
        if (mode !== "Direct") {
            segmentedActive = true;
            try {
                ({ source, extractedSubtitle, conversionSummary } = await convertForBrowser(
                    uri,
                    fileName,
                    mode,
                    maxWidth,
                    generation));
            } finally {
                if (generation === playbackGeneration) segmentedActive = false;
            }
        }
        if (generation !== playbackGeneration) return false;

        const player = video();
        player.src = source;
        configurePlaybackRange(player, startSeconds, endSeconds);
        const subtitle = subtitleWebVtt
            ?? (extractedSubtitle
                ? shiftWebVtt(extractedSubtitle, embeddedSubtitleOffsetMilliseconds)
                : undefined);
        setSubtitleInternal(subtitle);
        await player.play();
        hideLoading();
        setPlayerStatus(
            "Playing",
            conversionSummary
                ? `${fileName} — fully converted ${formatBytes(conversionSummary.convertedBytes)}`
                    + ` · downloaded ${formatBytes(conversionSummary.downloadedBytes)}`
                    + `${formatTotalBytes(conversionSummary.totalBytes)}`
                : fileName);
        return true;
    } catch (error) {
        if (generation === playbackGeneration) {
            hideLoading();
            setPlayerStatus("Error", error?.message ?? String(error));
        }
        throw error;
    }
}

export function setSubtitle(subtitleWebVtt) {
    subtitleRevision++;
    setSubtitleInternal(subtitleWebVtt);
}

export function setSubtitleStyle(fontSizePercent, backgroundOpacity) {
    const size = Math.max(50, Math.min(200, fontSizePercent));
    const opacity = Math.max(0, Math.min(1, backgroundOpacity));
    document.documentElement.style.setProperty("--subtitle-font-size", `${size}%`);
    document.documentElement.style.setProperty(
        "--subtitle-background",
        `rgba(0, 0, 0, ${opacity})`);
}

export function preparePlayback(fileName) {
    beginPlaybackTransition(fileName, "Loading media…");
}

export function pickSubtitle() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".vtt,.srt,.ass,.ssa,.sub,text/vtt,application/x-subrip";
        input.onchange = async () => {
            const file = input.files?.[0];
            resolve(file ? JSON.stringify({ Name: file.name, Content: await file.text() }) : null);
        };
        input.click();
    });
}

export async function acquireToken(tenantId, clientId, scopes) {
    const verifierBytes = crypto.getRandomValues(new Uint8Array(64));
    const verifier = base64Url(verifierBytes);
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const redirectUri = `${location.origin}${location.pathname}`;
    const state = crypto.randomUUID();
    const authorize = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`);
    authorize.search = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: scopes,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account"
    });

    const popup = window.open(authorize, "medius-auth", "popup,width=520,height=720");
    if (!popup) {
        throw new Error("The sign-in popup was blocked.");
    }

    const code = await waitForAuthorizationCode(popup, redirectUri, state);
    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
            scope: scopes
        })
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(result.error_description ?? "Microsoft sign-in failed.");
    }

    return result.access_token;
}

// Whole-file conversion is used for remuxing and MediaSource fallback paths.
async function convertForBrowser(uri, fileName, mode, maxWidth, generation) {
    let downloadedBytes = 0;
    let totalBytes = 0;
    let currentChunkBytes = 0;
    const download = downloadSource(uri, (downloaded, total, currentChunk) => {
        downloadedBytes = downloaded;
        totalBytes = total;
        currentChunkBytes = currentChunk;
        if (generation !== playbackGeneration) return;
        const detail = describeDownload(fileName, downloaded, total, currentChunk);
        setPlayerStatus("Downloading", detail);
        showLoading(detail);
    });
    const [, blob] = await Promise.all([ensureFfmpegLoaded(), download]);
    if (generation !== playbackGeneration) {
        throw new Error("Playback was replaced.");
    }

    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".bin";
    const inputName = `input${extension}`;
    const outputName = "output.mp4";
    ffmpegLog.length = 0;
    await cleanupFfmpegFiles(inputName, outputName);
    await ffmpeg.writeFile(inputName, new Uint8Array(await blob.arrayBuffer()));

    const extractedSubtitle = await extractEmbeddedSubtitle(inputName);
    const progressState = {
        generation,
        fileName,
        downloadedBytes,
        totalBytes,
        currentChunkBytes
    };
    wholeFileProgress = progressState;
    setPlayerStatus(
        "Converting",
        `${fileName} — downloaded ${formatBytes(downloadedBytes)}${formatTotalBytes(totalBytes)} · converted 0%`);
    showLoading(`Converting full file… ${fileName}`);
    let exitCode = -1;
    try {
        if (conversionStrategy(mode) === "remux") {
            exitCode = await ffmpeg.exec([
                "-y", "-i", inputName,
                "-map", "0:v:0", "-map", "0:a:0?",
                "-c", "copy", "-movflags", "+faststart",
                outputName
            ], 180000);
        }
        if (exitCode !== 0) {
            const args = [
                "-y", "-i", inputName,
                "-map", "0:v:0", "-map", "0:a:0?",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "30",
                "-pix_fmt", "yuv420p"
            ];
            if (maxWidth > 0) {
                args.push("-vf", `scale=w='trunc(min(${maxWidth},iw)/2)*2':h=-2`);
            } else {
                args.push("-vf", "scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'");
            }
            args.push("-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outputName);
            exitCode = await ffmpeg.exec(args, 600000);
        }
    } finally {
        if (wholeFileProgress === progressState) wholeFileProgress = undefined;
    }
    if (exitCode !== 0) throw conversionError();

    const data = await ffmpeg.readFile(outputName);
    mediaObjectUrl = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
    await cleanupFfmpegFiles(inputName, outputName);
    return {
        source: mediaObjectUrl,
        extractedSubtitle,
        conversionSummary: {
            convertedBytes: data.byteLength,
            downloadedBytes,
            totalBytes
        }
    };
}

async function ensureFfmpegLoaded() {
    ffmpeg ??= new FFmpeg();
    const instance = ffmpeg;
    if (instance.loaded) {
        return;
    }

    instance.on("log", ({ message }) => {
        if (handleRemoteProgressLog(message)) return;
        ffmpegLog.push(message);
        if (ffmpegLog.length > 40) ffmpegLog.shift();
        ffmpegLogSink?.push(message);
    });
    instance.on("progress", ({ progress }) => {
        if (wholeFileProgress
            && wholeFileProgress.generation === playbackGeneration
            && Number.isFinite(progress)) {
            const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
            setPlayerStatus(
                "Converting",
                `${wholeFileProgress.fileName} — downloaded ${formatBytes(wholeFileProgress.downloadedBytes)}`
                + `${formatTotalBytes(wholeFileProgress.totalBytes)} · converted ${percent}%`);
        }
    });

    const assetUrl = path => {
        const url = new URL(path, import.meta.url);
        url.searchParams.set("v", ffmpegAssetVersion);
        return url.href;
    };

    let timeoutId;
    try {
        await Promise.race([
            instance.load({
                classWorkerURL: assetUrl("./ffmpeg/worker.js"),
                coreURL: assetUrl("./ffmpeg/ffmpeg-core.js"),
                wasmURL: assetUrl("./ffmpeg/ffmpeg-core.wasm")
            }),
            new Promise((_, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error("ffmpeg.wasm did not load within 30 seconds. Refresh the page to clear stale cached assets.")),
                    30000);
            })
        ]);
    } catch (error) {
        instance.terminate();
        if (ffmpeg === instance) ffmpeg = undefined;
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

// Converts the source piece by piece. Playback begins after the first piece and the
// remaining pieces are produced ahead of the playhead, including after a seek.
async function playTranscodedSegments(
    uri,
    fileName,
    subtitleWebVtt,
    embeddedSubtitleOffsetMilliseconds,
    generation,
    startSeconds,
    endSeconds,
    mediaKey,
    maxWidth,
    convertedCacheLimitBytes,
    sourceSizeBytes) {
    segmentedActive = true;

    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".bin";
    ffmpegLog.length = 0;
    status().textContent = "Checking converted cache…";
    try {
        await pruneConvertedCache(Math.max(0, convertedCacheLimitBytes));
    } catch (error) {
        console.warn("Could not enforce the converted-media cache limit; playback will continue.", error);
    }

    const session = {
        generation,
        isCurrent: () => generation === playbackGeneration,
        fileName,
        subtitleWebVtt,
        embeddedSubtitleOffsetMilliseconds,
        probe: { durationSeconds: Number.NaN, hasSubtitles: false },
        maxWidth: Math.max(0, maxWidth),
        mediaKey: mediaKey ?? `${fileName}|${uri}`,
        convertedCacheLimitBytes: Math.max(0, convertedCacheLimitBytes),
        sourceSizeBytes: Math.max(0, Number(sourceSizeBytes) || 0),
        needsInitSegment: true,
        seekTarget: null,
        mediaSource: null,
        sourceBuffer: null,
        player: null,
        startSeconds: startSeconds >= 0 ? startSeconds : 0,
        endSeconds: endSeconds > startSeconds ? endSeconds : null,
        uri,
        extension,
        downloadedBytes: 0,
        totalBytes: 0,
        currentDownloadChunkBytes: 0,
        input: null,
        backgroundCacheEnabled: true,
        backgroundCacheCompleted: false,
        backgroundJob: null
    };
    session.backgroundJob = await createPlaybackBackgroundJob(session);

    // Hand control back as soon as playback starts; conversion continues in the background.
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const loop = runSegmentLoop(session, signalStarted);
    activeSegmentLoop = loop;
    void loop.finally(() => {
        if (activeSegmentLoop === loop) activeSegmentLoop = undefined;
    }).catch(() => {});
    loop.catch(error => {
        if (session.isCurrent()) {
            status().textContent = error.message;
        }
    });

    await Promise.race([started, loop]);
}

async function createPlaybackBackgroundJob(session) {
    const existing = conversionQueue.find(job =>
        job.mediaKey === session.mediaKey
        && job.maxWidth === session.maxWidth
        && !["cancelled", "error"].includes(job.state));
    if (existing) {
        if (existing.state !== "completed"
            || await getFullyCachedDuration(session.mediaKey, session.maxWidth) !== null) {
            session.backgroundCacheEnabled = false;
            return null;
        }
        conversionQueue.splice(conversionQueue.indexOf(existing), 1);
        await releaseQueuedUriResolver(existing.resolverId);
    }
    for (let index = conversionQueue.length - 1; index >= 0; index--) {
        const stale = conversionQueue[index];
        if (stale.mediaKey === session.mediaKey && stale.maxWidth === session.maxWidth) {
            conversionQueue.splice(index, 1);
            await releaseQueuedUriResolver(stale.resolverId);
        }
    }

    const job = {
        id: `playback-${session.generation}`,
        kind: "playback",
        fileName: session.fileName,
        uri: session.uri,
        mediaKey: session.mediaKey,
        maxWidth: session.maxWidth,
        convertedCacheLimitBytes: session.convertedCacheLimitBytes,
        sourceSizeBytes: session.sourceSizeBytes,
        state: "downloading",
        downloadedBytes: 0,
        totalBytes: 0,
        currentChunkBytes: 0,
        convertedSeconds: session.startSeconds,
        durationSeconds: 0,
        currentSegmentBytes: 0,
        errorMessage: null,
        cancelled: false,
        abortController: null,
        session,
        manualRequested: false,
        resolverId: null
    };
    conversionQueue.unshift(job);
    return job;
}

function syncPlaybackBackgroundJob(session, state, convertedSeconds = null) {
    const job = session.backgroundJob;
    if (!job || job.state === "cancelled") {
        return;
    }

    if (state) {
        job.state = state;
    }
    job.downloadedBytes = session.downloadedBytes;
    job.totalBytes = session.totalBytes;
    job.currentChunkBytes = session.currentDownloadChunkBytes;
    job.currentSegmentBytes = session.lastSegmentBytes ?? 0;
    if (Number.isFinite(session.probe.durationSeconds)) {
        job.durationSeconds = session.probe.durationSeconds;
    }
    if (convertedSeconds !== null) {
        job.convertedSeconds = Number.isFinite(job.durationSeconds) && job.durationSeconds > 0
            ? Math.min(convertedSeconds, job.durationSeconds)
            : convertedSeconds;
    }
}

async function completePlaybackBackgroundJob(session, convertedSeconds) {
    const job = session.backgroundJob;
    if (!job || job.state === "cancelled") {
        return;
    }

    const fullyCached = await isManualJobFullyCached(session);
    syncPlaybackBackgroundJob(session, fullyCached ? "completed" : "error", convertedSeconds);
    if (!fullyCached) {
        job.errorMessage = "The converted cache limit is too small to retain the full file.";
    } else if (session.input) {
        const input = session.input;
        session.input = null;
        await releaseInput(input);
    }
    job.currentChunkBytes = 0;
    session.backgroundCacheCompleted = true;
    job.session = null;
    await releaseQueuedUriResolver(job.resolverId);
}

async function finalizePlaybackBackgroundJob(session, cachePosition) {
    const job = session.backgroundJob;
    if (!job || ["completed", "cancelled", "error"].includes(job.state)) {
        return;
    }

    if (session.backgroundCacheEnabled && isSourceFullyConverted(session, cachePosition)) {
        await completePlaybackBackgroundJob(session, cachePosition);
        return;
    }

    if (job.manualRequested && !job.cancelled) {
        job.kind = "manual";
        job.state = "queued";
        job.session = null;
        job.convertedSeconds = cachePosition;
        job.currentSegmentBytes = 0;
        void ensureBackgroundQueueRunner();
        return;
    }

    job.state = "cancelled";
    job.session = null;
    await releaseQueuedUriResolver(job.resolverId);
}

async function runManualConversionJob(job) {
    const extension = job.fileName.includes(".") ? job.fileName.slice(job.fileName.lastIndexOf(".")) : ".bin";
    const session = {
        fileName: job.fileName,
        uri: job.uri,
        extension,
        maxWidth: job.maxWidth,
        mediaKey: job.mediaKey,
        convertedCacheLimitBytes: job.convertedCacheLimitBytes,
        sourceSizeBytes: job.sourceSizeBytes,
        probe: { durationSeconds: Number.NaN, hasSubtitles: false },
        downloadedBytes: 0,
        totalBytes: 0,
        currentDownloadChunkBytes: 0,
        input: null
    };

    job.errorMessage = null;
    job.currentSegmentBytes = 0;
    job.currentChunkBytes = 0;
    job.abortController = new AbortController();

    try {
        job.state = "downloading";
        job.uri = await refreshQueuedConversionUri(job.resolverId, job.uri);
        if (job.cancelled) throw new DOMException("Cancelled", "AbortError");
        const updateProgress = (progress, totalArg = 0, currentChunkArg = 0) => {
            const downloaded = typeof progress === "number"
                ? progress
                : progress.downloadedBytes ?? progress.downloaded ?? 0;
            const total = typeof progress === "number"
                ? totalArg
                : progress.totalBytes ?? progress.total ?? 0;
            const currentChunk = typeof progress === "number"
                ? currentChunkArg
                : progress.currentChunkBytes ?? progress.currentChunk ?? 0;
            if (job.state === "queued") job.state = "downloading";
            job.downloadedBytes = downloaded;
            job.totalBytes = total;
            job.currentChunkBytes = currentChunk;
            session.downloadedBytes = downloaded;
            session.totalBytes = total;
            session.currentDownloadChunkBytes = currentChunk;
        };
        const [instance, remote] = await Promise.all([
            ensureBackgroundFfmpegLoaded(),
            probeRangeSource(job.uri, job.abortController, job.sourceSizeBytes)
        ]);
        if (job.cancelled) throw new DOMException("Cancelled", "AbortError");
        if (remote) {
            updateProgress({
                downloadedBytes: remote.initialBytes,
                totalBytes: remote.totalBytes,
                currentChunkBytes: remote.initialBytes
            });
            session.input = await mountRemoteInput(
                job.uri,
                extension,
                `bg-${job.id}`,
                instance,
                remote.totalBytes,
                updateProgress);
        } else {
            const blob = await downloadSource(job.uri, updateProgress, { controller: job.abortController });
            if (job.cancelled) throw new DOMException("Cancelled", "AbortError");
            session.downloadedBytes = blob.size;
            session.totalBytes ||= blob.size;
            job.downloadedBytes = blob.size;
            job.totalBytes ||= blob.size;
            job.currentChunkBytes = 0;
            session.input = await mountInput(blob, extension, `bg-${job.id}`, instance);
        }
        if (job.cancelled) {
            throw new DOMException("Cancelled", "AbortError");
        }

        job.state = "converting";
        await probeBackgroundSessionInput(session);
        if (Number.isFinite(session.probe.durationSeconds)) {
            job.durationSeconds = session.probe.durationSeconds;
        }
        if (await isManualJobFullyCached(session)) {
            job.convertedSeconds = job.durationSeconds;
            job.state = "completed";
            return;
        }

        let position = 0;
        let duration = FIRST_SEGMENT_SECONDS;
        while (!isFullyConverted(session, position)) {
            if (job.cancelled) {
                throw new DOMException("Cancelled", "AbortError");
            }

            const segment = await convertBackgroundSegment(session, position, duration, job);
            if (job.cancelled) {
                throw new DOMException("Cancelled", "AbortError");
            }
            if (!segment) {
                if (position === 0) {
                    throw conversionError(bgFfmpegLog);
                }
                session.probe.durationSeconds = Math.min(
                    Number.isFinite(session.probe.durationSeconds) ? session.probe.durationSeconds : Infinity,
                    position);
                job.durationSeconds = Number.isFinite(session.probe.durationSeconds) ? session.probe.durationSeconds : job.durationSeconds;
                break;
            }

            position += duration;
            duration = SEGMENT_SECONDS;
            job.convertedSeconds = Number.isFinite(session.probe.durationSeconds)
                ? Math.min(position, session.probe.durationSeconds)
                : position;
        }

        job.currentChunkBytes = 0;
        if (!await isManualJobFullyCached(session)) {
            throw new Error("The converted cache limit is too small to retain the full file.");
        }
        job.state = "completed";
    } catch (error) {
        if (job.cancelled || error?.name === "AbortError") {
            job.state = "cancelled";
        } else {
            job.state = "error";
            job.errorMessage = error?.message ?? String(error);
        }
    } finally {
        job.abortController = null;
        await releaseQueuedUriResolver(job.resolverId);
        await Promise.allSettled([
            releaseInput(session.input),
            cleanupBackgroundFfmpegFiles("segment.mp4")
        ]);
    }
}

async function getBackgroundConversionExports() {
    if (browserAssemblyExports) return browserAssemblyExports;
    const module = await import(new URL("./_framework/dotnet.js", document.baseURI).href);
    const runtime = module.dotnet.instance;
    const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
    browserAssemblyExports = exports.Medius.Browser.BrowserBackgroundConversionHost;
    return browserAssemblyExports;
}

async function refreshQueuedConversionUri(resolverId, fallbackUri) {
    if (!resolverId) return fallbackUri;
    let exports;
    try {
        exports = await getBackgroundConversionExports();
    } catch (error) {
        console.warn("Could not refresh the queued media URL; using the original URL.", error);
        return fallbackUri;
    }
    return await exports.RefreshConversionUri(resolverId, fallbackUri);
}

async function releaseQueuedUriResolver(resolverId) {
    if (!resolverId) return;
    try {
        const exports = await getBackgroundConversionExports();
        exports.ReleaseConversionUri(resolverId);
    } catch {
        // The direct player harness has no .NET host or resolver to release.
    }
}

async function isManualJobFullyCached(session) {
    if (!Number.isFinite(session.probe.durationSeconds)) {
        return false;
    }

    const cache = await caches.open(convertedCacheName);
    let position = 0;
    let duration = FIRST_SEGMENT_SECONDS;
    while (position < session.probe.durationSeconds - 0.2) {
        const key = getConvertedSegmentKey(session, position, duration);
        if (!await cache.match(convertedSegmentRequest(key))) {
            return false;
        }
        position += duration;
        duration = SEGMENT_SECONDS;
    }

    return true;
}

async function runSegmentLoop(session, onStarted) {
    let appendPosition = session.startSeconds;
    let cachePosition = 0;
    let cacheDuration = FIRST_SEGMENT_SECONDS;
    let playing = false;
    let playbackStreamFinished = false;
    // A short piece is converted first, and again after each seek, so playback resumes quickly.
    let useShortSegment = true;

    try {
        while (session.isCurrent()) {
            if (session.seekTarget !== null) {
                // Convert from the exact seek point so playback can resume immediately.
                appendPosition = Math.max(0, session.seekTarget);
                session.seekTarget = null;
                session.needsInitSegment = true;
                useShortSegment = true;
                playbackStreamFinished = false;
            }

            // Never reconvert media that is already in the buffer.
            const bufferedEnd = bufferedEndCovering(session.sourceBuffer, appendPosition);
            if (bufferedEnd !== null) {
                appendPosition = bufferedEnd;
            }
            if (!session.backgroundCacheCompleted && isSourceFullyConverted(session, cachePosition)) {
                await completePlaybackBackgroundJob(session, cachePosition);
            }

            if (isFullyConverted(session, appendPosition)) {
                if (!playbackStreamFinished) {
                    await finishStream(session);
                    playbackStreamFinished = true;
                }
                setPlayerStatus("Buffered", `${session.fileName} — playback range buffered`);
                reportStatus(session, appendPosition, playing);
                if (!session.backgroundCacheEnabled || session.backgroundCacheCompleted) {
                    if (!await waitForSeek(session)) return;
                    continue;
                }
            }

            const playbackNeedsMore = !playbackStreamFinished && (!playing
                || !session.player
                || appendPosition - session.player.currentTime <= MAX_BUFFER_AHEAD_SECONDS);
            if (playbackNeedsMore) {
                const duration = useShortSegment ? FIRST_SEGMENT_SECONDS : SEGMENT_SECONDS;
                const segmentStart = appendPosition;
                const segment = await convertSegment(session, appendPosition, duration);
                if (!session.isCurrent()) return;

                if (!segment) {
                    if (!playing) throw conversionError();
                    // Nothing decodable here, so treat this point as the end of the media.
                    session.probe.durationSeconds = Math.min(
                        Number.isFinite(session.probe.durationSeconds) ? session.probe.durationSeconds : Infinity,
                        appendPosition);
                    continue;
                }

                await appendSegment(session, segment, appendPosition);
                appendPosition += duration;
                if (Math.abs(segmentStart - cachePosition) < 0.001 && duration === cacheDuration) {
                    cachePosition += cacheDuration;
                    cacheDuration = SEGMENT_SECONDS;
                }
                useShortSegment = false;
                syncPlaybackBackgroundJob(session, "converting", cachePosition);

                if (!playing) {
                    playing = true;
                    await beginPlayback(session);
                    onStarted();
                }

                reportStatus(session, appendPosition, playing);
                if (playing
                    && !session.subtitleWebVtt
                    && session.probe.hasSubtitles
                    && !session.embeddedSubtitleStarted
                    && appendPosition >= FIRST_SEGMENT_SECONDS + (SEGMENT_SECONDS * 2)) {
                    session.embeddedSubtitleStarted = true;
                    const revision = subtitleRevision;
                    await ensureSessionInput(session);
                    const embedded = await extractEmbeddedSubtitle(session.input.path);
                    if (session.isCurrent() && revision === subtitleRevision && embedded) {
                        setSubtitleInternal(
                            shiftWebVtt(embedded, session.embeddedSubtitleOffsetMilliseconds));
                    }
                }
                continue;
            }

            if (session.backgroundCacheEnabled && !session.backgroundCacheCompleted) {
                if (!isSourceFullyConverted(session, cachePosition)) {
                    const segment = await convertSegment(session, cachePosition, cacheDuration);
                    if (!session.isCurrent()) return;

                    if (!segment) {
                        session.probe.durationSeconds = Math.min(
                            Number.isFinite(session.probe.durationSeconds) ? session.probe.durationSeconds : Infinity,
                            cachePosition);
                        await completePlaybackBackgroundJob(session, cachePosition);
                        continue;
                    }

                    cachePosition += cacheDuration;
                    cacheDuration = SEGMENT_SECONDS;
                    syncPlaybackBackgroundJob(session, "converting", cachePosition);
                    if (isSourceFullyConverted(session, cachePosition)) {
                        await completePlaybackBackgroundJob(session, cachePosition);
                    }
                } else {
                    await completePlaybackBackgroundJob(session, cachePosition);
                    await delay(250);
                }
                continue;
            }

            if (playing && !await waitForBufferRoom(session, appendPosition)) return;
            if (session.seekTarget !== null) continue;
        }
    } finally {
        if (session.isCurrent()) {
            segmentedActive = false;
        }
        await finalizePlaybackBackgroundJob(session, cachePosition);
        detachSeekListener(session);
        await releaseInput(session.input);
    }
}

async function convertSegment(session, start, duration) {
    const cacheKey = getConvertedSegmentKey(session, start, duration);
    let cached;
    try {
        cached = await readConvertedSegment(cacheKey);
    } catch (error) {
        console.warn("Could not read a converted-media cache entry; reconverting it.", error);
    }
    if (cached) {
        if (Number.isNaN(session.probe.durationSeconds) && cached.probe) {
            session.probe = cached.probe;
        }
        session.lastSegmentBytes = cached.data.byteLength;
        session.lastSegmentDuration = duration;
        session.lastSegmentSource = "cached";
        setPlayerStatus(
            "Buffering",
            `${session.fileName} — loading cached ${duration}s segment (${formatBytes(cached.data.byteLength)})`);
        return cached.data;
    }

    await ensureSessionInput(session);
    if (!session.isCurrent()) return null;
    if (Number.isNaN(session.probe.durationSeconds)) {
        await probeSessionInput(session);
        if (!session.isCurrent()) return null;
    }

    const outputName = "segment.mp4";
    await Promise.allSettled([ffmpeg.deleteFile(outputName)]);

    // The first conversion doubles as the probe: its log describes the source streams.
    const capture = Number.isNaN(session.probe.durationSeconds);
    const lines = [];
    ffmpegLogSink = capture ? lines : undefined;
    session.currentConversionLabel = `converting ${duration}s segment at ${formatClock(start)}`;
    const previousSegment = session.lastSegmentBytes
        ? ` · previous ${session.lastSegmentDuration}s segment ${formatBytes(session.lastSegmentBytes)}`
        : "";
    setPlayerStatus(
        "Converting",
        `${session.fileName} — converting ${duration}s segment at ${formatClock(start)}`
        + ` · ${describeSourceRead(
            session.downloadedBytes,
            session.totalBytes,
            session.currentDownloadChunkBytes)}`
        + previousSegment);
    let exitCode;
    try {
        exitCode = await ffmpeg.exec(buildSegmentArgs(session, outputName, start, duration), 180000);
    } finally {
        ffmpegLogSink = undefined;
        session.currentConversionLabel = null;
    }
    if (!session.isCurrent() || exitCode !== 0) return null;

    if (capture) {
        session.probe = parseProbe(lines.join("\n"));
    }

    const data = await ffmpeg.readFile(outputName);
    session.lastSegmentBytes = data.byteLength;
    session.lastSegmentDuration = duration;
    session.lastSegmentSource = "converted";
    await Promise.allSettled([ffmpeg.deleteFile(outputName)]);
    if (findMediaFragmentOffset(data) < 0) return null;

    try {
        await writeConvertedSegment(
            cacheKey,
            data,
            session.probe,
            session.convertedCacheLimitBytes);
    } catch (error) {
        console.warn("Could not cache the converted media segment; playback will continue.", error);
    }
    return data;
}

async function probeSessionInput(session) {
    const lines = [];
    ffmpegLogSink = lines;
    session.currentConversionLabel = "analyzing streams";
    try {
        await ffmpeg.exec([
            "-hide_banner",
            "-i", session.input.path,
            "-map", "0:v:0",
            "-frames:v", "0",
            "-f", "null",
            "-"
        ], 30000);
    } finally {
        ffmpegLogSink = undefined;
        session.currentConversionLabel = null;
    }
    session.probe = parseProbe(lines.join("\n"));
}

function getConvertedSegmentKey(session, start, duration) {
    return [
        "v2",
        session.mediaKey,
        start.toFixed(3),
        duration.toFixed(3),
        session.maxWidth
    ].join("|");
}

async function readConvertedSegment(key) {
    const cache = await caches.open(convertedCacheName);
    const response = await cache.match(convertedSegmentRequest(key));
    if (!response) return null;

    await withConvertedCacheLock(() => {
        touchConvertedCacheEntry(key, Number(response.headers.get("X-Medius-Size") ?? 0));
    });
    const probeHeader = response.headers.get("X-Medius-Probe");
    return {
        data: new Uint8Array(await response.arrayBuffer()),
        probe: probeHeader
            ? JSON.parse(new TextDecoder().decode(base64ToBytes(probeHeader)))
            : null
    };
}

async function writeConvertedSegment(key, data, probe, limitBytes) {
    if (limitBytes <= 0) return;
    await withConvertedCacheLock(async () => {
        const cache = await caches.open(convertedCacheName);
        const probeHeader = bytesToBase64(new TextEncoder().encode(JSON.stringify(probe)));
        await cache.put(
            convertedSegmentRequest(key),
            new Response(data, {
                headers: {
                    "Content-Type": "video/mp4",
                    "X-Medius-Size": String(data.byteLength),
                    "X-Medius-Probe": probeHeader
                }
            }));
        touchConvertedCacheEntry(key, data.byteLength);
        await pruneConvertedCacheCore(limitBytes, cache);
    });
}

function convertedSegmentRequest(key) {
    return new Request(
        new URL(`./__medius_converted/${encodeURIComponent(key)}`, location.href),
        { method: "GET" });
}

function readConvertedCacheIndex() {
    try {
        return JSON.parse(localStorage.getItem(convertedCacheIndexKey) ?? "[]");
    } catch {
        return [];
    }
}

function touchConvertedCacheEntry(key, size) {
    const entries = readConvertedCacheIndex().filter(item => item.key !== key);
    entries.push({ key, size, lastAccess: Date.now() });
    localStorage.setItem(convertedCacheIndexKey, JSON.stringify(entries));
}

async function pruneConvertedCache(limitBytes) {
    await withConvertedCacheLock(async () => {
        const cache = await caches.open(convertedCacheName);
        await pruneConvertedCacheCore(limitBytes, cache);
    });
}

async function pruneConvertedCacheCore(limitBytes, cache) {
    const entries = readConvertedCacheIndex().sort((a, b) => a.lastAccess - b.lastAccess);
    let total = entries.reduce((sum, item) => sum + item.size, 0);
    while (total > limitBytes && entries.length > 0) {
        const removed = entries.shift();
        total -= removed.size;
        await cache.delete(convertedSegmentRequest(removed.key));
    }
    localStorage.setItem(convertedCacheIndexKey, JSON.stringify(entries));
}

function withConvertedCacheLock(action) {
    const result = convertedCacheMutation.then(action, action);
    convertedCacheMutation = result.catch(() => {});
    return result;
}

async function appendSegment(session, data, start) {
    if (!session.sourceBuffer) {
        await attachMediaSource(session, data);
    }
    await reopenEndedMediaSource(session);

    const payload = session.needsInitSegment ? data : data.slice(findMediaFragmentOffset(data));
    session.needsInitSegment = false;
    // Each piece is produced with timestamps from zero, so this places it on the real timeline.
    session.sourceBuffer.timestampOffset = start;

    try {
        await appendBuffer(session.sourceBuffer, payload);
    } catch (error) {
        if (error?.name !== "QuotaExceededError") throw error;
        evictPlayedMedia(session, true);
        await waitForIdleBuffer(session.sourceBuffer);
        session.sourceBuffer.timestampOffset = start;
        await appendBuffer(session.sourceBuffer, payload);
    }

    async function reopenEndedMediaSource(session) {
        if (session.mediaSource?.readyState !== "ended") return;
        try {
            // appendBuffer's first step reopens an ended MediaSource. An empty append lets
            // us set timestampOffset safely before appending the real sought segment.
            await appendBuffer(session.sourceBuffer, new Uint8Array());
        } catch (error) {
            throw new Error(`The browser could not reopen the media stream after seeking: ${error?.message ?? error}`);
        }
    }
}

async function attachMediaSource(session, firstSegment) {
    session.mediaSource = new MediaSource();
    mediaObjectUrl = URL.createObjectURL(session.mediaSource);
    session.player = video();
    session.player.pause();
    session.player.replaceChildren();
    session.player.src = mediaObjectUrl;
    if (session.subtitleWebVtt) {
        addSubtitleTrack(session.player, session.subtitleWebVtt);
    }

    await once(session.mediaSource, "sourceopen");

    // The MIME type is read from the produced bytes so it always matches what is appended.
    const mimeType = describeSegment(firstSegment);
    if (!MediaSource.isTypeSupported(mimeType)) {
        throw new Error(`This browser cannot play ${mimeType}.`);
    }

    session.sourceBuffer = session.mediaSource.addSourceBuffer(mimeType);
    session.sourceBuffer.mode = "segments";
    if (Number.isFinite(session.probe.durationSeconds)) {
        try {
            session.mediaSource.duration = session.probe.durationSeconds;
        } catch {
            // A browser may refuse an explicit duration; the scrubber then grows as pieces append.
        }
    }

    attachSeekListener(session);
    configurePlaybackRange(session.player, session.startSeconds, session.endSeconds);
}

async function beginPlayback(session) {
    try {
        await session.player.play();
    } catch (error) {
        if (error?.name !== "NotAllowedError") throw error;
    }
    hideLoading();
    setPlayerStatus("Playing", `${session.fileName} — playback started`);
}

function attachSeekListener(session) {
    session.onSeeking = () => {
        const target = session.player.currentTime;
        if (!isBuffered(session.sourceBuffer, target)) {
            session.seekTarget = target;
        }
    };

    session.player.addEventListener("seeking", session.onSeeking);
}

function detachSeekListener(session) {
    if (session.player && session.onSeeking) {
        session.player.removeEventListener("seeking", session.onSeeking);
        session.onSeeking = undefined;
    }
}

function isFullyConverted(session, position) {
    const end = session.endSeconds
        ?? (Number.isFinite(session.probe.durationSeconds) ? session.probe.durationSeconds : null);
    return end !== null && position >= end - 0.2;
}

function isSourceFullyConverted(session, position) {
    return Number.isFinite(session.probe.durationSeconds)
        && position >= session.probe.durationSeconds - 0.2;
}

function configurePlaybackRange(player, startSeconds, endSeconds) {
    player.onloadedmetadata = null;
    player.ontimeupdate = null;
    if (startSeconds >= 0) {
        const seek = () => {
            if (Math.abs(player.currentTime - startSeconds) > 0.25) {
                player.currentTime = startSeconds;
            }
        };
        if (player.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
        else player.onloadedmetadata = seek;
    }

    if (endSeconds > startSeconds) {
        const stopAtEnd = () => {
            if (player.currentTime >= endSeconds) {
                player.pause();
                player.currentTime = endSeconds;
            }
        };
        player.ontimeupdate = stopAtEnd;
    }
}

async function waitForSeek(session) {
    while (session.isCurrent()) {
        if (session.seekTarget !== null) return true;
        await delay(200);
    }

    return false;
}

async function waitForBufferRoom(session, position) {
    while (session.isCurrent()) {
        if (session.seekTarget !== null) return true;
        if (position - session.player.currentTime <= MAX_BUFFER_AHEAD_SECONDS) {
            evictPlayedMedia(session, false);
            return true;
        }

        const bufferedAhead = Math.max(0, position - session.player.currentTime);
        setPlayerStatus(
            "Buffered",
            `${session.fileName} — ${bufferedAhead.toFixed(0)}s ready ahead`
            + ` · ${describeSourceRead(
                session.downloadedBytes,
                session.totalBytes,
                session.currentDownloadChunkBytes)}`);
        reportStatus(session, position, true);
        await delay(250);
    }

    return false;
}

// Releases media the viewer has already watched so long files stay within the buffer quota.
function evictPlayedMedia(session, aggressive) {
    const buffer = session.sourceBuffer;
    if (!buffer || buffer.updating || buffer.buffered.length === 0) return;

    const keepBehind = aggressive ? 5 : KEEP_BEHIND_SECONDS;
    const cutoff = session.player.currentTime - keepBehind;
    const start = buffer.buffered.start(0);
    if (cutoff > start + 1) {
        try {
            buffer.remove(start, cutoff);
        } catch {
            // The buffer may be busy; the next pass will retry.
        }
    }
}

function reportStatus(session, convertedSeconds, playing) {
    if (!playing) {
        setPlayerStatus(
            "Converting",
            `${session.fileName} — converting first ${session.lastSegmentDuration ?? FIRST_SEGMENT_SECONDS}s segment`
            + ` · ${describeSourceRead(
                session.downloadedBytes,
                session.totalBytes,
                session.currentDownloadChunkBytes)}`);
        return;
    }

    const ahead = Math.max(0, convertedSeconds - session.player.currentTime);
    const total = Number.isFinite(session.probe.durationSeconds)
        ? ` of ${formatClock(session.probe.durationSeconds)}`
        : "";
    const segment = session.lastSegmentBytes
        ? ` · ${session.lastSegmentSource} ${session.lastSegmentDuration}s segment ${formatBytes(session.lastSegmentBytes)}`
        : "";
    status().textContent =
        `${session.fileName} — converted ${formatClock(convertedSeconds)}${total} (${ahead.toFixed(0)}s ahead)`
        + ` · ${describeSourceRead(
            session.downloadedBytes,
            session.totalBytes,
            session.currentDownloadChunkBytes)}`
        + segment;
}

function formatClock(seconds) {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatTotalBytes(totalBytes) {
    return totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : "";
}

function describeDownload(fileName, downloadedBytes, totalBytes, currentChunkBytes) {
    const currentChunk = currentChunkBytes > 0
        ? ` · current network chunk ${formatBytes(currentChunkBytes)}`
        : "";
    return `${fileName} — downloaded ${formatBytes(downloadedBytes)}`
        + `${formatTotalBytes(totalBytes)}${currentChunk}`;
}

function parseProbe(text) {
    const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
    const size = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(text);
    return {
        durationSeconds: duration
            ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
            : Number.NaN,
        videoCodec: /Stream #\d+:\d+[^\n]*:\s*Video:\s*(\w+)/.exec(text)?.[1],
        audioCodec: /Stream #\d+:\d+[^\n]*:\s*Audio:\s*(\w+)/.exec(text)?.[1],
        width: size ? Number(size[1]) : 0,
        hasSubtitles: /:\s*Subtitle:\s*/.test(text)
    };
}

function buildSegmentArgs(session, outputName, start, duration) {
    const args = ["-y"];
    const preciseSeekSeconds = Math.min(start, 5);
    const coarseSeekSeconds = Math.max(0, start - preciseSeekSeconds);
    if (coarseSeekSeconds > 0) args.push("-ss", String(coarseSeekSeconds));
    args.push("-i", session.input.path);
    if (preciseSeekSeconds > 0) args.push("-ss", String(preciseSeekSeconds));
    args.push("-t", String(duration), "-map", "0:v:0", "-map", "0:a:0?");

    if (session.probe.videoCodec === "h264" && session.maxWidth === 0) {
        args.push("-c:v", "copy");
    } else {
        args.push(
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-crf", "30",
            "-profile:v", "baseline",
            "-level:v", "3.1",
            "-pix_fmt", "yuv420p");
        if (session.maxWidth) {
            // min() keeps smaller sources at their native size instead of upscaling them.
            args.push("-vf", `scale=w='trunc(min(${session.maxWidth},iw)/2)*2':h=-2`);
        } else {
            args.push("-vf", "scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'");
        }
    }

    if (session.probe.audioCodec === "aac") {
        args.push("-c:a", "copy");
    } else {
        args.push("-c:a", "aac", "-b:a", "128k");
    }

    args.push(
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        outputName);
    return args;
}

async function ensureBackgroundFfmpegLoaded() {
    bgFfmpeg ??= new FFmpeg();
    const instance = bgFfmpeg;
    if (instance.loaded) {
        return instance;
    }

    instance.on("log", ({ message }) => {
        if (handleRemoteProgressLog(message)) return;
        bgFfmpegLog.push(message);
        if (bgFfmpegLog.length > 40) bgFfmpegLog.shift();
        bgFfmpegLogSink?.push(message);
    });

    const assetUrl = path => {
        const url = new URL(path, import.meta.url);
        url.searchParams.set("v", ffmpegAssetVersion);
        return url.href;
    };

    let timeoutId;
    try {
        await Promise.race([
            instance.load({
                classWorkerURL: assetUrl("./ffmpeg/worker.js"),
                coreURL: assetUrl("./ffmpeg/ffmpeg-core.js"),
                wasmURL: assetUrl("./ffmpeg/ffmpeg-core.wasm")
            }),
            new Promise((_, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error("Background ffmpeg.wasm did not load within 30 seconds. Refresh the page to clear stale cached assets.")),
                    30000);
            })
        ]);
    } catch (error) {
        instance.terminate();
        if (bgFfmpeg === instance) bgFfmpeg = undefined;
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    return instance;
}

function handleRemoteProgressLog(message) {
    if (!message?.startsWith(RANGE_LOG_PREFIX)) return false;
    try {
        const progress = JSON.parse(message.slice(RANGE_LOG_PREFIX.length));
        for (const sink of remoteProgressSinks.get(progress.url) ?? []) sink(progress);
    } catch (error) {
        console.warn("Could not parse ffmpeg range progress.", error);
    }
    return true;
}

function registerRemoteProgress(url, sink) {
    const sinks = remoteProgressSinks.get(url) ?? new Set();
    sinks.add(sink);
    remoteProgressSinks.set(url, sinks);
}

function unregisterRemoteProgress(url, sink) {
    const sinks = remoteProgressSinks.get(url);
    if (!sinks) return;
    sinks.delete(sink);
    if (sinks.size === 0) remoteProgressSinks.delete(url);
}

async function probeBackgroundSessionInput(session) {
    const lines = [];
    bgFfmpegLogSink = lines;
    try {
        await bgFfmpeg.exec([
            "-hide_banner",
            "-i", session.input.path,
            "-map", "0:v:0",
            "-frames:v", "0",
            "-f", "null",
            "-"
        ], 30000);
    } finally {
        bgFfmpegLogSink = undefined;
    }
    session.probe = parseProbe(lines.join("\n"));
}

async function convertBackgroundSegment(session, start, duration, job) {
    const cacheKey = getConvertedSegmentKey(session, start, duration);
    let cached;
    try {
        cached = await readConvertedSegment(cacheKey);
    } catch (error) {
        console.warn("Could not read a converted-media cache entry; reconverting it.", error);
    }
    if (cached) {
        if (Number.isNaN(session.probe.durationSeconds) && cached.probe) {
            session.probe = cached.probe;
        }
        job.currentSegmentBytes = cached.data.byteLength;
        return cached.data;
    }

    const outputName = "segment.mp4";
    await Promise.allSettled([bgFfmpeg.deleteFile(outputName)]);
    const capture = Number.isNaN(session.probe.durationSeconds);
    const lines = [];
    bgFfmpegLogSink = capture ? lines : undefined;
    let exitCode;
    try {
        exitCode = await bgFfmpeg.exec(buildSegmentArgs(session, outputName, start, duration), 180000);
    } finally {
        bgFfmpegLogSink = undefined;
    }
    if (job.cancelled || exitCode !== 0) return null;

    if (capture) {
        session.probe = parseProbe(lines.join("\n"));
    }

    const data = await bgFfmpeg.readFile(outputName);
    job.currentSegmentBytes = data.byteLength;
    await Promise.allSettled([bgFfmpeg.deleteFile(outputName)]);
    if (findMediaFragmentOffset(data) < 0) return null;

    try {
        await writeConvertedSegment(
            cacheKey,
            data,
            session.probe,
            session.convertedCacheLimitBytes);
    } catch (error) {
        console.warn("Could not cache the converted media segment; conversion will continue.", error);
    }
    return data;
}

async function cleanupBackgroundFfmpegFiles(...names) {
    if (!bgFfmpeg) return;
    await Promise.allSettled([
        ...names.map(name => bgFfmpeg.deleteFile(name)),
        bgFfmpeg.deleteFile("embedded.vtt")
    ]);
}

// WORKERFS exposes the source as a virtual file so ffmpeg reads the parts it needs
// instead of copying the whole download into the wasm heap.
async function ensureSessionInput(session) {
    if (session.input) return;
    const updateProgress = (progress, totalArg = 0, currentChunkArg = 0) => {
        const downloaded = typeof progress === "number"
            ? progress
            : progress.downloadedBytes ?? progress.downloaded ?? 0;
        const total = typeof progress === "number"
            ? totalArg
            : progress.totalBytes ?? progress.total ?? 0;
        const currentChunk = typeof progress === "number"
            ? currentChunkArg
            : progress.currentChunkBytes ?? progress.currentChunk ?? 0;
        session.downloadedBytes = downloaded;
        session.totalBytes = total;
        session.currentDownloadChunkBytes = currentChunk;
        if (!session.isCurrent()) return;
        if (session.input) {
            syncPlaybackBackgroundJob(session, "converting");
            setPlayerStatus(
                "Converting",
                `${session.fileName} — ${session.currentConversionLabel ?? "converting"}`
                + ` · ${describeSourceRead(downloaded, total, currentChunk)}`);
        } else {
            syncPlaybackBackgroundJob(session, "downloading");
            const detail = describeDownload(session.fileName, downloaded, total, currentChunk);
            setPlayerStatus("Downloading", detail);
            if (!session.player) showLoading(detail);
        }
    };
    const controller = new AbortController();
    activeDownloadController = controller;
    const [, remote] = await Promise.all([
        ensureFfmpegLoaded(),
        probeRangeSource(session.uri, controller, session.sourceSizeBytes)
    ]);
    if (!session.isCurrent()) return;
    const instance = ffmpeg;
    if (remote) {
        updateProgress({
            downloadedBytes: remote.initialBytes,
            totalBytes: remote.totalBytes,
            currentChunkBytes: remote.initialBytes
        });
        session.input = await mountRemoteInput(
            session.uri,
            session.extension,
            session.generation,
            instance,
            remote.totalBytes,
            updateProgress);
    } else {
        const blob = await downloadSource(session.uri, updateProgress, { controller, trackAsPlayback: true });
        if (!session.isCurrent()) return;
        session.downloadedBytes = blob.size;
        session.totalBytes ||= blob.size;
        session.input = await mountInput(blob, session.extension, session.generation, instance);
    }
    syncPlaybackBackgroundJob(session, "converting");
    if (activeDownloadController === controller) activeDownloadController = undefined;
}

async function downloadSource(uri, onProgress, options = {}) {
    const controller = options.controller ?? new AbortController();
    const trackAsPlayback = options.trackAsPlayback === true;
    if (trackAsPlayback) {
        activeDownloadController = controller;
    }
    try {
        const response = await fetch(uri, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Could not download the media (HTTP ${response.status}).`);
        }

        const total = Number(response.headers.get("Content-Length") ?? 0);
        if (!response.body) {
            const blob = await response.blob();
            onProgress(blob.size, total || blob.size, blob.size);
            return blob;
        }

        const reader = response.body.getReader();
        const chunks = [];
        let downloaded = 0;
        let lastReport = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            downloaded += value.byteLength;
            const now = performance.now();
            if (now - lastReport >= 100 || downloaded === total) {
                onProgress(downloaded, total, value.byteLength);
                lastReport = now;
            }
        }
        onProgress(downloaded, total || downloaded, chunks.at(-1)?.byteLength ?? 0);
        return new Blob(chunks, { type: response.headers.get("Content-Type") ?? "application/octet-stream" });
    } finally {
        if (trackAsPlayback && activeDownloadController === controller) activeDownloadController = undefined;
    }
}

async function probeRangeSource(uri, controller, expectedSize = 0) {
    try {
        const response = await fetch(uri, {
            headers: { Range: "bytes=0-0" },
            signal: controller.signal
        });
        if (response.status !== 206) {
            response.body?.cancel();
            return null;
        }
        const contentRange = response.headers.get("Content-Range");
        const totalBytes = Number(/\/(\d+)$/.exec(contentRange ?? "")?.[1] ?? expectedSize ?? 0);
        const bytes = await response.arrayBuffer();
        return totalBytes > 0
            ? { totalBytes, initialBytes: bytes.byteLength }
            : null;
    } catch (error) {
        if (error?.name === "AbortError") throw error;
        return null;
    }
}

async function mountRemoteInput(uri, extension, generation, instance, size, onProgress) {
    const name = `input${extension}`;
    const mountPoint = `/medius-${generation}`;
    await instance.createDir(mountPoint);
    registerRemoteProgress(uri, onProgress);
    try {
        const mounted = await instance.mount("REMOTEFS", { name, url: uri, size }, mountPoint);
        if (!mounted) throw new Error("The ffmpeg worker could not mount the remote media.");
        return {
            path: `${mountPoint}/${name}`,
            mountPoint,
            name,
            instance,
            remoteUrl: uri,
            remoteProgressSink: onProgress
        };
    } catch (error) {
        unregisterRemoteProgress(uri, onProgress);
        await Promise.allSettled([instance.deleteDir(mountPoint)]);
        throw error;
    }
}

async function mountInput(blob, extension, generation, instance) {
    const name = `input${extension}`;
    const mountPoint = `/medius-${generation}`;
    try {
        await instance.createDir(mountPoint);
        await instance.mount("WORKERFS", { blobs: [{ name, data: blob }] }, mountPoint);
        return { path: `${mountPoint}/${name}`, mountPoint, name, instance };
    } catch {
        // Fall back to an in-memory copy when the runtime has no WORKERFS support.
        await instance.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
        return { path: name, name, instance };
    }
}

async function releaseInput(input) {
    if (!input?.instance) return;
    if (input.remoteUrl && input.remoteProgressSink) {
        unregisterRemoteProgress(input.remoteUrl, input.remoteProgressSink);
    }

    if (input.mountPoint) {
        await Promise.allSettled([
            input.instance.unmount(input.mountPoint),
            input.instance.deleteDir(input.mountPoint)
        ]);
        return;
    }

    await Promise.allSettled([
        input.instance.deleteFile(input.name),
        input.instance.deleteFile("embedded.vtt")
    ]);
}

// Reads the real codec configuration out of the produced init segment so the
// SourceBuffer MIME type always matches the bytes being appended.
function describeSegment(segment) {
    const avcc = findBox(segment, "avcC");
    const codecs = [];
    if (avcc >= 0 && avcc + 7 < segment.length) {
        codecs.push(`avc1.${toHex(segment[avcc + 5])}${toHex(segment[avcc + 6])}${toHex(segment[avcc + 7])}`);
    } else {
        codecs.push("avc1.42E01F");
    }

    if (findBox(segment, "mp4a") >= 0) {
        codecs.push("mp4a.40.2");
    }

    return `video/mp4; codecs="${codecs.join(", ")}"`;
}

function findBox(data, type) {
    const [a, b, c, d] = [...type].map(character => character.charCodeAt(0));
    for (let index = 0; index + 4 <= data.length; index++) {
        if (data[index] === a && data[index + 1] === b && data[index + 2] === c && data[index + 3] === d) {
            return index;
        }
    }

    return -1;
}

function toHex(value) {
    return value.toString(16).padStart(2, "0").toUpperCase();
}

function isBuffered(sourceBuffer, time) {
    return bufferedEndCovering(sourceBuffer, time) !== null;
}

function bufferedEndCovering(sourceBuffer, time) {
    if (!sourceBuffer) return null;

    const ranges = sourceBuffer.buffered;
    for (let index = 0; index < ranges.length; index++) {
        if (time >= ranges.start(index) - 0.25 && time < ranges.end(index) - 0.25) {
            return ranges.end(index);
        }
    }

    return null;
}

async function finishStream(session) {
    await waitForIdleBuffer(session.sourceBuffer);
    if (session.mediaSource?.readyState === "open") {
        try {
            session.mediaSource.endOfStream();
        } catch {
            // Another append may have reopened the stream.
        }
    }
}

function waitForIdleBuffer(sourceBuffer) {
    if (!sourceBuffer?.updating) return Promise.resolve();
    return new Promise(resolve =>
        sourceBuffer.addEventListener("updateend", resolve, { once: true }));
}

async function extractEmbeddedSubtitle(inputName) {
    try {
        await ffmpeg.exec(
            ["-y", "-i", inputName, "-map", "0:s:0", "-c:s", "webvtt", "embedded.vtt"],
            120000);
        return new TextDecoder().decode(await ffmpeg.readFile("embedded.vtt"));
    } catch {
        return undefined;
    }
}

async function cleanupFfmpegFiles(...names) {
    if (!ffmpeg) return;
    await Promise.allSettled([
        ...names.map(name => ffmpeg.deleteFile(name)),
        ffmpeg.deleteFile("embedded.vtt")
    ]);
}

function appendBuffer(sourceBuffer, data) {
    return new Promise((resolve, reject) => {
        const onDone = () => {
            sourceBuffer.removeEventListener("error", onError);
            resolve();
        };
        const onError = () => {
            sourceBuffer.removeEventListener("updateend", onDone);
            reject(new Error("The browser rejected a converted media segment."));
        };

        sourceBuffer.addEventListener("updateend", onDone, { once: true });
        sourceBuffer.addEventListener("error", onError, { once: true });
        try {
            sourceBuffer.appendBuffer(data);
        } catch (error) {
            sourceBuffer.removeEventListener("updateend", onDone);
            sourceBuffer.removeEventListener("error", onError);
            reject(error);
        }
    });
}

function findMediaFragmentOffset(data) {
    for (let index = 4; index + 4 <= data.length; index++) {
        if (data[index] === 0x6d
            && data[index + 1] === 0x6f
            && data[index + 2] === 0x6f
            && data[index + 3] === 0x66) {
            return index - 4;
        }
    }

    return -1;
}

function once(target, eventName) {
    return new Promise((resolve, reject) => {
        target.addEventListener(eventName, resolve, { once: true });
        target.addEventListener(
            "error",
            () => reject(new Error(`MediaSource ${eventName} failed.`)),
            { once: true });
    });
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function conversionError(logs = ffmpegLog) {
    return new Error(`ffmpeg.wasm could not convert this media file.\n${logs.slice(-5).join("\n")}`);
}

function addSubtitleTrack(player, webVtt) {
    if (!webVtt) {
        return;
    }

    subtitleObjectUrl = URL.createObjectURL(new Blob([webVtt], { type: "text/vtt" }));
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "Subtitles";
    track.srclang = "und";
    track.src = subtitleObjectUrl;
    track.default = true;
    player.appendChild(track);
    track.addEventListener("load", () => {
        track.track.mode = "showing";
    }, { once: true });
}

function setSubtitleInternal(webVtt) {
    clearSubtitleTracks();
    if (webVtt) addSubtitleTrack(video(), webVtt);
}

function clearSubtitleTracks() {
    for (const track of [...video().querySelectorAll("track")]) {
        track.remove();
    }
    if (subtitleObjectUrl) {
        URL.revokeObjectURL(subtitleObjectUrl);
        subtitleObjectUrl = undefined;
    }
}

function clearObjectUrls() {
    if (mediaObjectUrl) URL.revokeObjectURL(mediaObjectUrl);
    mediaObjectUrl = undefined;
}

function shiftWebVtt(webVtt, offsetMilliseconds) {
    if (!offsetMilliseconds) {
        return webVtt;
    }

    return webVtt.replace(
        /(?<start>(?:\d{1,3}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*(?<end>(?:\d{1,3}:)?\d{2}:\d{2}\.\d{3})/g,
        (_, start, end) => `${formatVttTime(parseVttTime(start) + offsetMilliseconds)} --> ${formatVttTime(parseVttTime(end) + offsetMilliseconds)}`);
}

function parseVttTime(value) {
    const parts = value.split(":").map(Number);
    const seconds = parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    return seconds * 1000;
}

function formatVttTime(milliseconds) {
    milliseconds = Math.max(0, milliseconds);
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor(milliseconds % 3600000 / 60000);
    const seconds = Math.floor(milliseconds % 60000 / 1000);
    const millis = Math.floor(milliseconds % 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function base64Url(bytes) {
    return btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
}

function waitForAuthorizationCode(popup, redirectUri, expectedState) {
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (popup.closed) {
                clearInterval(timer);
                reject(new Error("Sign-in was cancelled."));
                return;
            }

            try {
                if (!popup.location.href.startsWith(redirectUri)) return;
                const parameters = new URL(popup.location.href).searchParams;
                if (parameters.get("state") !== expectedState) {
                    throw new Error("The OAuth state did not match.");
                }
                const error = parameters.get("error_description");
                if (error) throw new Error(error);
                const code = parameters.get("code");
                if (!code) return;
                clearInterval(timer);
                popup.close();
                resolve(code);
            } catch (error) {
                if (error instanceof DOMException) return;
                clearInterval(timer);
                popup.close();
                reject(error);
            }
        }, 250);
    });
}
