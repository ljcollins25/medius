import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

let ffmpeg;
let mediaObjectUrl;
let subtitleObjectUrl;
let ffmpegLogSink;
let segmentedActive = false;
let playbackGeneration = 0;
const ffmpegLog = [];

const video = () => document.getElementById("media-player");
const status = () => document.getElementById("player-status");
const mountsKey = "medius.mounts.v1";
const ffmpegAssetVersion = "3";

export function loadMounts() {
    return localStorage.getItem(mountsKey);
}

export function saveMounts(json) {
    localStorage.setItem(mountsKey, json);
}

export function conversionStrategy(mode) {
    return mode === "Remux" ? "remux" : "transcode";
}

export async function playVideo(uri, fileName, mode, subtitleWebVtt, embeddedSubtitleOffsetMilliseconds) {
    status().textContent = mode === "Direct" ? "Loading media…" : "Loading ffmpeg.wasm…";
    clearObjectUrls();

    if (mode === "Transcode" && "MediaSource" in window) {
        await playTranscodedSegments(uri, fileName, subtitleWebVtt, embeddedSubtitleOffsetMilliseconds);
        return true;
    }

    let source = uri;
    let extractedSubtitle;
    if (mode !== "Direct") {
        ({ source, extractedSubtitle } = await convertForBrowser(uri, fileName, mode));
    }

    const player = video();
    player.pause();
    player.replaceChildren();
    player.src = source;
    const subtitle = subtitleWebVtt
        ?? (extractedSubtitle
            ? shiftWebVtt(extractedSubtitle, embeddedSubtitleOffsetMilliseconds)
            : undefined);
    addSubtitleTrack(player, subtitle);
    await player.play();
    status().textContent = fileName;
    return true;
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

async function convertForBrowser(uri, fileName, mode) {
    await ensureFfmpegLoaded();

    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".bin";
    const inputName = `input${extension}`;
    const outputName = "output.mp4";
    ffmpegLog.length = 0;
    await cleanupFfmpegFiles(inputName, outputName);
    await ffmpeg.writeFile(inputName, await fetchFile(uri));

    const extractedSubtitle = await extractEmbeddedSubtitle(inputName);
    let exitCode = -1;
    if (conversionStrategy(mode) === "remux") {
        exitCode = await ffmpeg.exec([
            "-y",
            "-i", inputName,
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c", "copy",
            "-movflags", "+faststart",
            outputName
        ]);
    }
    if (exitCode !== 0) {
        exitCode = await ffmpeg.exec([
            "-y",
            "-i", inputName,
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-c:a", "aac",
            "-movflags", "+faststart",
            outputName
        ]);
    }
    if (exitCode !== 0) throw conversionError();

    const data = await ffmpeg.readFile(outputName);
    mediaObjectUrl = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
    await cleanupFfmpegFiles(inputName, outputName);
    return { source: mediaObjectUrl, extractedSubtitle };
}

async function ensureFfmpegLoaded() {
    ffmpeg ??= new FFmpeg();
    if (!ffmpeg.loaded) {
        ffmpeg.on("log", ({ message }) => {
            ffmpegLog.push(message);
            if (ffmpegLog.length > 40) ffmpegLog.shift();
            ffmpegLogSink?.push(message);
        });
        ffmpeg.on("progress", ({ progress }) => {
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
                ffmpeg.load({
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
            ffmpeg.terminate();
            ffmpeg = undefined;
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

async function playTranscodedSegments(uri, fileName, subtitleWebVtt, embeddedSubtitleOffsetMilliseconds) {
    const generation = ++playbackGeneration;
    const isCurrent = () => generation === playbackGeneration;
    segmentedActive = true;
    await ensureFfmpegLoaded();

    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".bin";
    ffmpegLog.length = 0;

    status().textContent = "Loading media…";
    const input = await mountInput(uri, extension);
    if (!isCurrent()) return;

    // Stream details come from the first segment's own log, so no extra probe pass is needed.
    let probe = { durationSeconds: Number.NaN, width: 0, hasSubtitles: false };

    // The first piece is short so playback starts quickly; later pieces are longer for efficiency.
    const firstSegmentSeconds = 5;
    const segmentSeconds = 15;
    let maxWidth = 854;
    let position = 0;
    let segmentIndex = 0;
    let mediaSource;
    let sourceBuffer;
    let player;
    let needsInitSegment = true;

    try {
        while (!Number.isFinite(probe.durationSeconds) || position < probe.durationSeconds - 0.2) {
            if (!isCurrent()) return;

            const duration = segmentIndex === 0 ? firstSegmentSeconds : segmentSeconds;
            const outputName = `segment-${segmentIndex % 2}.mp4`;
            await Promise.allSettled([ffmpeg.deleteFile(outputName)]);
            reportSegmentStatus(fileName, sourceBuffer, player, position);

            const lines = [];
            ffmpegLogSink = segmentIndex === 0 ? lines : undefined;
            const startedAt = performance.now();
            let exitCode;
            try {
                exitCode = await ffmpeg.exec(
                    buildSegmentArgs(input.path, outputName, position, duration, probe, maxWidth),
                    180000);
            } finally {
                ffmpegLogSink = undefined;
            }
            const elapsedSeconds = (performance.now() - startedAt) / 1000;
            if (!isCurrent()) return;
            if (exitCode !== 0) {
                if (!sourceBuffer) throw conversionError();
                break;
            }

            const file = await ffmpeg.readFile(outputName);
            await Promise.allSettled([ffmpeg.deleteFile(outputName)]);
            const fragmentOffset = findMediaFragmentOffset(file);
            if (fragmentOffset < 0) {
                if (!sourceBuffer) throw conversionError();
                break;
            }

            if (segmentIndex === 0) {
                probe = parseProbe(lines.join("\n"));

                // The buffer is created from the real output so its codec string always matches.
                mediaSource = new MediaSource();
                mediaObjectUrl = URL.createObjectURL(mediaSource);
                player = video();
                player.pause();
                player.replaceChildren();
                player.src = mediaObjectUrl;
                if (subtitleWebVtt) {
                    addSubtitleTrack(player, subtitleWebVtt);
                }
                await once(mediaSource, "sourceopen");
                if (!isCurrent()) return;

                const mimeType = describeSegment(file);
                if (!MediaSource.isTypeSupported(mimeType)) {
                    throw new Error(`This browser cannot play ${mimeType}.`);
                }

                sourceBuffer = mediaSource.addSourceBuffer(mimeType);
                sourceBuffer.mode = "sequence";
                if (Number.isFinite(probe.durationSeconds)) {
                    try {
                        mediaSource.duration = probe.durationSeconds;
                    } catch {
                        // A browser may refuse an explicit duration; the scrubber grows as segments append.
                    }
                }
            }

            await appendBuffer(sourceBuffer, needsInitSegment ? file : file.slice(fragmentOffset));
            needsInitSegment = false;
            position += duration;
            segmentIndex++;

            if (segmentIndex === 1) {
                try {
                    await player.play();
                } catch (error) {
                    if (error?.name !== "NotAllowedError") throw error;
                }

                if (!subtitleWebVtt && probe.hasSubtitles) {
                    const embedded = await extractEmbeddedSubtitle(input.path);
                    if (!isCurrent()) return;
                    if (embedded) {
                        addSubtitleTrack(player, shiftWebVtt(embedded, embeddedSubtitleOffsetMilliseconds));
                    }
                }
            }

            // Drop resolution when conversion cannot outpace playback, so the buffer stops shrinking.
            if (maxWidth > 480 && elapsedSeconds > duration * 0.85) {
                maxWidth = maxWidth > 640 ? 640 : 480;
                needsInitSegment = true;
            }
        }

        await finishStream(mediaSource, sourceBuffer);
        status().textContent = fileName;
    } catch (error) {
        if (mediaSource?.readyState === "open") {
            try {
                mediaSource.endOfStream("decode");
            } catch {
                // The stream may already be closing.
            }
        }
        throw error;
    } finally {
        if (isCurrent()) {
            segmentedActive = false;
            await releaseInput(input);
        }
    }
}

// WORKERFS exposes the source as a virtual file so ffmpeg reads the parts it needs
// instead of copying the whole download into the wasm heap.
async function mountInput(uri, extension) {
    const response = await fetch(uri);
    if (!response.ok) {
        throw new Error(`Could not download the media (HTTP ${response.status}).`);
    }

    const blob = await response.blob();
    const name = `input${extension}`;
    const mountPoint = "/medius";
    try {
        await ffmpeg.createDir(mountPoint);
    } catch {
        // The directory survives from an earlier playback.
    }

    try {
        await ffmpeg.mount("WORKERFS", { blobs: [{ name, data: blob }] }, mountPoint);
        return { path: `${mountPoint}/${name}`, mountPoint, name };
    } catch {
        // Fall back to an in-memory copy when the runtime has no WORKERFS support.
        await ffmpeg.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
        return { path: name, name };
    }
}

async function releaseInput(input) {
    if (input.mountPoint) {
        await Promise.allSettled([ffmpeg.unmount(input.mountPoint)]);
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
        const profile = segment[avcc + 5];
        const compatibility = segment[avcc + 6];
        const level = segment[avcc + 7];
        codecs.push(`avc1.${toHex(profile)}${toHex(compatibility)}${toHex(level)}`);
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

function buildSegmentArgs(inputName, outputName, start, duration, probe, maxWidth) {
    const args = ["-y"];
    if (start > 0) args.push("-ss", String(start));
    args.push("-i", inputName, "-t", String(duration), "-map", "0:v:0", "-map", "0:a:0?");

    if (probe.videoCodec === "h264") {
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
        if (maxWidth) {
            // min() keeps smaller sources at their native size instead of upscaling them.
            args.push("-vf", `scale=w='min(${maxWidth},iw)':h=-2`);
        }
    }

    if (probe.audioCodec === "aac") {
        args.push("-c:a", "copy");
    } else {
        args.push("-c:a", "aac", "-b:a", "128k");
    }

    args.push(
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-reset_timestamps", "1",
        outputName);
    return args;
}

function reportSegmentStatus(fileName, sourceBuffer, player, convertedSeconds) {
    if (!sourceBuffer) {
        status().textContent = "Converting first segment…";
        return;
    }

    const ahead = Math.max(0, convertedSeconds - player.currentTime);
    status().textContent = `${fileName} — ${ahead.toFixed(0)}s buffered ahead`;
}

async function finishStream(mediaSource, sourceBuffer) {
    if (sourceBuffer.updating) {
        await new Promise(resolve =>
            sourceBuffer.addEventListener("updateend", resolve, { once: true }));
    }

    if (mediaSource.readyState === "open") {
        mediaSource.endOfStream();
    }
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
    await Promise.allSettled([
        ...names.map(name => ffmpeg.deleteFile(name)),
        ffmpeg.deleteFile("embedded.vtt")
    ]);
}

function appendBuffer(sourceBuffer, data) {
    return new Promise((resolve, reject) => {
        sourceBuffer.addEventListener("updateend", resolve, { once: true });
        sourceBuffer.addEventListener(
            "error",
            () => reject(new Error("The browser rejected a converted media segment.")),
            { once: true });
        sourceBuffer.appendBuffer(data);
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
}

function clearObjectUrls() {
    if (mediaObjectUrl) URL.revokeObjectURL(mediaObjectUrl);
    if (subtitleObjectUrl) URL.revokeObjectURL(subtitleObjectUrl);
    mediaObjectUrl = undefined;
    subtitleObjectUrl = undefined;
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
