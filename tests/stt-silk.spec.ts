/**
 * #24: QQ 语音落地文件常是 SILK v3（扩展名却是 .mp3），ffmpeg 按 mp3 解
 * 必然失败。这里钉住三件事：魔数判断（含 0x02/0x03 前缀）、SILK 解码后
 * 写出的 WAV 合法、以及解码失败时回落到 ffmpeg 而不是直接抛错。
 *
 * fixture 用 `silk-wasm` 自己的 encode() 现场生成，不依赖真实 QQ 语音。
 * @module dsh-onebot/tests/stt-silk
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encode } from 'silk-wasm'

import { isSilkData, pcm16ToWav, Transcriber, writeSilkWav } from '../src/stt.js'

const SILK_HEADER = '#!SILK_V3'

/** 24 kHz 单声道正弦波 → SILK v3（内容合法，可被 decode 回放）。 */
async function makeSilk(): Promise<Uint8Array> {
  const frames = 4800 // 0.2s
  const pcm = new Int16Array(frames)
  for (let i = 0; i < frames; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000))
  const silk = await encode(new Uint8Array(pcm.buffer), 24000)
  return silk.data
}

describe('isSilkData (#24 魔数判断)', () => {
  it('recognizes the plain header', () => {
    const head = Buffer.concat([Buffer.from(SILK_HEADER, 'latin1'), Buffer.alloc(8)])
    expect(isSilkData(head)).toBe(true)
  })

  it('tolerates the 0x02 / 0x03 frame-type prefix written by some endpoints', () => {
    const body = Buffer.concat([Buffer.from(SILK_HEADER, 'latin1'), Buffer.alloc(8)])
    expect(isSilkData(Buffer.concat([Buffer.from([0x02]), body]))).toBe(true)
    expect(isSilkData(Buffer.concat([Buffer.from([0x03]), body]))).toBe(true)
  })

  it('rejects mp3 / wav headers and short buffers', () => {
    expect(isSilkData(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1'))).toBe(false)
    expect(isSilkData(Buffer.from('RIFF....WAVEfmt ', 'latin1'))).toBe(false)
    expect(isSilkData(Buffer.from('#!SIL', 'latin1'))).toBe(false)
    expect(isSilkData(Buffer.alloc(0))).toBe(false)
  })
})

describe('pcm16ToWav', () => {
  it('writes a minimal 44-byte PCM header with the right sizes', () => {
    const pcm = new Uint8Array(2000) // 1000 samples
    const wav = pcm16ToWav(pcm, 16_000)
    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length)
    expect(wav.subarray(8, 12).toString('latin1')).toBe('WAVE')
    expect(wav.readUInt16LE(22)).toBe(1)          // mono
    expect(wav.readUInt32LE(24)).toBe(16_000)      // sample rate
    expect(wav.readUInt32LE(28)).toBe(32_000)      // byte rate
    expect(wav.readUInt16LE(34)).toBe(16)         // bits
    expect(wav.subarray(36, 40).toString('latin1')).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(pcm.length)
  })
})

describe('writeSilkWav (#24 解码路径)', () => {
  it('decodes a real SILK fixture into a playable WAV', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-silk-'))
    const out = join(dir, 'audio.wav')
    const ok = await writeSilkWav(await makeSilk(), out)
    expect(ok).toBe(true)
    const wav = await readFile(out)
    expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF')
    // whisper.cpp 只吃 16 kHz：解码输出必须是 16k，而不是源文件的 24k
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.length).toBeGreaterThan(44)
  })

  it('returns false (falls back to ffmpeg) when the payload is not decodable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-silk-bad-'))
    const out = join(dir, 'audio.wav')
    // 头对但内容是垃圾：decode 抛错 → 必须返回 false 而不是把异常抛给调用方
    const fake = Buffer.concat([Buffer.from([0x02]), Buffer.from(SILK_HEADER, 'latin1'), Buffer.from('garbage')])
    await expect(writeSilkWav(fake, out)).resolves.toBe(false)
  })
})

describe('Transcriber 命中 SILK 时不调用 ffmpeg', () => {
  it('transcribes a SILK file with ffmpeg absent from PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-silk-end-'))
    const voice = join(dir, 'voice.mp3') // 扩展名是 .mp3，内容是 SILK —— 正是 #24 的现场
    await writeFile(voice, await makeSilk())
    // PATH 指向空目录：任何 ffmpeg 探测都会失败
    vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'stt-silk-nobin-')))

    const transcriber = new Transcriber({
      enabled: true,
      engine: 'custom',
      command: process.execPath,
      // custom 引擎按约定把转录写进 <out>.txt（runEngine 读 workDir 里的 .txt）
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "silk ok")', '{out}.txt'],
      model: 'small',
      timeoutMs: 30_000,
    })

    await expect(transcriber.transcribe(voice)).resolves.toBe('silk ok')
  })
})

afterEach(() => {
  // 端到端用例会临时改 PATH；任何一条中途失败都不能让空 PATH 泄漏给同 worker
  vi.unstubAllEnvs()
})

describe('Transcriber 非 SILK 输入仍走 ffmpeg', () => {
  it('converts a plain mp3 through ffmpeg before handing it to the engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-mp3-'))
    const voice = join(dir, 'voice.mp3')
    // 真 mp3 头（ID3）+ 填充：不是 SILK，必须走转码路径
    await writeFile(voice, Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(64)]))

    const bin = mkdtempSync(join(tmpdir(), 'stt-mp3-bin-'))
    const marker = join(bin, 'ffmpeg-called')
    const fakeFfmpeg = join(bin, 'ffmpeg')
    // 假 ffmpeg：记一笔调用，然后把假定的 WAV 写到最后一个参数
    await writeFile(fakeFfmpeg, `#!/bin/sh\nfor a; do out=$a; done\nprintf called > ${JSON.stringify(marker)}\nprintf 'RIFF....WAVEfmt ' > \"$out\"\n`)
    await chmod(fakeFfmpeg, 0o755)
    vi.stubEnv('PATH', bin)

    const transcriber = new Transcriber({
      enabled: true,
      engine: 'custom',
      command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "mp3 ok")', '{out}.txt'],
      model: 'small',
      timeoutMs: 30_000,
    })

    await expect(transcriber.transcribe(voice)).resolves.toBe('mp3 ok')
    expect(existsSync(marker)).toBe(true)
  })
})
