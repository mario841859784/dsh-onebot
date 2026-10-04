/**
 * Healthcheck + diagnostics export (W1/T5): `/healthcheck` renders a
 * snapshot summary of the bridge's live state — connection state, transport
 * retry/self-heal counters, dedup window and write-gate counters, the trace/
 * inbox/audit file sizes, and the most recent ok:false trace events — and
 * `exportDiagnostics` packs the observability artifacts (trace jsonl +
 * rotations, inbox jsonl + rotations, actions audit log, a redacted config
 * snapshot and the health report itself) into
 * mediaDir/qq-diagnostics-<ts>.zip (stored entries, no external dependency).
 *
 * Secret discipline: the config snapshot redacts secret-looking keys
 * (token/secret/password/apikey) to 已配置/未配置 BEFORE it ever leaves the
 * caller, and every packed text artifact is additionally scrubbed for the
 * caller-provided secret values and for access_token/Authorization-style
 * patterns, so the archive can be shared without leaking credentials. The
 * packer asserts the final bytes contain no provided secret (fail-closed).
 *
 * MIT attribution: the "health snapshot + redacted diagnostics bundle"
 * concept is aligned with dsh-qq-onebot-bridge (MIT License, Copyright (c)
 * 2026 dsh-qq-onebot-bridge contributors, v0.4.0 硬约束④可体检/⑤可导出);
 * the zip packer, the secret scrubbing and the report layout are original to
 * this plugin. The full borrowed-item list lives in DEVLOG.md (2026-10-04).
 * @module dsh-onebot/health
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { ACTION_AUDIT_FILE } from './outbound.js'
import { INBOX_FILE, inboxRotatedFile } from './record.js'
import { TRACE_FILE, traceRotatedFile } from './trace.js'

/** How many recent ok:false events the report lists. */
export const HEALTH_RECENT_FAILURES = 5

export interface HealthDeps {
  /** The plugin media dir (artifact source + archive destination). */
  mediaDir: string
  /** Connection snapshot. */
  connection: { connected: boolean; selfId: string }
  /** Transport config summary (mode/host/port) for the connection line. */
  transport: { mode: string; host: string; port: number }
  /** Runtime transport retry/self-heal counters (defensive read of the
   * connection's internal state; undefined fields render as 未知). */
  retryState: { reverseRetryAttempts?: number; reconnectAttempts?: number; selfHealing?: boolean }
  /** Dedup window snapshot. */
  dedup: { entries: number; windowSeconds: number }
  /** Write-gate snapshot. */
  writeGate: { minuteUsed: number; minuteLimit: number; dayUsed: number; dayLimit: number }
  /** Recorder state (absent = recording off). */
  recorder?: { enabled: boolean; redact: boolean; written: number } | undefined
  /** Inject channel state (absent = channel off). */
  inject?: { enabled: boolean; dryRun: boolean; consumed: number; intercepted: number; skippedHistory: number } | undefined
  /** The already-redacted config snapshot (see redactSnapshot). */
  configSnapshot: Record<string, unknown>
  /** Secret VALUES to scrub from every packed artifact (e.g. accessToken). */
  secrets?: readonly string[]
  /** How many recent ok:false events to include (default HEALTH_RECENT_FAILURES). */
  recentFailures?: number
  log(level: 'info' | 'warn', message: string): void
}

/** Redact a config snapshot: secret-looking keys become 已配置/未配置, nested
 * objects are walked. Returns a new object (never mutates the input). */
export function redactSnapshot(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (isSecretKey(key)) {
      out[key] = typeof value === 'string' && value !== '' ? '已配置' : '未配置'
      continue
    }
    if (Array.isArray(value)) {
      out[key] = value.map(item => (typeof item === 'object' && item !== null ? redactSnapshot(item as Record<string, unknown>) : item))
      continue
    }
    if (typeof value === 'object' && value !== null) {
      out[key] = redactSnapshot(value as Record<string, unknown>)
      continue
    }
    out[key] = value
  }
  return out
}

function isSecretKey(key: string): boolean {
  return /token|secret|password|passwd|api[-_]?key|authorization/i.test(key)
}

/** The secret scrub applied to every packed text artifact. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('[REDACTED]')
  }
  // Generic credential-line patterns (best effort, belt-and-braces): JSON
  // form ("accessToken":"…"), header/query form and Bearer tokens.
  out = out.replace(/(access[_-]?token|authorization|bearer|api[-_]?key)(["'\s:=]+)[^\s"',}\]]+/gi, (_m, name, sep) => name + sep + '[REDACTED]')
  return out
}

/** One-line-per-artifact file size summary helper (human readable). */
export function formatBytes(size: number): string {
  if (size < 1024) return size + 'B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + 'KiB'
  return (size / (1024 * 1024)).toFixed(2) + 'MiB'
}

