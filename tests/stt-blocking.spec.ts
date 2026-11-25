/**
 * STT blocking tests (#68): with transcription enabled a voice message waits
 * for STT before dispatch — the labeled transcript replaces the [语音]
 * placeholder in the same message body, so the model sees the voice once and
 * replies exactly once. Failure/timeout and an empty transcript degrade to
 * the [语音] placeholder. Without a transcriber the placeholder is unchanged.
 * @module dsh-onebot/tests/stt-blocking
 */
import { describe, expect, it, vi } from 'vitest'

import { InboundPipeline } from '../src/inbound.js'
import type { InboundContext } from '../src/inbound.js'

import { makeHarness } from './helpers/bridge-harness.js'

/** A controllable one-shot promise. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Minimal pipeline context for direct resolveMediaRef tests (voice path). */
function makePipelineCtx(transcribe: (path: string) => Promise<string>, logs: string[]): InboundContext {
  return {
    call: vi.fn(async () => undefined),
    selfId: () => '10002',
    policy: { dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [], adminUsers: [], allowAllUsers: false, requireMention: true },
    getChat: () => undefined,
    getSettings: () => ({}),
    sweepIdleChats: async () => undefined,
    media: { resolve: async () => ({ kind: 'voice', path: '/tmp/voice-1.mp3' }) } as never,
    transcriber: { enabled: true, transcribe } as never,
    tryHandleCommand: async () => false,
    dispatchFollowup: async () => undefined,
    sendToChat: async () => [],
    log: (level, message) => { logs.push(level + ': ' + message) },
    config: { botQQ: '10002', ignoreSelf: false, requireMention: true, rateLimitPerMinute: 0, restrictedMemberPrefix: false, maxInboundFileBytes: 0 },
  } as never
}

describe('STT blocking (#68)', () => {
  it('waits for the transcription and returns the labeled transcript (no steer)', async () => {
    const slow = deferred<string>()
    const transcribe = vi.fn(() => slow.promise)
    const pipeline = new InboundPipeline(makePipelineCtx(transcribe, []))

    // resolveMediaRef stays pending until the transcription completes.
    const pending = pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    let resolved: string | undefined
    void pending.then(v => { resolved = v })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(resolved).toBeUndefined()
    expect(transcribe).toHaveBeenCalledTimes(1)

    slow.resolve('好了')
    expect(await pending).toBe('（语音转写：好了）')
  })

  it('degrades to the placeholder when the transcription fails', async () => {
    const failing = deferred<string>()
    failing.promise.catch(() => {}) // the pipeline's try/catch attaches its handler a tick later
    const logs: string[] = []
    const pipeline = new InboundPipeline(makePipelineCtx(() => failing.promise, logs))

    const pending = pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    failing.reject(new Error('STT command timed out after 60000ms'))
    expect(await pending).toBe('[语音]')
    expect(logs.some(line => line.startsWith('warn: STT failed'))).toBe(true)
  })

  it('degrades to the placeholder on an empty transcript', async () => {
    const silent = deferred<string>()
    const logs: string[] = []
    const pipeline = new InboundPipeline(makePipelineCtx(() => silent.promise, logs))

    const pending = pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    silent.resolve('')
    expect(await pending).toBe('[语音]')
    expect(logs.some(line => line.startsWith('debug: 语音转写结果为空'))).toBe(true)
  })

  it('keeps the placeholder when no transcriber is enabled', async () => {
    const transcribe = vi.fn()
    const logs: string[] = []
    const ctx = makePipelineCtx(transcribe as never, logs)
    ;(ctx as { transcriber: { enabled: boolean } }).transcriber.enabled = false
    const pipeline = new InboundPipeline(ctx)
    expect(await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')).toBe('[语音]')
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('full pipeline: the transcript lands in the dispatched message body (no steer)', async () => {
    const slow = deferred<string>()
    const steers: Array<{ text: string; sessionId: string }> = []
    const h = await makeHarness({
      transcriber: { enabled: true, transcribe: vi.fn(() => slow.promise) } as never,
    })
    h.captured.steers = steers
    const voiceBase64 = Buffer.from('fake-mp3-bytes').toString('base64')
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'record', data: { file: 'base64://' + voiceBase64 } }],
      raw_message: '[CQ:record,file=base64://...]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    slow.resolve('好了')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('（语音转写：好了）')
    expect(h.captured.followups[0].text).not.toContain('[语音]')
    expect(steers).toEqual([])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('full pipeline: a failing transcription dispatches only the placeholder', async () => {
    const failing = deferred<string>()
    failing.promise.catch(() => {}) // the pipeline's try/catch attaches its handler a tick later
    const h = await makeHarness({
      transcriber: { enabled: true, transcribe: vi.fn(() => failing.promise) } as never,
    })
    h.captured.steers = []
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'record', data: { file: 'base64://' + Buffer.from('fake-mp3-bytes').toString('base64') } }],
      raw_message: '[CQ:record,file=base64://...]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    failing.reject(new Error('boom'))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('[语音]')
    expect(h.captured.followups[0].text).not.toContain('语音转写')
    expect(h.captured.steers).toEqual([])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
