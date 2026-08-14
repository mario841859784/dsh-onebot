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
/**
 * Downscale an image whose long edge exceeds `maxSize`.
 * @param src - absolute path of the downloaded image.
 * @param maxSize - long-edge cap in px (`<=0` disables shrinking).
 * @returns the path of the shrunken file (never overwrites `src`), or
 *   `undefined` when the image was already small enough, is an animated
 *   GIF, or decoding/processing failed (caller keeps the original).
 */
export declare function shrinkImage(src: string, maxSize: number): Promise<string | undefined>;
