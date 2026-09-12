/**
 * STT non-blocking tests (M3-D4c): a voice message dispatches the [语音]
 * placeholder immediately while the transcription runs in the background; the
 * completed transcript is steered into the chat's agent (running turn's next
 * step boundary, or a new turn when idle). Failure/timeout and an empty
 * transcript keep the placeholder as the final state — nothing is appended.
 * @module dsh-onebot/tests/stt-nonblocking
 */
import { describe, expect, it, vi } from 'vitest'

import { InboundPipeline } from '../src/inbound.js'
import type { InboundContext } from '../src/inbound.js'
import type { ChatId } from '../src/chat.js'

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
function makePipelineCtx(transcribe: (path: string) => Promise<string>, steers: Array<{ chatId: ChatId; text: string }>, logs: string[]): InboundContext {
  return {
    call: vi.fn(async () => undefined),
    selfId: () => '10002',
    policy: { dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [], adminUsers: [], allowAllUsers: false, requireMention: true },
    getChat: () => undefined,
    getSettings: () => ({}),
    sweepIdleChats: async () => undefined,
    media: { resolve: async () => ({ kind: 'voice', path: '/tmp/voice-1.mp3' }) } as never,
    transcriber: { enabled: true, transcribe } as never,
    steerTranscript: (chatId, text) => { steers.push({ chatId, text }) },
    tryHandleCommand: async () => false,
    dispatchFollowup: async () => undefined,
    sendToChat: async () => [],
    log: (level, message) => { logs.push(level + ': ' + message) },
    config: { botQQ: '10002', ignoreSelf: false, requireMention: true, rateLimitPerMinute: 0, restrictedMemberPrefix: false, maxInboundFileBytes: 0 },
  } as never
}

describe('STT non-blocking (M3-D4c)', () => {
  it('returns the [语音] placeholder immediately and steers the transcript when ready', async () => {
    const slow = deferred<string>()
    const steers: Array<{ chatId: ChatId; text: string }> = []
    const transcribe = vi.fn(() => slow.promise)
    const pipeline = new InboundPipeline(makePipelineCtx(transcribe, steers, []))

    // The annotation resolves while the transcription is still pending.
    const annotation = await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    expect(annotation).toBe('[语音]')
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(steers).toEqual([])

    // Completing the transcription appends it as a steer into the same chat.
    slow.resolve('好了')
    await vi.waitFor(() => expect(steers).toEqual([{ chatId: 'private:10001', text: '好了' }]))
  })

  it('keeps the placeholder as final when the transcription fails (no steer)', async () => {
    const failing = deferred<string>()
    const steers: Array<{ chatId: ChatId; text: string }> = []
    const logs: string[] = []
    const pipeline = new InboundPipeline(makePipelineCtx(() => failing.promise, steers, logs))

    const annotation = await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    expect(annotation).toBe('[语音]')

    failing.reject(new Error('STT command timed out after 60000ms'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(steers).toEqual([])
    expect(logs.some(line => line.startsWith('warn: STT failed'))).toBe(true)
  })

  it('does not steer an empty transcript (silence keeps the placeholder)', async () => {
    const silent = deferred<string>()
    const steers: Array<{ chatId: ChatId; text: string }> = []
    const pipeline = new InboundPipeline(makePipelineCtx(() => silent.promise, steers, []))

    const annotation = await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    expect(annotation).toBe('[语音]')

    silent.resolve('')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(steers).toEqual([])
  })

  it('runs the full pipeline non-blocking: placeholder dispatches first, transcript steers after', async () => {
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
    // The placeholder reaches the agent while the transcription is still pending.
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('[语音]')
    expect(h.captured.followups[0].text).not.toContain('语音转写')
    expect(steers).toEqual([])

    // Completing STT appends the labeled transcript via agent.steer.
    slow.resolve('好了')
    await vi.waitFor(() => expect(steers).toHaveLength(1))
    expect(steers[0]).toEqual({ text: '（语音转写：好了）', sessionId: h.sessionIds[0] })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('never appends on a failing transcription in the full pipeline', async () => {
    const failing = deferred<string>()
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
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    failing.reject(new Error('boom'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.captured.followups).toHaveLength(1)
    expect(h.captured.steers).toEqual([])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
