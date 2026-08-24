/// <reference lib="webworker" />
import { CORE_URL, FFMessageType } from "./node_modules/@ffmpeg/ffmpeg/dist/esm/const.js";
import {
    ERROR_UNKNOWN_MESSAGE_TYPE,
    ERROR_NOT_LOADED,
    ERROR_IMPORT_FAILURE
} from "./node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js";

let ffmpeg;
const remoteDownloads = new Map();
const remoteMounts = new Map();

function reportRemoteChunk(url, range, xhr) {
    if (!remoteDownloads.has(url)) return;
    if (xhr._mediusMethod === "HEAD") return;
    const state = remoteDownloads.get(url);
    const contentRange = xhr.getResponseHeader("Content-Range");
    const match = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(contentRange ?? "");
    const start = match ? Number(match[1]) : Number(/^bytes=(\d+)-/i.exec(range ?? "")?.[1] ?? 0);
    const size = match
        ? Number(match[2]) - start + 1
        : Number(xhr.getResponseHeader("Content-Length") ?? xhr.response?.byteLength ?? 0);
    const total = match ? Number(match[3]) : state.totalBytes;
    if (size > 0) {
        state.ranges.push([start, start + size]);
        state.ranges.sort((left, right) => left[0] - right[0]);
        const merged = [];
        for (const item of state.ranges) {
            const last = merged.at(-1);
            if (last && item[0] <= last[1]) last[1] = Math.max(last[1], item[1]);
            else merged.push([...item]);
        }
        state.ranges = merged;
        state.downloadedBytes = merged.reduce((sum, item) => sum + item[1] - item[0], 0);
    }
    state.totalBytes = total || state.totalBytes;
    self.postMessage({
        type: FFMessageType.LOG,
        data: {
            type: "stdout",
            message: `[medius-range]${JSON.stringify({
                url,
                downloadedBytes: state.downloadedBytes,
                totalBytes: state.totalBytes,
                currentChunkBytes: size,
                rangeStart: start,
                rangeEnd: size > 0 ? start + size - 1 : start
            })}`
        }
    });
}

const NativeXMLHttpRequest = self.XMLHttpRequest;
class TrackedXMLHttpRequest extends NativeXMLHttpRequest {
    open(method, url, ...rest) {
        this._mediusMethod = String(method).toUpperCase();
        this._mediusUrl = String(url);
        return super.open(method, url, ...rest);
    }

    setRequestHeader(name, value) {
        if (name.toLowerCase() === "range") this._mediusRange = value;
        return super.setRequestHeader(name, value);
    }

    send(body) {
        const result = super.send(body);
        reportRemoteChunk(this._mediusUrl, this._mediusRange, this);
        return result;
    }
}
self.XMLHttpRequest = TrackedXMLHttpRequest;

