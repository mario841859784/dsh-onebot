/**
 * #69: DSH 原生转写引擎——管线产出的 16 kHz 单声道 PCM16 WAV 直接交给宿主
 * speechToText 服务（伪服务对象覆盖），不拉起外挂转写进程。钉住六件事：
 * 传给 resolve 的 audio 是 canonical WAV、转写文本正常回填、空文本返回
 * ''（走 [语音] 降级路径）、服务缺失抛中文错误、provider 未就绪触发
 * prepare() 且本条抛错降级、AbortSignal.timeout 按配置超时传入。
 *
 * 输入用 `silk-wasm` 自己的 encode() 现场生成 SILK，走 writeSilkWav 路径
 * 直接产出 WAV，不依赖本机 ffmpeg（见 stt-silk.spec.ts 同款做法）。
 * @module dsh-onebot/tests/stt-dsh
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { encode } from 'silk-wasm'

import { pcm16ToWav, type SpeechToTextLike, type SttConfig, Transcriber } from '../src/stt.js'

/** 24 kHz 单声道正弦波 → SILK v3（内容合法，可被 decode 回放）。 */
async function makeSilk(): Promise<Uint8Array> {
  const frames = 4800 // 0.2s
  const pcm = new Int16Array(frames)
  for (let i = 0; i < frames; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000))
  const silk = await encode(new Uint8Array(pcm.buffer), 24000)
  return silk.data
}

interface FakeCalls {
  resolveAudio?: Uint8Array
  resolveLanguage?: string
  resolveProviderId?: string
  timeoutSignal?: AbortSignal
  prepareIds: string[]
}

/** 伪宿主 speechToText 服务：记录调用，按参数决定 transcript 与准备状态。 */
function makeFakeService(options: {
  transcript?: { text: string }
  phase?: string
  providerCount?: number
  failResolve?: boolean
} = {}): { service: SpeechToTextLike; calls: FakeCalls } {
  const calls: FakeCalls = { prepareIds: [] }
  const phase = options.phase ?? 'ready'
  const providers = Array.from({ length: options.providerCount ?? 1 }, () => ({
    id: 'sensevoice-local',
    name: 'SenseVoice',
    preparation: { phase },
  }))
  const service: SpeechToTextLike = {
    resolve(request) {
      calls.resolveAudio = request.audio
      calls.resolveLanguage = request.language
      calls.resolveProviderId = request.providerId
      if (options.failResolve) throw new Error('resolve should not be reached')
      return { provider: { transcribe: () => Promise.resolve(options.transcript ?? { text: '', audioSeconds: 0, inferenceSeconds: 0 }) } }
    },
    async transcribe(spec, signal) {
      calls.timeoutSignal = signal
      void spec
      return options.transcript ?? { text: '', audioSeconds: 0, inferenceSeconds: 0 }
    },
    listProviders() {
      return providers.slice(0, options.providerCount ?? 1)
    },
    snapshot() {
      return {
        providers,
        selection: { providerId: 'sensevoice-local', language: 'auto' },
      }
    },
    prepare(providerId) {
      calls.prepareIds.push(providerId ?? '')
      return undefined
    },
  }
  return { service, calls }
}

function makeTranscriber(config: Partial<SttConfig> = {}): Transcriber {
  return new Transcriber({
    enabled: true,
    engine: 'dsh',
    command: '',
    args: [],
    model: '',
    timeoutMs: 60_000,
    ...config,
  } satisfies SttConfig)
}

/** SILK 语音落地文件（扩展名 .mp3，内容是 SILK——真实 QQ 语音形态）。 */
async function writeVoiceFile(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'stt-dsh-'))
  const path = join(dir, 'voice.mp3')
  writeFileSync(path, await makeSilk())
  return path
}

