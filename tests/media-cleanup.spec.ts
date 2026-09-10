/**
 * Media directory safety: cleanup whitelist (B3), STT work dir cleanup (B2),
 * and inbound file naming (A4). Self-contained on purpose — imports nothing
 * from @deepseek-ai/*, so it only exercises src/media.ts and src/stt.ts
 * (neither depends on host packages). The bridge's writeMediaFile is a thin
 * wiring over `MediaStore.freshPath(extForInboundName(name))`, which is what
 * the A4 cases assert directly.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { extForInboundName, MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

/** Spawn a command and wait for exit; rejects on spawn error or non-zero code. */
function runCommand(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(program + ' exited with code ' + code))))
  })
}

async function hasFfmpeg(): Promise<boolean> {
  try {
    await runCommand('ffmpeg', ['-version'])
    return true
  } catch {
    return false
  }
}

const ffmpegAvailable = await hasFfmpeg()

describe('MediaStore.cleanupExpired (B3 whitelist)', () => {
  it('deletes only expired media_* files and stt_* dirs, never state files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-cleanup-'))
    const store = new MediaStore(dir, 6)

    const expiredMedia = join(dir, 'media_1000_abcd1234.jpg')
    const freshMedia = join(dir, 'media_' + Date.now() + '_eeee0000.jpg')
    const mappingFile = join(dir, 'chat-sessions.json')
    const retiredFile = join(dir, 'retired-sessions.json')
    const mappingSentinel = Buffer.from('{"chat-sessions":"sentinel"}')
    const retiredSentinel = Buffer.from('[]')
    await writeFile(expiredMedia, 'stale')
    await writeFile(freshMedia, 'fresh')
    await writeFile(mappingFile, mappingSentinel)
    await writeFile(retiredFile, retiredSentinel)

    const expiredSttDir = join(dir, 'stt_abcd1234')
    await mkdir(join(expiredSttDir, 'nested'), { recursive: true })
    await writeFile(join(expiredSttDir, 'audio.wav'), 'wav')
    await writeFile(join(expiredSttDir, 'nested', 'out.txt'), 'txt')

    // Backdate past the 6h TTL — including the state files, reproducing the
    // original bug (idle bot > TTL → any inbound message wiped session state).
    const stale = new Date(Date.now() - 7 * 3600_000)
    await utimes(expiredMedia, stale, stale)
    await utimes(expiredSttDir, stale, stale)
    await utimes(mappingFile, stale, stale)
    await utimes(retiredFile, stale, stale)

    await store.cleanupExpired()

    expect((await readdir(dir)).sort()).toEqual(
      ['chat-sessions.json', basename(freshMedia), 'retired-sessions.json'].sort(),
    )
    await expect(readFile(freshMedia)).resolves.toEqual(Buffer.from('fresh'))
    await expect(readFile(mappingFile)).resolves.toEqual(mappingSentinel)
    await expect(readFile(retiredFile)).resolves.toEqual(retiredSentinel)
  })
})

describe('Transcriber work dir cleanup (B2)', () => {
  it('removes the stt_* work dir when transcription fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-fail-'))
    const transcriber = new Transcriber({ enabled: true, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 })
    // The input does not exist, so transcription always throws — at the
    // ffmpeg probe or (when ffmpeg exists) at the conversion step — always
    // after the work dir was created. The finally block must remove it.
    await expect(transcriber.transcribe(join(dir, 'missing-voice.mp3'))).rejects.toThrow()
    expect((await readdir(dir)).filter(name => name.startsWith('stt_'))).toEqual([])
  })

  // Success path needs a real ffmpeg to synthesize the input audio; skipped
  // with runIf when ffmpeg is not on PATH.
  it.runIf(ffmpegAvailable)('removes the stt_* work dir after a successful transcription', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-ok-'))
    const input = join(dir, 'voice.wav')
    // Synthesize a short tone so no sample file is needed; the custom engine
    // is a fake shell command that writes the transcript into the work dir.
    await runCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', input])
    const transcriber = new Transcriber({
      enabled: true, engine: 'custom', command: 'sh',
      args: ['-c', 'printf fake-transcript > {out}.txt'],
      model: '', timeoutMs: 30_000,
    })
    await expect(transcriber.transcribe(input)).resolves.toBe('fake-transcript')
    expect((await readdir(dir)).filter(name => name.startsWith('stt_'))).toEqual([])
  })
})

describe('Inbound file naming (A4)', () => {
  it('derives a whitelisted extension from the raw name', () => {
    expect(extForInboundName('chat-sessions.json')).toBe('.json')
    expect(extForInboundName('retired-sessions.json')).toBe('.json')
    expect(extForInboundName('photo.JPG')).toBe('.jpg')
    expect(extForInboundName('archive.tar.gz')).toBe('.gz')
    expect(extForInboundName('../../etc/passwd')).toBe('.bin')
    expect(extForInboundName('.hidden')).toBe('.bin')
    expect(extForInboundName('no-ext')).toBe('.bin')
    expect(extForInboundName('a.js/x')).toBe('.bin')
    expect(extForInboundName('')).toBe('.bin')
  })

  it('lands inbound files under fresh media_* names without touching state files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inbound-naming-'))
    const store = new MediaStore(dir, 6)
    const mappingSentinel = Buffer.from('{"chat-sessions":"sentinel"}')
    const retiredSentinel = Buffer.from('[]')
    await writeFile(join(dir, 'chat-sessions.json'), mappingSentinel)
    await writeFile(join(dir, 'retired-sessions.json'), retiredSentinel)

    for (const name of ['chat-sessions.json', 'retired-sessions.json', '../../etc/passwd', '.hidden', 'no-ext']) {
      const payload = Buffer.from('payload of ' + name)
      // Mirror of bridge.ts writeMediaFile: the sender-chosen name only
      // contributes a whitelisted extension; the on-disk name is always a
      // fresh unpredictable media_* path.
      const localPath = store.freshPath(extForInboundName(name))
      await writeFile(localPath, payload)
      const landed = basename(localPath)
      expect(landed).toMatch(/^media_\d+_[0-9a-f]{8}\.[a-z0-9]+$/)
      const stem = basename(name).replace(/\.[^.]*$/, '')
      if (stem !== '') expect(landed).not.toContain(stem)
      await expect(readFile(localPath)).resolves.toEqual(payload)
    }

    // The state files must be byte-for-byte intact after all landings.
    await expect(readFile(join(dir, 'chat-sessions.json'))).resolves.toEqual(mappingSentinel)
    await expect(readFile(join(dir, 'retired-sessions.json'))).resolves.toEqual(retiredSentinel)
  })
})
