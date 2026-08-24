import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await build({
    entryPoints: ["player-src.js"],
    outfile: "wwwroot/player.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022"
});

await mkdir("wwwroot/ffmpeg", { recursive: true });
await build({
    entryPoints: ["ffmpeg-worker.js"],
    outfile: "wwwroot/ffmpeg/worker.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022"
});

for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
    await copyFile(`node_modules/@ffmpeg/core/dist/esm/${file}`, `wwwroot/ffmpeg/${file}`);
}
