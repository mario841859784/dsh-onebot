/**
 * Voice transcription: ffmpeg → 16 kHz mono WAV, then a whisper engine
 * (openai-whisper CLI, whisper.cpp whisper-cli, or a custom command) produces
 * the transcript. All subprocess work is queued, bounded by a timeout, and
 * contained: a transcription failure must never break the message pipeline
 * (the caller falls back to the [语音] placeholder).
 * @module dsh-onebot/stt
 */

import { spawn } from 'node:child_process'
import { access, mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** STT configuration (subset of the plugin Config). */
export interface SttConfig {
  enabled: boolean
  engine: 'auto' | 'openai' | 'whisper-cpp' | 'custom'
  /** Program path/name for the custom engine. */
  command: string
  /** argv template for the custom engine; {file} and {out} are substituted. */
  args: string[]
  /** whisper model id (openai: small/base/medium...; whisper.cpp: ggml name). */
  model: string
  /** Per-transcription timeout in ms. */
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 300_000

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

/** Detect a command on PATH. */
function findCommand(name: string): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', 'command -v ' + name], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => {
      out += String(chunk)
    })
    child.on('error', () => resolve(undefined))
    child.on('close', code => {
      resolve(code === 0 && out.trim() !== '' ? out.trim().split('\n')[0] : undefined)
    })
  })
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
   * Transcribe a voice file. The input is converted to 16 kHz mono WAV with
   * ffmpeg, then handed to the selected engine.
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
    const wavPath = join(workDir, 'audio.wav')

    const ffmpeg = this.ffmpegChecked ?? (await findCommand('ffmpeg'))
    this.ffmpegChecked = ffmpeg
    if (ffmpeg === undefined) {
      throw new Error('STT: ffmpeg not found on PATH (needed to convert QQ voice to WAV)')
    }
    await runProcess(ffmpeg, ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath], 60_000)

    const engine = await this.resolveEngine()
    const text = await this.runEngine(engine, wavPath, workDir)
    return text.trim()
  }

  private async resolveEngine(): Promise<'openai' | 'whisper-cpp' | 'custom'> {
    if (this.config.engine === 'custom') return 'custom'
    if (this.config.engine !== 'auto') return this.config.engine
    if ((await findCommand('whisper-cli')) !== undefined) return 'whisper-cpp'
    if ((await findCommand('whisper')) !== undefined) return 'openai'
    if ((await findCommand('mlx_whisper')) !== undefined) return 'openai'
    throw new Error('STT: no whisper engine found (tried whisper-cli, whisper, mlx_whisper); install one or set stt.command')
  }

  private async runEngine(engine: 'openai' | 'whisper-cpp' | 'custom', wavPath: string, workDir: string): Promise<string> {
    const timeout = this.config.timeoutMs > 0 ? this.config.timeoutMs : DEFAULT_TIMEOUT_MS
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
