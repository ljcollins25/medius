import { FFmpeg } from "@ffmpeg/ffmpeg";

let ffmpeg;
let mediaObjectUrl;
let subtitleObjectUrl;
let ffmpegLogSink;
let segmentedActive = false;
let playbackGeneration = 0;
let subtitleRevision = 0;
const ffmpegLog = [];

const video = () => document.getElementById("media-player");
const status = () => document.getElementById("player-status");
const mountsKey = "medius.mounts.v1";
const ffmpegAssetVersion = "3";

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

export function saveMounts(json) {
    localStorage.setItem(mountsKey, json);
}

export function conversionStrategy(mode) {
    return mode === "Remux" ? "remux" : "transcode";
}

function beginPlaybackTransition(fileName, message) {
    const generation = ++playbackGeneration;
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

export async function playVideo(uri, fileName, mode, subtitleWebVtt, embeddedSubtitleOffsetMilliseconds) {
    const generation = beginPlaybackTransition(
        fileName,
        mode === "Direct" ? "Loading media…" : "Loading ffmpeg.wasm…");

    try {
        if (mode === "Transcode" && "MediaSource" in window) {
            await playTranscodedSegments(
                uri,
                fileName,
                subtitleWebVtt,
                embeddedSubtitleOffsetMilliseconds,
                generation);
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
    generation) {
    segmentedActive = true;
    await ensureFfmpegLoaded();

    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".bin";
    ffmpegLog.length = 0;
    status().textContent = "Loading media…";

    const session = {
        generation,
        isCurrent: () => generation === playbackGeneration,
        fileName,
        subtitleWebVtt,
        embeddedSubtitleOffsetMilliseconds,
        probe: { durationSeconds: Number.NaN, hasSubtitles: false },
        maxWidth: 854,
        needsInitSegment: true,
        seekTarget: null,
        mediaSource: null,
        sourceBuffer: null,
        player: null
    };

    session.input = await mountInput(uri, extension, generation);
    if (!session.isCurrent()) {
        await releaseInput(session.input);
        return;
    }

    // Hand control back as soon as playback starts; conversion continues in the background.
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const loop = runSegmentLoop(session, signalStarted);
    loop.catch(error => {
        if (session.isCurrent()) {
            status().textContent = error.message;
        }
    });

    await Promise.race([started, loop]);
}

async function runSegmentLoop(session, onStarted) {
    let position = 0;
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

    return data;
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
    return Number.isFinite(session.probe.durationSeconds)
        && position >= session.probe.durationSeconds - 0.2;
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

    if (session.probe.videoCodec === "h264") {
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
async function mountInput(uri, extension, generation) {
    const response = await fetch(uri);
    if (!response.ok) {
        throw new Error(`Could not download the media (HTTP ${response.status}).`);
    }

    const blob = await response.blob();
    const name = `input${extension}`;
    const mountPoint = `/medius-${generation}`;
    try {
        await ffmpeg.createDir(mountPoint);
        await ffmpeg.mount("WORKERFS", { blobs: [{ name, data: blob }] }, mountPoint);
        return { path: `${mountPoint}/${name}`, mountPoint, name };
    } catch {
        // Fall back to an in-memory copy when the runtime has no WORKERFS support.
        await ffmpeg.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
        return { path: name, name };
    }
}

async function releaseInput(input) {
    if (!input || !ffmpeg) return;

    if (input.mountPoint) {
        await Promise.allSettled([
            ffmpeg.unmount(input.mountPoint),
            ffmpeg.deleteDir(input.mountPoint)
        ]);
        return;
    }

    await cleanupFfmpegFiles(input.name);
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
