import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { shrinkImage } from '../src/image-shrink.js'

/** Render a solid-color JPEG/PNG of the given size (procedural fixture). */
function renderImage(w: number, h: number, format: 'jpeg' | 'png', color = '#4a90d9'): Buffer {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, w, h)
  return canvas.toBuffer(format === 'png' ? 'image/png' : 'image/jpeg', 90)
}

/**
 * Prepend a minimal APP1/Exif segment (Orientation tag only) to a JPEG,
 * so the decoder reports the given EXIF orientation.
 */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('II', 0, 'latin1') // little-endian
  tiff.writeUInt16LE(0x002A, 2) // TIFF magic
  tiff.writeUInt32LE(8, 4) // IFD0 offset
  tiff.writeUInt16LE(1, 8) // entry count
  tiff.writeUInt16LE(0x0112, 10) // tag: Orientation
  tiff.writeUInt16LE(3, 12) // type: SHORT
  tiff.writeUInt32LE(1, 14) // count
  tiff.writeUInt16LE(orientation, 18) // value
  tiff.writeUInt32LE(0, 22) // next IFD
  const app1 = Buffer.concat([
    Buffer.from([0xFF, 0xE1, 0x00, 2 + 6 + tiff.length]),
    Buffer.from('Exif\0\0', 'latin1'),
    tiff,
  ])
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)])
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-onebot-shrink-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeFixture(name: string, data: Buffer): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, data)
  return path
}

describe('shrinkImage', () => {
  it('downscales a 4000×3000 JPEG to a ≤2048 long edge', async () => {
    const src = await writeFixture('big.jpg', renderImage(4000, 3000, 'jpeg'))
    const out = await shrinkImage(src, 2048)
    expect(out).toBeDefined()
    expect(out).not.toBe(src)
    const img = await loadImage(out as string)
    expect(img.width).toBe(2048)
    expect(img.height).toBe(1536)
  })

  it('keeps images already within the cap', async () => {
    const src = await writeFixture('small.jpg', renderImage(1000, 800, 'jpeg'))
    const out = await shrinkImage(src, 2048)
    expect(out).toBeUndefined()
  })

  it('disables shrinking when maxSize <= 0', async () => {
    const src = await writeFixture('big0.jpg', renderImage(4000, 3000, 'jpeg'))
    expect(await shrinkImage(src, 0)).toBeUndefined()
    expect(await shrinkImage(src, -1)).toBeUndefined()
  })

  it('keeps PNG output for a transparent (PNG) source', async () => {
    const src = await writeFixture('alpha.png', renderImage(4000, 3000, 'png'))
    const out = await shrinkImage(src, 2048)
    expect(out).toBeDefined()
    expect((out as string).toLowerCase().endsWith('.png')).toBe(true)
  })

  it('emits JPEG output for an opaque JPEG source', async () => {
    const src = await writeFixture('opaque.jpg', renderImage(4000, 3000, 'jpeg'))
    const out = await shrinkImage(src, 2048)
    expect(out).toBeDefined()
    expect((out as string).toLowerCase().endsWith('.jpg')).toBe(true)
  })

  it('applies EXIF Orientation 6 (90° CW) before scaling', async () => {
    const exif = withExifOrientation(renderImage(3000, 2000, 'jpeg'), 6)
    const src = await writeFixture('portrait.jpg', exif)
    const out = await shrinkImage(src, 2048)
    expect(out).toBeDefined()
    const img = await loadImage(out as string)
    // Rotated display size 2000×3000 → scaled to 1365×2048 (taller than wide).
    expect(img.width).toBe(1365)
    expect(img.height).toBe(2048)
  })

  it('keeps animated GIFs untouched', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 7)])
    const src = await writeFixture('anim.gif', gif)
    const out = await shrinkImage(src, 2048)
    expect(out).toBeUndefined()
  })

  it('falls back to the original on corrupt input without throwing', async () => {
    const src = await writeFixture('corrupt.jpg', Buffer.from('definitely not an image'))
    const out = await shrinkImage(src, 2048)
    expect(out).toBeUndefined()
  })

  it('does not overwrite the source file', async () => {
    const src = await writeFixture('keep.jpg', renderImage(4000, 3000, 'jpeg'))
    const before = (await import('node:fs/promises')).readFile(src)
    const out = await shrinkImage(src, 2048)
    expect(out).toBeDefined()
    const after = await (await import('node:fs/promises')).readFile(src)
    expect(after.equals(await before)).toBe(true)
  })
})
