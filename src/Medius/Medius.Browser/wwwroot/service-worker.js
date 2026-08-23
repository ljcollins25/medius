const SHELL_CACHE = "medius-shell-v1";
const MEDIA_CACHE = "medius-media-v1";
const OFFLINE_PREFIX = "/__medius_offline/";
const SHELL_FILES = [
    "./",
    "./index.html",
    "./app.css",
    "./main.js",
    "./player.js",
    "./manifest.webmanifest",
    "./ffmpeg/worker.js",
    "./ffmpeg/ffmpeg-core.js",
    "./ffmpeg/ffmpeg-core.wasm"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => cache.addAll(SHELL_FILES))
            .then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key.startsWith("medius-shell-") && key !== SHELL_CACHE)
                    .map(key => caches.delete(key))))
            .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    if (url.origin === self.location.origin && url.pathname.includes(OFFLINE_PREFIX)) {
        event.respondWith(serveOfflineMedia(event.request));
        return;
    }

    if (event.request.method !== "GET" || url.origin !== self.location.origin) {
        return;
    }

    event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;

    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(request, response.clone());
        }
        return response;
    } catch {
        if (request.mode === "navigate") {
            return await caches.match("./index.html");
        }
        throw new Error(`Offline resource is unavailable: ${request.url}`);
    }
}

async function serveOfflineMedia(request) {
    const cache = await caches.open(MEDIA_CACHE);
    const cached = await cache.match(new Request(request.url, { method: "GET" }));
    if (!cached) return new Response("Offline media not found", { status: 404 });

    const range = request.headers.get("Range");
    if (!range) return cached;

    const match = /^bytes=(\d+)-(\d*)$/i.exec(range);
    if (!match) return new Response("Invalid range", { status: 416 });

    const blob = await cached.blob();
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1;
    if (start > end || start >= blob.size) {
        return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${blob.size}` }
        });
    }

    const headers = new Headers(cached.headers);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Range", `bytes ${start}-${end}/${blob.size}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(blob.slice(start, end + 1), {
        status: 206,
        statusText: "Partial Content",
        headers
    });
}
