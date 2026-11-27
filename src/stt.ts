/**
 * Voice transcription: SILK v3 (magic-number detected) or ffmpeg → WAV, then
 * a whisper engine (openai-whisper CLI, whisper.cpp whisper-cli, or a custom
 * command) produces the transcript. All subprocess work is queued, bounded by
 * a timeout, and
 * contained: a transcription failure must never break the message pipeline
 * (the caller falls back to the [语音] placeholder).
 * @module dsh-onebot/stt
 */

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** STT configuration (subset of the plugin Config). */
export interface SttConfig {
  enabled: boolean
  engine: 'auto' | 'openai' | 'whisper-cpp' | 'custom' | 'dsh'
  /** Program path/name for the custom engine. */
  command: string
  /** argv template for the custom engine; {file} and {out} are substituted. */
  args: string[]
  /** whisper model id (openai: small/base/medium...; whisper.cpp: ggml name). */
  model: string
  /** Per-transcription timeout in ms. */
  timeoutMs: number
  /**
   * DSH 原生引擎专用：按名容错读取宿主 `speechToText` 服务（实验性语音转写
   * 插件提供）。每次调用实时读取，服务未启用/未注册时返回 undefined——
   * 不加入 cordis inject 列表（inject 是硬依赖，该服务是可选实验服务）。
   */
  getSpeechToText?: () => SpeechToTextLike | undefined
}

/**
 * 宿主实验性语音转写服务（cordis 服务名 `speechToText`）的最小结构类型：
 * 只声明本插件用到的成员，字段/返回值用最小结构类型描述，刻意 **不 import
 * 宿主包**（`@deepseek-ai/dsh-experimental-speech-to-text`），避免把可选
 * 实验服务变成编译期硬依赖。
 */
export interface SpeechToTextLike {
  resolve(request: { readonly audio: Uint8Array; readonly providerId?: string; readonly language?: string }): unknown
  transcribe(spec: unknown, signal: AbortSignal): Promise<{ readonly text: string }>
  listProviders(): readonly unknown[]
  snapshot(): {
    readonly providers: readonly { readonly id: string; readonly preparation?: { readonly phase: string } }[]
    readonly selection: { readonly providerId: string; readonly language: string }
  }
  prepare(providerId?: string): unknown
}

const DEFAULT_TIMEOUT_MS = 60_000

/** SILK v3 文件的魔数（QQ 语音落地常见形态）。 */
const SILK_HEADER = '#!SILK_V3'
/**
 * 引擎输入的采样率：统一 16 kHz 单声道，与 ffmpeg 管线的 `-ar 16000` 对齐。
 * SILK 文件头里不带采样率，`silk-wasm` 的 `decode(bytes, rate)` 第二参是
 * **输出**采样率、会原生重采样；而 whisper.cpp 的 read_wav() 硬校验 16 kHz
 * （`sampleRate != 16000` 直接失败），所以这里不能沿用 24 kHz。
 */
const STT_SAMPLE_RATE = 16_000

/**
 * 判断文件头是不是 SILK v3。
 *
 * QQ 语音落地时扩展名常被写成 `.mp3`，内容其实是协议端 `get_record`
 * 兜底返回的原始 SILK——ffmpeg 按 mp3 解必然失败（表现为一直只有
 * `[语音]`）。协议端有的会把帧类型字节一起落盘，所以头部允许
 * 0x02 / 0x03 前缀。
 * @param head - 文件前若干字节（>= 10 字节即可）。
 */
export function isSilkData(head: Uint8Array): boolean {
  const offset = head[0] === 0x02 || head[0] === 0x03 ? 1 : 0
  if (head.length < offset + SILK_HEADER.length) return false
  return Buffer.from(head.subarray(offset, offset + SILK_HEADER.length)).toString('latin1') === SILK_HEADER
}

/** 把 16-bit 单声道 PCM 包成最小 WAV（44 字节头），引擎侧都认这个。 */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)                 // fmt chunk size
  header.writeUInt16LE(1, 20)                  // PCM
  header.writeUInt16LE(1, 22)                  // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)     // byte rate
  header.writeUInt16LE(2, 32)                  // block align
  header.writeUInt16LE(16, 34)                 // bits per sample
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, Buffer.from(pcm)])
}

/**
 * SILK → 16 kHz 单声道 WAV 之外的「引擎输入」准备。
 *
 * 命中 SILK 魔数时用 `silk-wasm`（纯 wasm，无 native 依赖）解码成 PCM，
 * 再包成 WAV 交给引擎；解码失败就返回 false，让调用方回落到原来的
 * ffmpeg 路径——宁可多试一次，也不要因为解码器不认识某种 SILK 变体
 * 就把整条语音丢掉。
 * @returns true 表示 `outPath` 已写好可用的 WAV。
 */
