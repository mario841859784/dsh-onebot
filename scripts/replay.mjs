#!/usr/bin/env node
/**
 * Offline replay CLI (W1/T5): re-run a recorded inbox file through the real
 * inbound pipeline with forced dry-run semantics (no websocket, all outbound
 * writes intercepted) and print/write the per-message decision summary.
 *
 * Usage:
 *   node scripts/replay.mjs <inbox.jsonl> [options]
 * Options:
 *   --media-dir <dir>      sandbox dir for trace sink + media (default: a temp
 *                          dir under the OS temp dir is created inside this script's dir)
 *   --limit <n>            replay at most n messages
 *   --require-mention      reproduce the group @-gate (default off)
 *   --ignore-self          reproduce ignoreSelf (default off)
 *   --bot-qq <qq>          the bot's own QQ (ignoreSelf/mention comparisons)
 *   --admin <qq>           admin QQ for the replay policy (repeatable via comma)
 *   --out <file>           write the JSON report to file
 * Build first: `npm run build` (imports ../lib/replay.js).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { argv, exit } from 'node:process'

const args = argv.slice(2)
const positional = []
const named = {}
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg.startsWith('--')) {
    const key = arg.slice(2)
    if (key === 'require-mention' || key === 'ignore-self') {
      named[key] = true
      continue
    }
    const value = args[++i]
    if (value === undefined) {
      console.error('replay: --' + key + ' 需要一个值')
      exit(2)
    }
    named[key] = value
    continue
  }
  positional.push(arg)
}
if (positional.length !== 1) {
  console.error('用法: node scripts/replay.mjs <inbox.jsonl> [--media-dir <dir>] [--limit <n>] [--require-mention] [--ignore-self] [--bot-qq <qq>] [--admin <qq>] [--out <report.json>]')
  exit(2)
}
const inboxFile = resolve(positional[0])
const traceDir = named['media-dir'] !== undefined
  ? resolve(String(named['media-dir']))
  : mkdtempSync(join(tmpdir(), 'onebot-replay-'))

const { replayInbox } = await import('../lib/replay.js')

const admins = String(named['admin'] ?? '').split(',').map(v => v.trim()).filter(v => v !== '')
const report = await replayInbox({
  inboxFile,
  traceDir,
  ...(named['limit'] !== undefined ? { limit: Number(named['limit']) } : {}),
  requireMention: named['require-mention'] === true,
  ignoreSelf: named['ignore-self'] === true,
  ...(named['bot-qq'] !== undefined ? { botQQ: String(named['bot-qq']) } : {}),
  ...(admins.length > 0 ? { policy: { adminUsers: admins } } : {}),
  ...(named['out'] !== undefined ? { outFile: resolve(String(named['out'])) } : {}),
})

console.log('回放完成：来源=' + report.sourceFile + ' 总行数=' + report.total + ' 已回放=' + report.replayed + ' 跳过=' + report.skipped + ' 拦截出站=' + report.interceptedOutbound)
for (const entry of report.entries) {
  const head = entry.decision.ok ? '✅' : '⛔'
  console.log(head + ' ' + entry.traceId + ' [' + entry.chatId + '] ' + entry.decision.stage
    + (entry.decision.reason !== undefined ? ' — ' + entry.decision.reason : ''))
}
if (named['out'] === undefined) {
  console.log('沙箱 trace 目录: ' + traceDir)
}
