/**
 * W1/T5 inbound recording + offline replay tests: the recorder's line shape,
 * decision capture (gate-skipped events carry the current reason), redaction
 * of 6+ digit runs, 2MiB rename rotation, bypass semantics (write failures
 * only warn), default-off zero files, the recording's token-free guarantee,
 * and the offline replay through the REAL pipeline (forced dry-run, no
 * websocket) with the per-message decision summary.
 * @module dsh-onebot/tests/record-replay
 */
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { InboundRecorder, INBOX_FILE, inboxRotatedFile, redactDigits, toInboxFrame } from '../src/record.js'
import type { InboxLine } from '../src/record.js'
import { replayInbox } from '../src/replay.js'

import { makeHarness } from './helpers/bridge-harness.js'

const CJK = /[\u4e00-\u9fff]/

const privateEvent = (text: string, userId = 10001): Record<string, unknown> => ({
  post_type: 'message', message_type: 'private', user_id: userId, self_id: 10002, message_id: 5001,
  message: [{ type: 'text', data: { text } }], raw_message: text,
  sender: { user_id: userId, nickname: '小明' },
})

const readLines = (file: string): InboxLine[] => {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8').trim()
  return text === '' ? [] : text.split('\n').map(line => JSON.parse(line) as InboxLine)
}

describe('inbound recorder (src/record.ts)', () => {
  it('redacts 6+ digit runs (ids and text) while leaving short numbers intact', () => {
    expect(redactDigits('我的QQ是 841859784，收货码 1234')).toBe('我的QQ是 841****，收货码 1234')
    const frame = toInboxFrame({ ...privateEvent('呼叫 13800001111'), user_id: 841859784 } as never)
    expect(frame.user_id).toBe('841859784') // toInboxFrame itself never masks
    expect(frame.raw_message).toBe('呼叫 13800001111')
  })

  it('records the replayable frame plus the decision for gated drops and dispatched messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inbox-'))
    const recorder = new InboundRecorder({ dir })
    const h = await makeHarness({ recorder })
    // ① dispatched private message → dispatch ok:true decision.
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 15_000 })
    // ② group message without @ → mention-gated drop with Chinese reason.
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 10001, group_id: 888, self_id: 10002,
      message: [{ type: 'text', data: { text: '没有 at' } }], raw_message: '没有 at',
      sender: { user_id: 10001, nickname: '路人' },
    }))
    await new Promise(resolve => setTimeout(resolve, 200))
    await recorder.flush()
    const lines = readLines(join(dir, INBOX_FILE))
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line.v).toBe(1)
      expect(typeof line.ts).toBe('number')
      expect(line.kind).toBe('message')
      expect(line.frame.message_type).toBeDefined()
      expect(line.frame.raw_message).toBeDefined()
    }
    const dispatched = lines.find(l => l.frame.raw_message === '你好')!
    expect(dispatched.decision).toMatchObject({ stage: 'dispatch', ok: true })
    const dropped = lines.find(l => l.frame.raw_message === '没有 at')!
    expect(dropped.decision?.ok).toBe(false)
    expect(dropped.decision?.stage).toBe('mention')
    expect(dropped.decision?.reason).toMatch(CJK)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('redacts 6+ digit runs before serialization when inboxRedact is on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inbox-'))
    const recorder = new InboundRecorder({ dir, redact: true })
    const h = await makeHarness({ recorder })
    // A non-allowlisted 8-digit user → the whitelist drop path; the recording
    // still captures the frame (redacted) with the decision reason.
    const event = { ...privateEvent('我的QQ是 841859784，验证码 1234'), user_id: 841859784 }
    event.sender = { user_id: 841859784, nickname: '小明' }
    h.client.send(JSON.stringify(event))
    await new Promise(resolve => setTimeout(resolve, 200))
    await recorder.flush()
    const line = readLines(join(dir, INBOX_FILE))[0]!
    expect(line.frame.raw_message).toBe('我的QQ是 841****，验证码 1234')
    expect(line.frame.user_id).toBe('841****')
    expect(line.frame.sender?.user_id).toBe('841****')
    expect(line.decision).toMatchObject({ stage: 'whitelist', ok: false })
    expect(String(line.ts)).not.toContain('****') // ts untouched
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('never records the connection accessToken (file scan)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inbox-'))
    const recorder = new InboundRecorder({ dir })
    const h = await makeHarness({ recorder })
    h.sendText('消息正文里出现 access_token=sk-abc123 也不该有连接密钥')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 15_000 })
    await recorder.flush()
    const raw = readFileSync(join(dir, INBOX_FILE), 'utf8')
    // The harness connection's Bearer token must never appear in the recording.
    expect(raw).not.toContain('test-token')
    expect(raw).not.toContain('Bearer')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('rotates by rename at the size cap, keeping the previous files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-inbox-'))
    const recorder = new InboundRecorder({ dir, maxBytes: 400 })
    for (let i = 0; i < 8; i++) {
      const session = recorder.begin(privateEvent('第' + i + '条消息，内容较长一些以便触发轮转') as never)
      session.end()
    }
    await recorder.flush()
    expect(existsSync(join(dir, inboxRotatedFile(1)))).toBe(true)
    expect(recorder.getStats().rotated).toBeGreaterThan(0)
    const rotated = readLines(join(dir, inboxRotatedFile(1)))
    expect(rotated.length).toBeGreaterThan(0)
    expect(rotated.every(l => l.frame.raw_message !== undefined)).toBe(true)
  })

  it('is a pure bypass: a write failure only warns, never throws', async () => {
    const base = mkdtempSync(join(tmpdir(), 'onebot-inbox-'))
    // mediaDir path is a REGULAR FILE → every write fails.
    const dir = join(base, 'blocked')
    writeFileSync(dir, 'not a dir')
    const warns: string[] = []
    const recorder = new InboundRecorder({ dir, log: (_level, message) => warns.push(message) })
    const session = recorder.begin(privateEvent('你好') as never)
    expect(() => session.end()).not.toThrow()
    await recorder.flush()
    expect(recorder.getStats().writeFailures).toBe(1)
    expect(warns[0]).toContain('入站录制写盘失败')
  })

  it('default off: no recorder → no inbox file, identical behavior', async () => {
    const h = await makeHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1), { timeout: 15_000 })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(existsSync(join(h.mediaDir, INBOX_FILE))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})

