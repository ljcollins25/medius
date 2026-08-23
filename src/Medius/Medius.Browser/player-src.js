import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

let ffmpeg;
let mediaObjectUrl;
let subtitleObjectUrl;
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
            if (ffmpegLog.length > 20) ffmpegLog.shift();
        });
        ffmpeg.on("progress", ({ progress }) => {
            if (Number.isFinite(progress)) {
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
    await ensureFfmpegLoaded();
    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".bin";
    const inputName = `input${extension}`;
    ffmpegLog.length = 0;
    await cleanupFfmpegFiles(inputName);
    await ffmpeg.writeFile(inputName, await fetchFile(uri));

    const extractedSubtitle = await extractEmbeddedSubtitle(inputName);
    const subtitle = subtitleWebVtt
        ?? (extractedSubtitle
            ? shiftWebVtt(extractedSubtitle, embeddedSubtitleOffsetMilliseconds)
            : undefined);

    const mediaSource = new MediaSource();
    mediaObjectUrl = URL.createObjectURL(mediaSource);
    const player = video();
    player.pause();
    player.replaceChildren();
    player.src = mediaObjectUrl;
    addSubtitleTrack(player, subtitle);
    await once(mediaSource, "sourceopen");

    const mimeType = "video/mp4";
    if (!MediaSource.isTypeSupported(mimeType)) {
        throw new Error(`This browser cannot play ${mimeType}.`);
    }

    const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
    const segmentSeconds = 15;
    let segmentIndex = 0;
    let started = false;
    try {
        while (true) {
            const outputName = `segment-${segmentIndex}.mp4`;
            await Promise.allSettled([ffmpeg.deleteFile(outputName)]);
            status().textContent = `Converting segment ${segmentIndex + 1}…`;
            const exitCode = await ffmpeg.exec([
                "-y",
                "-ss", String(segmentIndex * segmentSeconds),
                "-i", inputName,
                "-t", String(segmentSeconds),
                "-map", "0:v:0",
                "-map", "0:a:0?",
                "-vf", "scale=w='min(1280,iw)':h=-2",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "28",
                "-profile:v", "baseline",
                "-level:v", "3.1",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "128k",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "-reset_timestamps", "1",
                outputName
            ]);
            if (exitCode !== 0) {
                if (!started) throw conversionError();
                break;
            }

            const file = await ffmpeg.readFile(outputName);
            await ffmpeg.deleteFile(outputName);
            const mediaFragmentOffset = findMediaFragmentOffset(file);
            if (mediaFragmentOffset < 0) {
                if (!started) throw conversionError();
                break;
            }

            sourceBuffer.timestampOffset = segmentIndex * segmentSeconds;
            await appendBuffer(
                sourceBuffer,
                segmentIndex === 0 ? file : file.slice(mediaFragmentOffset));
            if (!started) {
                started = true;
                try {
                    await player.play();
                } catch (error) {
                    if (error?.name !== "NotAllowedError") throw error;
                    status().textContent = `${fileName} is ready — press Play.`;
                }
            }
            segmentIndex++;
        }

        if (mediaSource.readyState === "open") mediaSource.endOfStream();
        status().textContent = fileName;
    } catch (error) {
        if (mediaSource.readyState === "open") {
            mediaSource.endOfStream("decode");
        }
        throw error;
    } finally {
        await cleanupFfmpegFiles(inputName);
    }
}

async function extractEmbeddedSubtitle(inputName) {
    try {
        await ffmpeg.exec(["-y", "-i", inputName, "-map", "0:s:0", "-c:s", "webvtt", "embedded.vtt"]);
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
