/**
 * Inbound image downscaling: shrink images whose long edge exceeds a cap so
 * the vision model reads a reasonably sized file (port of the Hermes
 * adapter's `_shrink_image`, Python/PIL → TS/@napi-rs/canvas, zero new
 * dependencies). Decision record: DEVLOG §3.12.
 *
 * Decode-bomb guard: PNG/JPEG headers are pre-parsed before decoding; a
 * declared dimension beyond `MAX_DECODE_EDGE` aborts before any decode.
 *
 * EXIF note: @napi-rs/canvas `loadImage` already applies the EXIF
 * Orientation tag when decoding (verified: a 3000×2000 JPEG with
 * Orientation=6 decodes as 2000×3000), so no manual rotation is needed —
 * the decoded size IS the display size.
 * @module dsh-onebot/image-shrink
 */

import { readFile, writeFile } from 'node:fs/promises'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { Image, SKRSContext2D } from '@napi-rs/canvas'

/** Shrink target JPEG quality (t2i renderer uses the same addon). */
const JPEG_QUALITY = 85

/** Whether the buffer starts with a GIF magic (animated images are kept). */
function isGif(data: Buffer): boolean {
  return data.length >= 6 &&
    (data.toString('latin1', 0, 6) === 'GIF87a' || data.toString('latin1', 0, 6) === 'GIF89a')
}

/**
 * Hard cap on the long edge an image header may declare: a PNG/JPEG whose
 * header claims a larger dimension is aborted before decoding, because the
 * decoder would otherwise allocate a multi-GB surface for a few hundred KB
 * of input (e.g. a 30000×30000 claim), which can OOM the host. Named for
 * direct use by tests.
 */
export const MAX_DECODE_EDGE = 8192

/** Pixel dimensions as declared by an image header. */
interface DeclaredSize {
  width: number
  height: number
}

/**
 * Read the dimensions declared by a PNG header: 8-byte signature + the IHDR
 * chunk (width at offset 16, height at offset 20, big-endian uint32).
 * Returns undefined when the header is absent or truncated — the caller
 * then defers to the normal decode path.
 */
function pngDeclaredSize(data: Buffer): DeclaredSize | undefined {
  if (data.length < 24) return undefined
  if (data.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') return undefined
  if (data.toString('latin1', 12, 16) !== 'IHDR') return undefined
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

/**
 * Read the dimensions declared by a JPEG SOF0/SOF1/SOF2 frame header,
 * scanning the marker segments after the FF D8 start-of-image. Returns
 * undefined on any structural surprise (truncation, standalone marker,
 * bogus segment length) — the caller then defers to the normal decode path.
 */
function jpegDeclaredSize(data: Buffer): DeclaredSize | undefined {
  if (data.length < 4) return undefined
  if (data[0] !== 0xff || data[1] !== 0xd8) return undefined
  let pos = 2
  while (pos + 2 <= data.length) {
    if (data[pos] !== 0xff) return undefined
    // Skip any 0xFF fill bytes preceding the marker code (JPEG B.1.1.5).
    let cursor = pos + 1
    while (cursor < data.length && data[cursor] === 0xff) cursor++
    if (cursor >= data.length) return undefined
    const marker = data[cursor]
    // Standalone markers carry no length; a frame header never precedes one.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return undefined
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      // SOF payload: 1-byte precision, then 2-byte big-endian height/width.
      if (cursor + 6 > data.length) return undefined
      return { height: data.readUInt16BE(cursor + 2), width: data.readUInt16BE(cursor + 4) }
    }
    // Every other marker carries a 2-byte big-endian length counting itself.
    if (cursor + 3 > data.length) return undefined
    const length = data.readUInt16BE(cursor + 1)
    if (length < 2) return undefined
    pos = cursor + 1 + length
  }
  return undefined
}

/**
 * Decode-bomb pre-check: true when the PNG IHDR / JPEG SOF header declares a
 * width or height beyond `cap`. Unparseable headers return false so the
 * normal decode path keeps full ownership of malformed input.
 */
function declaredSizeExceedsCap(data: Buffer, cap: number): boolean {
  const size = pngDeclaredSize(data) ?? jpegDeclaredSize(data)
  return size !== undefined && (size.width > cap || size.height > cap)
}

/**
 * Downscale an image whose long edge exceeds `maxSize`.
 * @param src - absolute path of the downloaded image.
 * @param maxSize - long-edge cap in px (`<=0` disables shrinking).
 * @returns the path of the shrunken file (never overwrites `src`), or
 *   `undefined` when the image was already small enough, is an animated
 *   GIF, declares a dimension beyond the decode-bomb hard cap, or its
 *   decoding/processing failed (caller keeps the original).
 */
export async function shrinkImage(src: string, maxSize: number): Promise<string | undefined> {
  if (maxSize <= 0) return undefined
  let data: Buffer
  try {
    data = await readFile(src)
  } catch {
    return undefined
  }
  if (isGif(data)) return undefined
  // Decode-bomb pre-check: abort before any decoder allocation when the
  // header declares a dimension beyond the hard cap. Returning undefined
  // keeps the original file, matching the decode-failure semantics below.
  if (declaredSizeExceedsCap(data, MAX_DECODE_EDGE)) return undefined
  let img: Image
  try {
    img = await loadImage(data)
  } catch {
    return undefined
  }
  if (Math.max(img.width, img.height) <= maxSize) return undefined
  const scale = maxSize / Math.max(img.width, img.height)
  const outW = Math.max(1, Math.round(img.width * scale))
  const outH = Math.max(1, Math.round(img.height * scale))

  const canvas = createCanvas(outW, outH)
  const ctx: SKRSContext2D = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  // Black backdrop: JPEG cannot carry alpha; matches the PIL convert("RGB")
  // behaviour of the original (decision: transparent pixels pad black).
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, outW, outH)
  ctx.drawImage(img, 0, 0, outW, outH)

  // Transparent-capable source extension → PNG, otherwise JPEG. The addon's
  // Image exposes no alpha flag, so the extension is the alpha signal
  // (QQ photos are overwhelmingly JPEG; PNGs keep their transparency).
  const png = /\.png$/i.test(src)
  const out = src.replace(/\.[^.]+$/, '') + '-c' + maxSize + (png ? '.png' : '.jpg')
  try {
    await writeFile(out, png ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', JPEG_QUALITY))
    return out
  } catch {
    return undefined
  }
}