describe('offline replay (src/replay.ts)', () => {
  it('replays recorded lines through the real pipeline with forced dry-run and summarizes decisions', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'onebot-replay-'))
    const inbox = join(traceDir, 'in.jsonl')
    const lines = [
      JSON.stringify(toInboxFrame(privateEvent('你好') as never)),
      JSON.stringify(toInboxFrame({ ...privateEvent('/help'), message_id: 5002 } as never)),
      'not-json-garbage',
    ]
    writeFileSync(inbox, lines.join('\n') + '\n')
    const report = await replayInbox({
      inboxFile: inbox,
      traceDir,
      policy: { adminUsers: ['10001'], allowAllUsers: true },
    })
    expect(report.total).toBe(3)
    expect(report.replayed).toBe(2)
    expect(report.skipped).toBe(1)
    // /help is consumed by the command router → its reply send is intercepted
    // by the forced dry-run (no websocket, no real frame anywhere).
    expect(report.interceptedOutbound).toBeGreaterThanOrEqual(1)
    expect(report.entries).toHaveLength(2)
    for (const entry of report.entries) {
      expect(entry.traceId).toMatch(/^t-/)
      expect(entry.chain.length).toBeGreaterThan(0)
      expect(entry.chain[0]!.stage).toBe('inbound')
      expect(entry.decision.reason ?? '').not.toBe('')
    }
    // The dispatched message's chain carries dispatch ok:true; its decision
    // tail may be a later outbound event (the /help reply is attributed to
    // the last dispatch's traceId — the documented last-writer-wins rule).
    const dispatched = report.entries.find(e => e.chain.some(c => c.stage === 'dispatch'))!
    expect(dispatched.decision.ok).toBe(true)
    const commandEntry = report.entries.find(e => e.chain.some(c => c.stage === 'command'))!
    expect(commandEntry.decision.ok).toBe(true)
  }, 60_000)

  it('reproduces gate drops when the caller supplies the production gates', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'onebot-replay-'))
    const inbox = join(traceDir, 'in.jsonl')
    const groupEvent = {
      post_type: 'message', message_type: 'group', user_id: 10001, group_id: 888, self_id: 10002, message_id: 5002,
      message: [{ type: 'text', data: { text: '没有 at' } }], raw_message: '没有 at',
      sender: { user_id: 10001, nickname: '路人' },
    }
    writeFileSync(inbox, JSON.stringify(toInboxFrame(groupEvent as never)) + '\n')
    const report = await replayInbox({
      inboxFile: inbox,
      traceDir,
      requireMention: true,
      policy: { allowAllUsers: true },
    })
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]!.decision).toMatchObject({ stage: 'mention', ok: false })
    expect(report.entries[0]!.decision.reason).toMatch(CJK)
  }, 60_000)
})