export async function writeSilkWav(bytes: Uint8Array, outPath: string): Promise<boolean> {
  try {
    const { decode } = await import('silk-wasm')
    const pcm = await decode(bytes, STT_SAMPLE_RATE)
    if (pcm.data.length === 0) return false
    await writeFile(outPath, pcm16ToWav(pcm.data, STT_SAMPLE_RATE))
    return true
  } catch {
    return false
  }
}

/** Run a process, collecting output; rejects on non-zero exit or timeout. */
function runProcess(
  program: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('STT command timed out after ' + timeoutMs + 'ms: ' + program))
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error('STT command exited with code ' + code + ': ' + program + '\n' + stderr.slice(-2000)))
    })
  })
}

/**
 * Detect a command on PATH by scanning each dir for an executable match
 * (A8: no shell involved, so the configured name is never shell-interpreted;
 * builtins/aliases stop being visible — callers only need real binaries).
 */
export async function findCommand(name: string): Promise<string | undefined> {
  const win = process.platform === 'win32'
  // Windows: look for what runProcess's shell-less spawn can start, the way libuv
  // resolves a name — the name as given only if it already has an extension, then
  // with .com and .exe appended. PATHEXT is not used: .bat/.cmd need a shell (spawn
  // throws EINVAL since Node 18.20.2/20.12.2/21.7.3, CVE-2024-27980), and the
  // extensionless file npm puts beside a .cmd shim is a sh script.
  const exts = win ? [...(extname(name) !== '' ? [''] : []), '.com', '.exe'] : ['']
  for (const dir of (process.env.PATH ?? '').split(win ? ';' : ':')) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // missing or not executable — try the next candidate
      }
    }
  }
  return undefined
}

/** Locate a whisper.cpp model file for the given model id. */
async function findWhisperCppModel(model: string): Promise<string | undefined> {
  if (model.includes('/') || model.endsWith('.bin')) {
    try {
      await access(model)
      return model
    } catch {
      return undefined
    }
  }
  const name = 'ggml-' + model + '.bin'
  const candidates = [
    '/opt/homebrew/share/whisper.cpp/models/' + name,
    '/usr/local/share/whisper.cpp/models/' + name,
    join(process.env.HOME ?? '', '.cache/whisper.cpp/' + name),
    join(process.env.HOME ?? '', 'whisper.cpp/models/' + name),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // try next
    }
  }
  return undefined
}

/**
 * Voice transcription service. One instance per plugin; calls are serialized
 * through a queue so concurrent voice messages cannot stack CPU-bound
 * whisper processes.
 */
export class Transcriber {
  private readonly config: SttConfig
  private queue: Promise<unknown> = Promise.resolve()
  private ffmpegChecked: string | undefined

  constructor(config: SttConfig) {
    this.config = config
  }

  /** Whether transcription is enabled by config. */
  get enabled(): boolean {
    return this.config.enabled
  }

  /**
   * Transcribe a voice file. SILK v3 input is decoded to PCM/WAV directly;
   * everything else is converted to 16 kHz mono WAV with ffmpeg; the WAV is
   * then handed to the selected engine.
   * @param filePath - absolute path of the downloaded voice file.
   * @returns the transcript text (trimmed), or '' when the file is silent.
   * @throws when transcription is impossible (missing tools, timeout...).
   */
  transcribe(filePath: string): Promise<string> {
    const run = this.queue.then(() => this.transcribeNow(filePath))
    // Keep the chain alive regardless of individual failures.
    this.queue = run.catch(() => undefined)
    return run
  }