describe('Transcriber engine=dsh (#69 宿主 speechToText 转写)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hands a canonical 16 kHz mono PCM16 WAV to resolve() and returns the transcript text', async () => {
    const { service, calls } = makeFakeService({ transcript: { text: ' 你好，世界 ', audioSeconds: 0.2, inferenceSeconds: 0.1 } })
    const text = await makeTranscriber({ getSpeechToText: () => service }).transcribe(await writeVoiceFile())
    expect(text).toBe('你好，世界')
    // providerId / language 省略：沿用宿主 defaultProvider/language 配置
    expect(calls.resolveProviderId).toBeUndefined()
    expect(calls.resolveLanguage).toBeUndefined()
    // canonical WAV 头逐字段校验（SenseVoice validateWave 契约）
    const wav = Buffer.from(calls.resolveAudio!)
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF')
    expect(wav.toString('latin1', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(16)).toBe(16) // fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16_000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(32_000) // byte rate
    expect(wav.readUInt16LE(32)).toBe(2) // block align
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.toString('latin1', 36, 40)).toBe('data')
    // 整段字节与 pcm16ToWav 的确定性产物一致（同一段 SILK 解码 → 同一 PCM）
    expect(wav).toEqual(pcm16ToWav(wav.subarray(44), 16_000))
    expect(wav.length % 2).toBe(0)
  })

  it('returns "" when the transcript text is empty (caller degrades to the [语音] placeholder)', async () => {
    const { service } = makeFakeService({ transcript: { text: '', audioSeconds: 0.2, inferenceSeconds: 0.1 } })
    await expect(makeTranscriber({ getSpeechToText: () => service }).transcribe(await writeVoiceFile())).resolves.toBe('')
  })

  it('throws a Chinese error when the host speechToText service is unavailable', async () => {
    await expect(makeTranscriber({ getSpeechToText: () => undefined }).transcribe(await writeVoiceFile()))
      .rejects.toThrow('STT: DSH 语音转写服务不可用（需启用宿主实验性语音转写插件）')
  })

  it('throws when the host service exposes no providers', async () => {
    const { service, calls } = makeFakeService({ providerCount: 0 })
    await expect(makeTranscriber({ getSpeechToText: () => service }).transcribe(await writeVoiceFile()))
      .rejects.toThrow('STT: DSH 语音转写服务没有可用 provider')
    expect(calls.prepareIds).toEqual([])
    expect(calls.resolveAudio).toBeUndefined()
  })

  it('calls prepare() best-effort and fails this message when the provider is unprepared', async () => {
    const { service, calls } = makeFakeService({ phase: 'unprepared' })
    await expect(makeTranscriber({ getSpeechToText: () => service }).transcribe(await writeVoiceFile()))
      .rejects.toThrow('STT: DSH 语音 provider 尚未准备就绪')
    // 不等待：prepare fire-and-forget，选中 provider id 透传
    expect(calls.prepareIds).toEqual(['sensevoice-local'])
    // 未就绪时不应走到 resolve/transcribe
    expect(calls.resolveAudio).toBeUndefined()
    expect(calls.timeoutSignal).toBeUndefined()
  })

  it('calls prepare() for a failed provider without waiting for it', async () => {
    const { service, calls } = makeFakeService({ phase: 'failed' })
    await expect(makeTranscriber({ getSpeechToText: () => service }).transcribe(await writeVoiceFile()))
      .rejects.toThrow('phase=failed')
    expect(calls.prepareIds).toEqual(['sensevoice-local'])
  })

  it('does not call prepare() when preparation is already in flight', async () => {
    const { service, calls } = makeFakeService({ phase: 'downloading' })
    await expect(makeTranscriber({ getSpeechToText: () => service }).transcribe(await writeVoiceFile()))
      .rejects.toThrow('phase=downloading')
    expect(calls.prepareIds).toEqual([])
  })

  it('passes AbortSignal.timeout(timeoutMs) to transcribe()', async () => {
    const { service, calls } = makeFakeService({ transcript: { text: 'ok', audioSeconds: 0.2, inferenceSeconds: 0.1 } })
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    await makeTranscriber({ getSpeechToText: () => service, timeoutMs: 1234 }).transcribe(await writeVoiceFile())
    expect(timeoutSpy).toHaveBeenCalledWith(1234)
    expect(calls.timeoutSignal).toBeInstanceOf(AbortSignal)
  })
})
