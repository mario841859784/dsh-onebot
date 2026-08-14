/**
 * Media handling: inbound download/resolution (url / base64:// / file:// /
 * hash via get_image), 6h temp-file cleanup, and outbound base64 encoding.
 * Ported from the Hermes OneBotAdapter media half.
 * @module dsh-onebot/media
 */

import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Size limits (bytes), matching the Hermes adapter's constants. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const VOICE_MAX_BYTES = 15 * 1024 * 1024
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024

/** One resolved media file. */
export interface ResolvedMedia {
  /** Absolute local path. */
  path: string
  /** Mime-ish kind for the caller. */
  kind: 'image' | 'voice' | 'video' | 'file'
}

/**
 * Media storage: a scratch directory under the plugin's media root.
 * Downloads land here with a TTL; cleanup runs on each inbound message.
 */
export class MediaStore {
  readonly dir: string
  private readonly ttlHours: number

  /**
   * @param dir - absolute scratch directory (created on demand).
   * @param ttlHours - files older than this are deleted on cleanup.
   */
  constructor(dir: string, ttlHours: number) {
    this.dir = dir
    this.ttlHours = ttlHours > 0 ? ttlHours : 6
  }

  /** Ensure the scratch directory exists. */
  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  /** A fresh scratch file path with the given extension. */
  freshPath(ext: string): string {
    return join(this.dir, 'media_' + Date.now() + '_' + randomUUID().slice(0, 8) + ext)
  }

  /**
   * Delete scratch files older than the TTL. Called on every inbound message;
   * failures are logged and contained.
   */
  async cleanupExpired(): Promise<void> {
    const cutoff = Date.now() - this.ttlHours * 3600_000
    try {
      await mkdir(this.dir, { recursive: true })
      const entries = await readdir(this.dir)
      for (const name of entries) {
        const path = join(this.dir, name)
        try {
          const info = await stat(path)
          if (info.isFile() && info.mtimeMs < cutoff) {
            await rm(path, { force: true })
          }
        } catch {
          // file vanished mid-scan
        }
      }
    } catch (error) {
      console.warn('[dsh-onebot] media cleanup failed:', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Resolve one media reference (from cq.ts MediaRef) to a local file.
   * @param ref - the media reference.
   * @param resolveHash - callback for hash-only refs (calls get_image etc.);
   *   returns { url, file } or undefined when unresolvable.
   * @returns the resolved file, or undefined when the ref cannot be fetched.
   */
  async resolve(ref: {
    kind: 'image' | 'voice' | 'video' | 'file'
    url?: string
    file?: string
  }, resolveHash: (kind: 'image' | 'voice' | 'video' | 'file', file: string) => Promise<{ url?: string; file?: string } | undefined>): Promise<ResolvedMedia | undefined> {
    await this.ensure()
    try {
      if (ref.url !== undefined && ref.url !== '') {
        const path = await this.downloadUrl(ref.url, extForUrl(ref.url, ref.kind))
        return { path, kind: ref.kind }
      }
      const file = ref.file ?? ''
      if (file.startsWith('base64://')) {
        const path = this.freshPath(extForKind(ref.kind))
        await writeFile(path, Buffer.from(file.slice('base64://'.length), 'base64'))
        return { path, kind: ref.kind }
      }
      if (file.startsWith('file://')) {
        const source = file.slice('file://'.length)
        const path = this.freshPath(extForKind(ref.kind))
        try {
          await copyFile(source, path)
          return { path, kind: ref.kind }
        } catch {
          return undefined
        }
      }
      if (file !== '') {
        // Hash-only ref: ask the implementation (get_image / get_record).
        const resolved = await resolveHash(ref.kind, file)
        if (resolved === undefined) return undefined
        if (resolved.url !== undefined && resolved.url !== '') {
          const path = await this.downloadUrl(resolved.url, extForUrl(resolved.url, ref.kind))
          return { path, kind: ref.kind }
        }
        if (resolved.file !== undefined && resolved.file.startsWith('file://')) {
          const source = resolved.file.slice('file://'.length)
          const path = this.freshPath(extForKind(ref.kind))
          await copyFile(source, path)
          return { path, kind: ref.kind }
        }
      }
      return undefined
    } catch (error) {
      console.warn('[dsh-onebot] media resolve failed:', error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  /**
   * Download a URL into the scratch dir.
   * @param url - remote URL.
   * @param ext - file extension for the target.
   * @param maxBytes - optional size cap (download aborted beyond it).
   * @returns the local path.
   */
  async downloadUrl(url: string, ext: string, maxBytes?: number): Promise<string> {
    await this.ensure()
    const response = await fetch(url)
    if (!response.ok || response.body === null) {
      throw new Error('download failed: HTTP ' + response.status + ' for ' + url)
    }
    const path = this.freshPath(ext)
    const stream = response.body
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) {
        total += value.byteLength
        if (maxBytes !== undefined && total > maxBytes) {
          reader.cancel().catch(() => undefined)
          throw new Error('download exceeds ' + maxBytes + ' bytes: ' + url)
        }
        chunks.push(value)
      }
    }
    await writeFile(path, Buffer.concat(chunks))
    return path
  }
}

/** Guess a file extension for a URL. */
export function extForUrl(url: string, kind: 'image' | 'voice' | 'video' | 'file'): string {
  try {
    const path = new URL(url).pathname
    const dot = path.lastIndexOf('.')
    if (dot >= 0) {
      const ext = path.slice(dot).toLowerCase()
      if (ext.length <= 6 && /^\.[a-z0-9]+$/.test(ext)) return ext
    }
  } catch {
    // malformed URL
  }
  return extForKind(kind)
}

/** Default extension per media kind. */
export function extForKind(kind: 'image' | 'voice' | 'video' | 'file'): string {
  switch (kind) {
    case 'image': return '.jpg'
    case 'voice': return '.mp3'
    case 'video': return '.mp4'
    default: return '.bin'
  }
}

/**
 * Read a local file as a base64 data URI for OneBot media segments.
 * @param path - absolute file path.
 * @param maxBytes - size cap; exceeding it throws.
 * @returns "base64://<data>".
 */
export async function fileToBase64(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path)
  if (info.size > maxBytes) {
    throw new Error('file too large: ' + info.size + ' bytes (limit ' + maxBytes + ')')
  }
  const data = await readFile(path)
  return 'base64://' + data.toString('base64')
}

/** Whether a string looks like a remote URL. */
export function isUrl(value: string): boolean {
  return /^https?:\/\//.test(value)
}
