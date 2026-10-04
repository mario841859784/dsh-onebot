/**
 * W1/T5 healthcheck + diagnostics tests: the report sections (connection /
 * retry+self-heal / dedup+write-gate counters / file sizes / recent ok:false
 * events), the config snapshot redaction, secret scrubbing, the ZIP archive
 * structure, the fail-closed no-plaintext-token guarantee of the exported
 * diagnostics package, and the /healthcheck command routing.
 * @module dsh-onebot/tests/health
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { buildZip, crc32, exportDiagnostics, healthReport, redactSnapshot, scrubSecrets } from '../src/health.js'
import { TRACE_FILE } from '../src/trace.js'

import { makeCmdHarness } from './helpers/bridge-harness.js'

const baseDeps = (mediaDir: string, overrides: Record<string, unknown> = {}) => ({
  mediaDir,
  connection: { connected: true, selfId: '10002' },
  transport: { mode: 'reverse', host: '127.0.0.1', port: 8643 },
  retryState: { reverseRetryAttempts: 0, reconnectAttempts: 0, selfHealing: false },
  dedup: { entries: 3, windowSeconds: 300 },
  writeGate: { minuteUsed: 2, minuteLimit: 20, dayUsed: 40, dayLimit: 500 },
  configSnapshot: redactSnapshot({ accessToken: 'super-secret-token', botQQ: '10002' }),
  secrets: ['super-secret-token'],
  log: () => undefined,
  ...overrides,
}) as Parameters<typeof healthReport>[0]

describe('health report (src/health.ts)', () => {
  it('renders the connection / retry / dedup / write-gate / file / recent-failure sections', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-health-'))
    writeFileSync(join(mediaDir, TRACE_FILE), [
      JSON.stringify({ v: 1, ts: 1_760_000_000_000, traceId: 't-1', stage: 'mention', ok: false, reason: '群聊未 @ 机器人，已忽略' }),
      JSON.stringify({ v: 1, ts: 1_760_000_005_000, traceId: 't-2', stage: 'whitelist', ok: false, reason: '私聊用户不在允许名单，已忽略' }),
      JSON.stringify({ v: 1, ts: 1_760_000_010_000, traceId: 't-3', stage: 'inbound', ok: true }),
    ].join('\n') + '\n')
    const report = await healthReport(baseDeps(mediaDir, {
      recorder: { enabled: true, redact: true, written: 7 },
      inject: { enabled: true, dryRun: true, consumed: 4, intercepted: 9, skippedHistory: 2 },
    }))
    expect(report).toContain('▍dsh-onebot 体检')
    expect(report).toContain('连接：已连接（mode=reverse 127.0.0.1:8643')
    expect(report).toContain('重试/自愈：reverse 接管重试 0 次 · forward 重连 0 次 · 自愈中 否')
    expect(report).toContain('去重窗口：3 条在窗（dedupWindowSeconds=300）')
    expect(report).toContain('写闸门：本分钟 2/20 · 今日 40/500')
    expect(report).toContain('录制：开启（redact=on，已写 7 行）')
    expect(report).toContain('注入：开启（dryRun=on，已消费 4 行、拦截出站 9 次、跳过历史 2 条）')
    expect(report).toContain('qq-trace.jsonl')
    expect(report).toContain('最近 ok:false 事件（2 条）')
    expect(report).toContain('群聊未 @ 机器人，已忽略')
  })

  it('reports unknown transport counters and no failures gracefully', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-health-'))
    const report = await healthReport(baseDeps(mediaDir, {
      connection: { connected: false, selfId: '' },
      retryState: {},
    }))
    expect(report).toContain('连接：未连接')
    expect(report).toContain('重试/自愈：reverse 接管重试 未知 次')
    expect(report).toContain('最近 ok:false 事件：无（或 trace 未开启）')
  })
})

describe('secret redaction', () => {
  it('redactSnapshot masks secret-looking keys to 已配置/未配置 and walks nesting', () => {
    const snap = redactSnapshot({
      accessToken: 'sk-live-123',
      botQQ: '10002',
      emptyToken: '',
      nested: { apiKey: 'abcd', port: 8643 },
      list: [{ password: 'p@ss' }, 1],
    })
    expect(snap.accessToken).toBe('已配置')
    expect(snap.botQQ).toBe('10002')
    expect(snap.emptyToken).toBe('未配置')
    expect((snap.nested as Record<string, unknown>).apiKey).toBe('已配置')
    expect((snap.nested as Record<string, unknown>).port).toBe(8643)
    expect((snap.list as Array<Record<string, unknown>>)[0]!.password).toBe('已配置')
  })

  it('scrubSecrets removes provided values and generic credential lines', () => {
    const scrubbed = scrubSecrets('access_token: sk-abc123 和 Bearer eyJhbGci.xx 加 token "zzz-secret-zzz"', ['zzz-secret-zzz'])
    expect(scrubbed).not.toContain('zzz-secret-zzz')
    expect(scrubbed).toContain('[REDACTED]')
    expect(scrubbed).not.toContain('sk-abc123')
    expect(scrubbed).not.toContain('eyJhbGci')
    expect(scrubbed).not.toContain('Bearer eyJhbGci')
  })
})

describe('diagnostics archive (zip)', () => {
  it('packs trace/inbox/audit/config/report with all secrets scrubbed, fail-closed', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-health-'))
    writeFileSync(join(mediaDir, TRACE_FILE), '决策事件 access_token: sk-live-123 已脱敏前\n')
    writeFileSync(join(mediaDir, 'qq-inbox.jsonl'), '{"v":1,"ts":1,"kind":"message","frame":{}}\n')
    writeFileSync(join(mediaDir, 'qq-actions.log'), '{"ts":1,"action":"send_msg","ok":true}\n')
    const archive = await exportDiagnostics(baseDeps(mediaDir))
    expect(archive).toMatch(/qq-diagnostics-\d{4,}-\d+\.zip$/)
    expect(existsSync(archive)).toBe(true)
    const raw = readFileSync(archive)
    expect(raw.subarray(0, 2).toString()).toBe('PK')
    // The packed byte stream must contain no plaintext secret.
    expect(raw.includes(Buffer.from('sk-live-123'))).toBe(false)
    expect(raw.includes(Buffer.from('super-secret-token'))).toBe(false)
    expect(raw.includes(Buffer.from('[REDACTED]'))).toBe(true)
    // Entries: names + config/report artifacts present (UTF-8 decode covers
    // both the stored names and the stored JSON content).
    const rawText = raw.toString('utf8')
    for (const name of ['config-snapshot.json', 'health-report.txt', 'qq-trace.jsonl', 'qq-inbox.jsonl', 'qq-actions.log']) {
      expect(rawText.includes(name)).toBe(true)
    }
    expect(rawText).toContain('"accessToken": "[REDACTED]"') // JSON form scrubbed
    expect(rawText).toContain('"botQQ": "10002"') // non-secret config values survive
  })

  it('fail-closed: refuses to write an archive whose bytes still contain a secret', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-health-'))
    // White-box trigger for the final byte scan: a secret equal to the
    // scrub replacement survives split/join scrubbing, so the exporter must
    // throw instead of writing the archive (in production this branch is
    // unreachable unless scrubbing itself regresses — exactly what the guard
    // exists for).
    writeFileSync(join(mediaDir, TRACE_FILE), 'marker [REDACTED] present\n')
    await expect(exportDiagnostics(baseDeps(mediaDir, { secrets: ['[REDACTED]'] })))
      .rejects.toThrow('诊断包脱敏失败')
    expect(existsSync(join(mediaDir, 'qq-diagnostics-'))).toBe(false)
  })

  it('buildZip produces parseable stored entries with correct CRCs', () => {
    const a = Buffer.from('hello world', 'utf8')
    const b = Buffer.from('{"k":1}', 'utf8')
    const zip = buildZip([{ name: 'a.txt', data: a }, { name: 'b/c.json', data: b }])
    expect(crc32(a)).toBe(0x0d4a1185)
    expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004')
    expect(zip.includes(Buffer.from('hello world'))).toBe(true)
    // End-of-central-directory signature present at the tail region.
    expect(zip.subarray(zip.length - 22).readUInt32LE(0)).toBe(0x06054b50)
    expect(zip.subarray(zip.length - 22).readUInt16LE(10)).toBe(2) // entry count
  })
})

describe('/healthcheck command', () => {
  it('routes /healthcheck to the health summary and /healthcheck export to the archive path', async () => {
    const h = await makeCmdHarness()
    h.sendText('/healthcheck')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('▍dsh-onebot 体检'))).toBe(true)
    }, { timeout: 15_000 })
    h.sendText('/healthcheck export')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('诊断包已导出'))).toBe(true)
    }, { timeout: 15_000 })
    h.sendText('/healthcheck what')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('用法：/healthcheck'))).toBe(true)
    }, { timeout: 15_000 })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)
})
