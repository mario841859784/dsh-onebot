/**
 * Inbound image downscaling: shrink images whose long edge exceeds a cap so
 * the vision model reads a reasonably sized file (port of the Hermes
 * adapter's `_shrink_image`, Python/PIL → TS/@napi-rs/canvas, zero new
 * dependencies). Decision record: DEVLOG §3.12.
 *
 * EXIF note: @napi-rs/canvas `loadImage` already applies the EXIF
 * Orientation tag when decoding (verified: a 3000×2000 JPEG with
 * Orientation=6 decodes as 2000×3000), so no manual rotation is needed —
 * the decoded size IS the display size.
 * @module dsh-onebot/image-shrink
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
/** Shrink target JPEG quality (t2i renderer uses the same addon). */
const JPEG_QUALITY = 85;
/** Whether the buffer starts with a GIF magic (animated images are kept). */
function isGif(data) {
    return data.length >= 6 &&
        (data.toString('latin1', 0, 6) === 'GIF87a' || data.toString('latin1', 0, 6) === 'GIF89a');
}
/**
 * Downscale an image whose long edge exceeds `maxSize`.
 * @param src - absolute path of the downloaded image.
 * @param maxSize - long-edge cap in px (`<=0` disables shrinking).
 * @returns the path of the shrunken file (never overwrites `src`), or
 *   `undefined` when the image was already small enough, is an animated
 *   GIF, or decoding/processing failed (caller keeps the original).
 */
export async function shrinkImage(src, maxSize) {
    if (maxSize <= 0)
        return undefined;
    let data;
    try {
        data = await readFile(src);
    }
    catch {
        return undefined;
    }
    if (isGif(data))
        return undefined;
    let img;
    try {
        img = await loadImage(data);
    }
    catch {
        return undefined;
    }
    if (Math.max(img.width, img.height) <= maxSize)
        return undefined;
    const scale = maxSize / Math.max(img.width, img.height);
    const outW = Math.max(1, Math.round(img.width * scale));
    const outH = Math.max(1, Math.round(img.height * scale));
    const canvas = createCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Black backdrop: JPEG cannot carry alpha; matches the PIL convert("RGB")
    // behaviour of the original (decision: transparent pixels pad black).
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);
    // Transparent-capable source extension → PNG, otherwise JPEG. The addon's
    // Image exposes no alpha flag, so the extension is the alpha signal
    // (QQ photos are overwhelmingly JPEG; PNGs keep their transparency).
    const png = /\.png$/i.test(src);
    const out = src.replace(/\.[^.]+$/, '') + '-c' + maxSize + (png ? '.png' : '.jpg');
    try {
        await writeFile(out, png ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', JPEG_QUALITY));
        return out;
    }
    catch {
        return undefined;
    }
}