  private async transcribeNow(filePath: string): Promise<string> {
    const workDir = join(dirname(filePath), 'stt_' + randomUUID().slice(0, 8))
    await mkdir(workDir, { recursive: true })
    try {
      const wavPath = join(workDir, 'audio.wav')

      // QQ 语音落地常是 SILK v3（扩展名却是 .mp3）：先看魔数，命中就直接
      // 解码成 WAV，不再让 ffmpeg 按 mp3 去猜（那样必然 Invalid data）。
      const raw = await readFile(filePath)
      const ready = isSilkData(raw.subarray(0, 16)) ? await writeSilkWav(raw, wavPath) : false

      if (!ready) {
        const ffmpeg = this.ffmpegChecked ?? (await findCommand('ffmpeg'))
        this.ffmpegChecked = ffmpeg
        if (ffmpeg === undefined) {
          throw new Error('STT: ffmpeg not found on PATH (needed to convert QQ voice to WAV)')
        }
        await runProcess(ffmpeg, ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath], 60_000)
      }

      const engine = await this.resolveEngine()
      const text = await this.runEngine(engine, wavPath, workDir)
      return text.trim()
    } finally {
      // The work dir holds only intermediates (audio.wav, engine output):
      // remove it on both success and failure. Best-effort — a failed cleanup
      // must never lose the transcript (stale dirs are swept later by
      // MediaStore.cleanupExpired as a fallback).
      try {
        await rm(workDir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  }

  private async resolveEngine(): Promise<'openai' | 'whisper-cpp' | 'custom' | 'dsh'> {
    if (this.config.engine === 'custom') return 'custom'
    // dsh 是宿主内服务，不依赖任何本机二进制，无需探测。
    if (this.config.engine === 'dsh') return 'dsh'
    if (this.config.engine !== 'auto') return this.config.engine
    if ((await findCommand('whisper-cli')) !== undefined) return 'whisper-cpp'
    if ((await findCommand('whisper')) !== undefined) return 'openai'
    if ((await findCommand('mlx_whisper')) !== undefined) return 'openai'
    throw new Error('STT: no whisper engine found (tried whisper-cli, whisper, mlx_whisper); install one or set stt.command')
  }

  private async runEngine(engine: 'openai' | 'whisper-cpp' | 'custom' | 'dsh', wavPath: string, workDir: string): Promise<string> {
    const timeout = this.config.timeoutMs > 0 ? this.config.timeoutMs : DEFAULT_TIMEOUT_MS
    if (engine === 'dsh') {
      // DSH 原生转写：把管线产出的 16 kHz 单声道 PCM16 WAV 直接交给宿主
      // speechToText 服务（复用宿主按需启动/空闲回收的 SenseVoice provider），
      // 不再拉起外挂转写进程。providerId/language 省略，沿用宿主
      // defaultProvider/language 配置，不绑死模型。
      const audio = await readFile(wavPath)
      const svc = this.config.getSpeechToText?.()
      if (svc === undefined) {
        throw new Error('STT: DSH 语音转写服务不可用（需启用宿主实验性语音转写插件）')
      }
      if (svc.listProviders().length === 0) {
        throw new Error('STT: DSH 语音转写服务没有可用 provider（需在宿主启用实验性语音转写 provider）')
      }
      // SenseVoice provider 的 transcribe() 在准备阶段非 ready/standby 时直接
      // 抛错且不会自动下载模型：查 snapshot，未就绪就 best-effort 触发
      // prepare()（不等待，宿主后台继续准备，后续消息即可成功），本条按
      // 现有失败路径抛错降级为 [语音]。
      const snap = svc.snapshot()
      const selected = snap.providers.find(p => p.id === snap.selection.providerId)
      const phase = selected?.preparation?.phase
      if (phase !== undefined && phase !== 'ready' && phase !== 'standby') {
        if (phase === 'unprepared' || phase === 'failed' || phase === 'cancelled') {
          try {
            svc.prepare(snap.selection.providerId)
          } catch {
            // best effort — 宿主侧准备失败由宿主上报
          }
        }
        throw new Error('STT: DSH 语音 provider 尚未准备就绪（phase=' + phase + '，首次需下载模型）；宿主已在后台准备，后续消息可正常转写')
      }
      const spec = svc.resolve({ audio })
      const transcript = await svc.transcribe(spec, AbortSignal.timeout(timeout))
      return transcript.text
    }
    if (engine === 'custom') {
      const program = this.config.command !== '' ? this.config.command : 'whisper'
      const args = this.config.args.map(arg => arg.replaceAll('{file}', wavPath).replaceAll('{out}', join(workDir, 'out')))
      await runProcess(program, args, timeout)
      return readFirstTxt(workDir)
    }
    if (engine === 'openai') {
      const program = (await findCommand('whisper')) ?? (await findCommand('mlx_whisper'))
      if (program === undefined) throw new Error('STT: whisper CLI not found')
      const args = program.endsWith('mlx_whisper')
        ? [wavPath, '--model', this.config.model, '--output-format', 'txt', '--output-dir', workDir, '--verbose', 'False']
        : [wavPath, '--model', this.config.model, '--output_format', 'txt', '--output_dir', workDir, '--verbose', 'False']
      await runProcess(program, args, timeout)
      return readFirstTxt(workDir)
    }
    // whisper.cpp
    const program = await findCommand('whisper-cli')
    if (program === undefined) throw new Error('STT: whisper-cli not found')
    const model = await findWhisperCppModel(this.config.model)
    if (model === undefined) {
      throw new Error('STT: whisper.cpp model not found for "' + this.config.model + '" (set stt.model to an absolute .bin path)')
    }
    const outBase = join(workDir, 'out')
    await runProcess(program, ['-m', model, '-f', wavPath, '-otxt', '-of', outBase], timeout)
    return readFirstTxt(workDir)
  }
}

/** Read the first .txt transcript produced in a work dir. */
async function readFirstTxt(dir: string): Promise<string> {
  const entries = await readdir(dir)
  const txt = entries.find(name => name.endsWith('.txt'))
  if (txt === undefined) return ''
  const content = await readFile(join(dir, txt), 'utf8')
  return content.trim()
}

/** Convenience: transcription result for the bridge. */
export function transcriptLabel(text: string): string {
  return text !== '' ? '（语音转写：' + text + '）' : ''
}