/** Render the healthcheck summary (plain text, one ▍ block). */
export async function healthReport(deps: HealthDeps): Promise<string> {
  const lines: string[] = []
  lines.push('▍dsh-onebot 体检')
  const conn = deps.connection.connected ? '已连接' : '未连接'
  lines.push('连接：' + conn + '（mode=' + deps.transport.mode + ' ' + deps.transport.host + ':' + deps.transport.port + '，selfId=' + (deps.connection.selfId !== '' ? deps.connection.selfId : '未学习') + '）')
  const retry = deps.retryState
  lines.push('重试/自愈：reverse 接管重试 ' + (retry.reverseRetryAttempts ?? '未知') + ' 次 · forward 重连 ' + (retry.reconnectAttempts ?? '未知') + ' 次 · 自愈中 ' + (retry.selfHealing === undefined ? '未知' : retry.selfHealing ? '是' : '否'))
  lines.push('去重窗口：' + deps.dedup.entries + ' 条在窗（dedupWindowSeconds=' + deps.dedup.windowSeconds + '）')
  lines.push('写闸门：本分钟 ' + deps.writeGate.minuteUsed + '/' + deps.writeGate.minuteLimit + ' · 今日 ' + deps.writeGate.dayUsed + '/' + deps.writeGate.dayLimit)
  lines.push('录制：' + (deps.recorder?.enabled ? '开启（redact=' + (deps.recorder.redact ? 'on' : 'off') + '，已写 ' + deps.recorder.written + ' 行）' : '关闭'))
  lines.push('注入：' + (deps.inject?.enabled ? '开启（dryRun=' + (deps.inject.dryRun ? 'on' : 'off') + '，已消费 ' + deps.inject.consumed + ' 行、拦截出站 ' + deps.inject.intercepted + ' 次、跳过历史 ' + deps.inject.skippedHistory + ' 条）' : '关闭'))
  const files: string[] = []
  for (const [name, rotated] of [[TRACE_FILE, traceRotatedFile], [INBOX_FILE, inboxRotatedFile]] as const) {
    const size = await fileSize(join(deps.mediaDir, name))
    files.push(name + ' ' + (size === undefined ? '无' : formatBytes(size) + rotatedSuffixInfo(deps.mediaDir, rotated)))
  }
  const auditSize = await fileSize(join(deps.mediaDir, ACTION_AUDIT_FILE))
  files.push(ACTION_AUDIT_FILE + ' ' + (auditSize === undefined ? '无' : formatBytes(auditSize)))
  lines.push('文件：' + files.join(' · '))
  const recent = await recentFailures(join(deps.mediaDir, TRACE_FILE), deps.recentFailures ?? HEALTH_RECENT_FAILURES)
  if (recent.length === 0) {
    lines.push('最近 ok:false 事件：无（或 trace 未开启）')
  } else {
    lines.push('最近 ok:false 事件（' + recent.length + ' 条）：')
    for (const event of recent) {
      lines.push('  ' + new Date(event.ts).toISOString() + ' [' + event.stage + '] ' + (event.reason ?? '') + ' (' + event.traceId + ')')
    }
  }
  return lines.join('\n')
}

function rotatedSuffixInfo(dir: string, rotated: (generation: number) => string): string {
  let kept = 0
  for (let i = 1; i <= 5; i++) {
    if (existsSync(join(dir, rotated(i)))) kept = i
    else break
  }
  return kept > 0 ? '（轮转 ' + kept + ' 代）' : ''
}

async function fileSize(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size
  } catch {
    return undefined
  }
}

interface TraceLine {
  ts: number
  traceId: string
  stage: string
  ok: boolean
  reason?: string
}

/** The most recent ok:false trace events (file order, newest last). */
export async function recentFailures(file: string, count: number): Promise<TraceLine[]> {
  if (count <= 0 || !existsSync(file)) return []
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const out: TraceLine[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const event = JSON.parse(trimmed) as TraceLine
      if (event.ok === false) out.push(event)
    } catch {
      // bad line: skip
    }
  }
  return out.slice(-count)
}

/** Export the diagnostics archive; returns the archive path. */
export async function exportDiagnostics(deps: HealthDeps): Promise<string> {
  const reportText = await healthReport(deps)
  const entries: Array<{ name: string; data: Buffer }> = []
  entries.push({ name: 'health-report.txt', data: Buffer.from(scrubSecrets(reportText, deps.secrets ?? []), 'utf8') })
  entries.push({ name: 'config-snapshot.json', data: Buffer.from(scrubSecrets(JSON.stringify(deps.configSnapshot, null, 2), deps.secrets ?? []), 'utf8') })
  for (const name of artifactNames()) {
    const file = join(deps.mediaDir, name)
    if (!existsSync(file)) continue
    try {
      const raw = await readFile(file, 'utf8')
      entries.push({ name, data: Buffer.from(scrubSecrets(raw, deps.secrets ?? []), 'utf8') })
    } catch (error) {
      deps.log('warn', '诊断包读取 ' + name + ' 失败，已跳过: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  const zip = buildZip(entries)
  // Fail-closed: the archive must not contain any provided secret.
  for (const secret of deps.secrets ?? []) {
    if (secret !== '' && zip.includes(Buffer.from(secret, 'utf8'))) {
      throw new Error('诊断包脱敏失败：归档中仍含明文密钥，已放弃导出')
    }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const archive = join(deps.mediaDir, 'qq-diagnostics-' + stamp + '.zip')
  await writeFile(archive, zip)
  return archive
}

function artifactNames(): string[] {
  const names = [TRACE_FILE, INBOX_FILE, ACTION_AUDIT_FILE]
  for (let i = 1; i <= 2; i++) {
    names.push(traceRotatedFile(i), inboxRotatedFile(i))
  }
  return names
}

// ── minimal ZIP writer (stored entries, no external dependency) ────────────

/** CRC-32 (IEEE 0xEDB88320, as required by the ZIP APPENDIX format). */
export function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF]! ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

const CRC_TABLE = (() => {
  const table = new Array<number>(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** Pack entries into a ZIP archive (method=stored, UTF-8 names). */
export function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 name flag
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, entry.data)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra len
    central.writeUInt16LE(0, 32) // comment len
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + entry.data.length
  }
  const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, eocd])
}