const load = async ({ coreURL: requestedCoreURL, wasmURL, workerURL }) => {
    const first = !ffmpeg;
    let coreURL = requestedCoreURL || CORE_URL;
    try {
        importScripts(coreURL);
    } catch {
        if (!requestedCoreURL || requestedCoreURL === CORE_URL) {
            coreURL = CORE_URL.replace("/umd/", "/esm/");
        }
        self.createFFmpegCore = (await import(coreURL)).default;
        if (!self.createFFmpegCore) throw ERROR_IMPORT_FAILURE;
    }
    const resolvedWasmURL = wasmURL || coreURL.replace(/.js$/g, ".wasm");
    const resolvedWorkerURL = workerURL || coreURL.replace(/.js$/g, ".worker.js");
    ffmpeg = await self.createFFmpegCore({
        mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({
            wasmURL: resolvedWasmURL,
            workerURL: resolvedWorkerURL
        }))}`
    });
    ffmpeg.setLogger(data => self.postMessage({ type: FFMessageType.LOG, data }));
    ffmpeg.setProgress(data => self.postMessage({ type: FFMessageType.PROGRESS, data }));
    return first;
};

const exec = ({ args, timeout = -1 }) => {
    ffmpeg.setTimeout(timeout);
    ffmpeg.exec(...args);
    const result = ffmpeg.ret;
    ffmpeg.reset();
    return result;
};

const mount = ({ fsType, options, mountPoint }) => {
    if (fsType === "REMOTEFS") {
        remoteDownloads.set(options.url, {
            totalBytes: Number(options.size ?? 0),
            downloadedBytes: 0,
            ranges: []
        });
        remoteMounts.set(mountPoint, { url: options.url, name: options.name });
        const node = ffmpeg.FS.createLazyFile(mountPoint, options.name, options.url, true, false);
        const lazy = node.contents;
        lazy.cacheLength = function cacheKnownRemoteLength() {
            const length = Number(options.size);
            const chunkSize = 1024 * 1024;
            const recentChunks = new Map();
            const maxCachedChunks = 32;
            this.setDataGetter(chunkNumber => {
                const start = chunkNumber * chunkSize;
                const end = Math.min((chunkNumber + 1) * chunkSize - 1, length - 1);
                if (!this.chunks[chunkNumber]) {
                    const xhr = new XMLHttpRequest();
                    xhr.open("GET", options.url, false);
                    xhr.setRequestHeader("Range", `bytes=${start}-${end}`);
                    xhr.responseType = "arraybuffer";
                    xhr.send(null);
                    if (xhr.status !== 206) {
                        throw new Error(`Remote range request failed with HTTP ${xhr.status}.`);
                    }
                    this.chunks[chunkNumber] = new Uint8Array(xhr.response ?? []);
                }
                recentChunks.delete(chunkNumber);
                recentChunks.set(chunkNumber, true);
                while (recentChunks.size > maxCachedChunks) {
                    const oldest = recentChunks.keys().next().value;
                    recentChunks.delete(oldest);
                    this.chunks[oldest] = undefined;
                }
                return this.chunks[chunkNumber];
            });
            this._length = length;
            this._chunkSize = chunkSize;
            this.lengthKnown = true;
        };
        lazy.cacheLength();
        return true;
    }
    const fileSystem = ffmpeg.FS.filesystems[String(fsType)];
    if (!fileSystem) return false;
    ffmpeg.FS.mount(fileSystem, options, mountPoint);
    return true;
};

const unmount = ({ mountPoint }) => {
    const remote = remoteMounts.get(mountPoint);
    if (remote) {
        ffmpeg.FS.unlink(`${mountPoint}/${remote.name}`);
        remoteDownloads.delete(remote.url);
        remoteMounts.delete(mountPoint);
        return true;
    }
    try {
        const node = ffmpeg.FS.lookupPath(mountPoint).node;
        for (const child of Object.values(node.contents ?? {})) {
            if (child.url) remoteDownloads.delete(child.url);
        }
    } catch {
        // Cleanup still proceeds when the mount was already removed.
    }
    ffmpeg.FS.unmount(mountPoint);
    return true;
};

self.onmessage = async ({ data: { id, type, data: payload } }) => {
    const transfer = [];
    let data;
    try {
        if (type !== FFMessageType.LOAD && !ffmpeg) throw ERROR_NOT_LOADED;
        switch (type) {
            case FFMessageType.LOAD: data = await load(payload); break;
            case FFMessageType.EXEC: data = exec(payload); break;
            case FFMessageType.FFPROBE:
                ffmpeg.setTimeout(payload.timeout ?? -1);
                ffmpeg.ffprobe(...payload.args);
                data = ffmpeg.ret;
                ffmpeg.reset();
                break;
            case FFMessageType.WRITE_FILE:
                ffmpeg.FS.writeFile(payload.path, payload.data);
                data = true;
                break;
            case FFMessageType.READ_FILE:
                data = ffmpeg.FS.readFile(payload.path, { encoding: payload.encoding });
                break;
            case FFMessageType.DELETE_FILE: ffmpeg.FS.unlink(payload.path); data = true; break;
            case FFMessageType.RENAME: ffmpeg.FS.rename(payload.oldPath, payload.newPath); data = true; break;
            case FFMessageType.CREATE_DIR: ffmpeg.FS.mkdir(payload.path); data = true; break;
            case FFMessageType.LIST_DIR:
                data = ffmpeg.FS.readdir(payload.path).map(name => ({
                    name,
                    isDir: ffmpeg.FS.isDir(ffmpeg.FS.stat(`${payload.path}/${name}`).mode)
                }));
                break;
            case FFMessageType.DELETE_DIR: ffmpeg.FS.rmdir(payload.path); data = true; break;
            case FFMessageType.MOUNT: data = mount(payload); break;
            case FFMessageType.UNMOUNT: data = unmount(payload); break;
            default: throw ERROR_UNKNOWN_MESSAGE_TYPE;
        }
    } catch (error) {
        self.postMessage({ id, type: FFMessageType.ERROR, data: error.toString() });
        return;
    }
    if (data instanceof Uint8Array) transfer.push(data.buffer);
    self.postMessage({ id, type, data }, transfer);
};
