import { FFmpeg } from "@ffmpeg/ffmpeg";
import QRCode from "qrcode";
import { BrowserQRCodeReader } from "@zxing/browser";

let ffmpeg;
let mediaObjectUrl;
let subtitleObjectUrl;
let ffmpegLogSink;
let segmentedActive = false;
let activeSegmentLoop;
let playbackGeneration = 0;
let subtitleRevision = 0;
const ffmpegLog = [];

const video = () => document.getElementById("media-player");
const status = () => document.getElementById("player-status");
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

export function loadMounts() {
    return localStorage.getItem(mountsKey);
}

export async function clearConvertedCache() {
    await caches.delete(convertedCacheName);
    localStorage.removeItem(convertedCacheIndexKey);
    return true;
}

export async function getConvertedCacheUsage() {
    return readConvertedCacheIndex()
        .reduce((total, item) => total + item.size, 0);
}

export function saveMounts(json) {
    localStorage.setItem(mountsKey, json);
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

    status().textContent = message;
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
    convertedCacheLimitBytes = 536870912) {
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
                convertedCacheLimitBytes);
            return true;
        }

        let source = uri;
        let extractedSubtitle;
        if (mode !== "Direct") {
            segmentedActive = true;
            try {
                ({ source, extractedSubtitle } = await convertForBrowser(uri, fileName, mode));
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
        status().textContent = fileName;
        return true;
    } catch (error) {
        if (generation === playbackGeneration) {
            hideLoading();
            status().textContent = error?.message ?? String(error);
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

// Whole-file conversion, used for containers that only need a remux.
async function convertForBrowser(uri, fileName, mode) {
    await ensureFfmpegLoaded();

    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".bin";
    const inputName = `input${extension}`;
    const outputName = "output.mp4";
    ffmpegLog.length = 0;
    await cleanupFfmpegFiles(inputName, outputName);
    await ffmpeg.writeFile(inputName, new Uint8Array(await (await fetch(uri)).arrayBuffer()));

    const extractedSubtitle = await extractEmbeddedSubtitle(inputName);
    let exitCode = -1;
    if (conversionStrategy(mode) === "remux") {
        exitCode = await ffmpeg.exec([
            "-y", "-i", inputName,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c", "copy", "-movflags", "+faststart",
            outputName
        ], 180000);
    }
    if (exitCode !== 0) {
        exitCode = await ffmpeg.exec([
            "-y", "-i", inputName,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-c:v", "libx264", "-preset", "veryfast",
            "-c:a", "aac", "-movflags", "+faststart",
            outputName
        ], 600000);
    }
    if (exitCode !== 0) throw conversionError();

    const data = await ffmpeg.readFile(outputName);
    mediaObjectUrl = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
    await cleanupFfmpegFiles(inputName, outputName);
    return { source: mediaObjectUrl, extractedSubtitle };
}

async function ensureFfmpegLoaded() {
    ffmpeg ??= new FFmpeg();
    const instance = ffmpeg;
    if (instance.loaded) {
        return;
    }

    instance.on("log", ({ message }) => {
        ffmpegLog.push(message);
        if (ffmpegLog.length > 40) ffmpegLog.shift();
        ffmpegLogSink?.push(message);
    });
    instance.on("progress", ({ progress }) => {
        if (!segmentedActive && Number.isFinite(progress)) {
            status().textContent = `Converting locally… ${Math.max(0, Math.min(100, Math.round(progress * 100)))}%`;
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
    convertedCacheLimitBytes) {
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
        needsInitSegment: true,
        seekTarget: null,
        mediaSource: null,
        sourceBuffer: null,
        player: null,
        startSeconds: startSeconds >= 0 ? startSeconds : 0,
        endSeconds: endSeconds > startSeconds ? endSeconds : null,
        uri,
        extension,
        input: null
    };

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

async function runSegmentLoop(session, onStarted) {
    let position = session.startSeconds;
    let playing = false;
    // A short piece is converted first, and again after each seek, so playback resumes quickly.
    let useShortSegment = true;

    try {
        while (session.isCurrent()) {
            if (session.seekTarget !== null) {
                // Convert from the exact seek point so playback can resume immediately.
                position = Math.max(0, session.seekTarget);
                session.seekTarget = null;
                session.needsInitSegment = true;
                useShortSegment = true;
            }

            // Never reconvert media that is already in the buffer.
            const bufferedEnd = bufferedEndCovering(session.sourceBuffer, position);
            if (bufferedEnd !== null) {
                position = bufferedEnd;
            }

            if (isFullyConverted(session, position)) {
                await finishStream(session);
                reportStatus(session, position, playing);
                if (!await waitForSeek(session)) return;
                continue;
            }

            if (playing && !await waitForBufferRoom(session, position)) return;
            if (session.seekTarget !== null) continue;

            const duration = useShortSegment ? FIRST_SEGMENT_SECONDS : SEGMENT_SECONDS;
            const segment = await convertSegment(session, position, duration);
            if (!session.isCurrent()) return;

            if (!segment) {
                if (!playing) throw conversionError();
                // Nothing decodable here, so treat this point as the end of the media.
                session.probe.durationSeconds = Math.min(
                    Number.isFinite(session.probe.durationSeconds) ? session.probe.durationSeconds : Infinity,
                    position);
                continue;
            }

            await appendSegment(session, segment, position);
            position += duration;
            useShortSegment = false;

            if (!playing) {
                playing = true;
                await beginPlayback(session);
                onStarted();
            }

            reportStatus(session, position, playing);
            if (playing
                && !session.subtitleWebVtt
                && session.probe.hasSubtitles
                && !session.embeddedSubtitleStarted
                && position >= FIRST_SEGMENT_SECONDS + (SEGMENT_SECONDS * 2)) {
                session.embeddedSubtitleStarted = true;
                const revision = subtitleRevision;
                await ensureSessionInput(session);
                const embedded = await extractEmbeddedSubtitle(session.input.path);
                if (session.isCurrent() && revision === subtitleRevision && embedded) {
                    setSubtitleInternal(
                        shiftWebVtt(embedded, session.embeddedSubtitleOffsetMilliseconds));
                }
            }
        }
    } finally {
        if (session.isCurrent()) {
            segmentedActive = false;
        }
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
    let exitCode;
    try {
        exitCode = await ffmpeg.exec(buildSegmentArgs(session, outputName, start, duration), 180000);
    } finally {
        ffmpegLogSink = undefined;
    }
    if (!session.isCurrent() || exitCode !== 0) return null;

    if (capture) {
        session.probe = parseProbe(lines.join("\n"));
    }

    const data = await ffmpeg.readFile(outputName);
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

    touchConvertedCacheEntry(key, Number(response.headers.get("X-Medius-Size") ?? 0));
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
    await pruneConvertedCache(limitBytes);
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
    const entries = readConvertedCacheIndex().sort((a, b) => a.lastAccess - b.lastAccess);
    let total = entries.reduce((sum, item) => sum + item.size, 0);
    const cache = await caches.open(convertedCacheName);
    while (total > limitBytes && entries.length > 0) {
        const removed = entries.shift();
        total -= removed.size;
        await cache.delete(convertedSegmentRequest(removed.key));
    }
    localStorage.setItem(convertedCacheIndexKey, JSON.stringify(entries));
}

async function appendSegment(session, data, start) {
    if (!session.sourceBuffer) {
        await attachMediaSource(session, data);
    }

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
        status().textContent = "Converting first segment…";
        return;
    }

    const ahead = Math.max(0, convertedSeconds - session.player.currentTime);
    const total = Number.isFinite(session.probe.durationSeconds)
        ? ` of ${formatClock(session.probe.durationSeconds)}`
        : "";
    status().textContent =
        `${session.fileName} — converted ${formatClock(convertedSeconds)}${total} (${ahead.toFixed(0)}s ahead)`;
}

function formatClock(seconds) {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
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
            args.push("-vf", `scale=w='min(${session.maxWidth},iw)':h=-2`);
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

// WORKERFS exposes the source as a virtual file so ffmpeg reads the parts it needs
// instead of copying the whole download into the wasm heap.
async function ensureSessionInput(session) {
    if (session.input) return;
    status().textContent = "Loading media source…";
    await ensureFfmpegLoaded();
    if (!session.isCurrent()) return;
    const instance = ffmpeg;
    session.input = await mountInput(session.uri, session.extension, session.generation, instance);
}

async function mountInput(uri, extension, generation, instance) {
    const response = await fetch(uri);
    if (!response.ok) {
        throw new Error(`Could not download the media (HTTP ${response.status}).`);
    }

    const blob = await response.blob();
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

function conversionError() {
    return new Error(`ffmpeg.wasm could not convert this media file.\n${ffmpegLog.slice(-5).join("\n")}`);
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
