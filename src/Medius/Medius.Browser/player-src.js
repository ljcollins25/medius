import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

let ffmpeg;
let mediaObjectUrl;
let subtitleObjectUrl;

const video = () => document.getElementById("media-player");
const status = () => document.getElementById("player-status");
const mountsKey = "medius.mounts.v1";

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
    ffmpeg ??= new FFmpeg();
    if (!ffmpeg.loaded) {
        await ffmpeg.load({
            coreURL: new URL("./ffmpeg/ffmpeg-core.js", import.meta.url).href,
            wasmURL: new URL("./ffmpeg/ffmpeg-core.wasm", import.meta.url).href
        });
    }

    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ".bin";
    const inputName = `input${extension}`;
    const outputName = "output.mp4";
    await ffmpeg.writeFile(inputName, await fetchFile(uri));

    let extractedSubtitle;
    try {
        await ffmpeg.exec(["-i", inputName, "-map", "0:s:0", "-c:s", "webvtt", "embedded.vtt"]);
        extractedSubtitle = new TextDecoder().decode(await ffmpeg.readFile("embedded.vtt"));
    } catch {
        // A media file is not required to contain a subtitle stream.
    }

    let exitCode = -1;
    if (conversionStrategy(mode) === "remux") {
        exitCode = await ffmpeg.exec([
            "-i", inputName,
            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-c", "copy",
            "-movflags", "+faststart",
            outputName
        ]);
    }
    if (mode === "Transcode" || exitCode !== 0) {
        exitCode = await ffmpeg.exec([
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
    if (exitCode !== 0) {
        throw new Error("ffmpeg.wasm could not convert this media file.");
    }

    const data = await ffmpeg.readFile(outputName);
    mediaObjectUrl = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
    await Promise.allSettled([
        ffmpeg.deleteFile(inputName),
        ffmpeg.deleteFile(outputName),
        ffmpeg.deleteFile("embedded.vtt")
    ]);
    return { source: mediaObjectUrl, extractedSubtitle };
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
