/**
 * Guarded file editing for channel agents (borrowed approach from the IRMIA
 * DevKit's safe_edit — AstrBot plugin, AGPL-3.0; we reimplemented the concept
 * independently in TypeScript, no code copied). Flow per edit:
 *   root allowlist → read → backup → match → replace → syntax check → rollback.
 * Structure and error vocabulary mirror the plugin's tool conventions.
 * @module dsh-onebot/safe-edit
 */

import { mkdir, readFile, rename, stat, writeFile, copyFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { resolve, sep } from 'node:path'

/** Hard cap for guard-railed edits (source files; far below the LLM window). */
export const SAFE_EDIT_MAX_SIZE = 5 * 1024 * 1024

/** Swap newlines to LF for matching; caller handles CRLF round-trip. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Detect and strip `NNNN│ ` / `NNNN: ` line-number prefixes a model may have
 * copied from read output; returns the stripped text (or original). */
export function stripLineNumberPrefixes(text: string): string {
  const lines = text.split('\n')
  const stripped = lines.map(line => line.replace(/^\s*\d{1,6}\s*[│|:]\s?/, ''))
  return stripped.join('\n')
}

/** Path guard: must live under the configured editable root. Returns an error
 * message, or null when the path is acceptable. */
export function checkPathAllowed(root: string, filepath: string): string | null {
  if (root === '' ) return 'safeEditRoot 未配置：code_safe_edit 已禁用（请先在配置中指定可编辑根目录）。'
  const r = resolve(root)
  const p = resolve(filepath)
  if (p === r) return '目标不能是根目录本身。'
  if (!p.startsWith(r + sep) && p !== r) return `路径超出可编辑根目录 ${r}。`
  return null
}

/** All non-overlapping match start indices of `old` in `content`. */
function collectPositions(content: string, old: string): number[] {
  const positions: number[] = []
  let pos = 0
  for (;;) {
    const idx = content.indexOf(old, pos)
    if (idx === -1) break
    positions.push(idx)
    pos = idx + old.length
  }
  return positions
}

/** Aider-style whitespace-tolerant retry: find the old block by stripped lines
 * and realign old/new indentation (preserving inner indentation via a delta). */
export function alignWhitespace(content: string, old: string, newText: string): { old: string; newText: string } | null {
  const oldLines = old.split('\n')
  const contentLines = content.split('\n')
  const oldStripped = oldLines.map(line => line.trim())
  if (oldStripped.length === 0 || oldStripped[0] === '') return null
  for (let i = 0; i + oldLines.length <= contentLines.length; i += 1) {
    let matched = true
    for (let j = 0; j < oldLines.length; j += 1) {
      if (contentLines[i + j].trim() !== oldStripped[j]) {
        matched = false
        break
      }
    }
    if (!matched) continue
    const alignedOld = contentLines.slice(i, i + oldLines.length).join('\n')
    const firstIndent = contentLines[i].match(/^[ \t]*/)?.[0] ?? ''
    const oldFirstLine = oldLines[0]
    const oldIndent = oldFirstLine.match(/^[ \t]*/)?.[0] ?? ''
    const newLines = newText.split('\n')
    const alignedNew = newLines.map((line, index) => {
      if (line.trim() === '') return line
      if (index === 0) return firstIndent + line.slice(oldIndent.length)
      return firstIndent + line.replace(/^[ \t]*/, '')
    })
    return { old: alignedOld, newText: alignedNew.join('\n') }
  }
  return null
}

/** Best-effort syntax check for JS-family files; others are skipped. */
export async function syntaxCheckFile(
  filepath: string,
  runCheck: (file: string) => Promise<string> = defaultSyntaxCheck,
): Promise<{ ok: boolean; skipped: boolean; errors: unknown[] }> {
  const suffix = filepath.slice(filepath.lastIndexOf('.'))
  if (!['.js', '.cjs', '.mjs'].includes(suffix)) {
    return { ok: true, skipped: true, errors: [] }
  }
  try {
    const output = await runCheck(filepath)
    if (output === '') return { ok: true, skipped: false, errors: [] }
    return { ok: false, skipped: false, errors: [{ msg: output.trim().split('\n')[0] }] }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, skipped: false, errors: [{ msg: msg.split('\n')[0] }] }
  }
}

async function defaultSyntaxCheck(file: string): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    execFile('node', ['--check', file], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error === null) resolvePromise('')
      else resolvePromise(String(stderr ?? stdout).trim())
    })
  })
}

/** Atomic write: temp file then rename, so a crash never leaves a half file. */
async function atomicWriteText(filepath: string, content: string): Promise<void> {
  const tmp = filepath + '.tmp'
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filepath)
}

async function backupFor(backupDir: string, filepath: string): Promise<string> {
  await mkdir(backupDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const stem = filepath.split(sep).pop() ?? 'file'
  const backupPath = backupDir + sep + stem + '.' + ts + '.bak'
  await copyFile(filepath, backupPath)
  await pruneBackups(backupDir, filepath, 50)
  return backupPath
}

async function pruneBackups(backupDir: string, filepath: string, keep: number): Promise<void> {
  try {
    const stem = filepath.split(sep).pop() ?? 'file'
    const prefix = stem + '.'
    const names = (await readdir(backupDir)).filter(name => name.startsWith(prefix) && name.endsWith('.bak')).sort().reverse()
    for (const name of names.slice(keep)) {
      await rmUnsafe(backupDir + sep + name)
    }
  } catch {
    // pruning is best-effort; never fail the edit over it
  }
}

async function rmUnsafe(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(path, { force: true })
}

/** Accepted edit modes. */
export type SafeEditMode = 'replace' | 'insert_at_line' | 'delete_lines'

export interface SafeEditRequest {
  filepath: string
  old?: string
  new?: string
  occurrence?: number
  replaceAll?: boolean
  mode?: SafeEditMode
  line?: number
  startLine?: number
  endLine?: number
}

export interface SafeEditOptions {
  root: string
  backupDir: string
  syntaxCheck?: (file: string) => Promise<{ ok: boolean; skipped: boolean; errors: unknown[] }>
}

export interface SafeEditOutcome {
  ok: boolean
  file?: string
  error?: string
  proposal?: string
  evidence?: unknown
  options?: unknown
  backup?: string
  backupDeleted?: boolean
  rolledBack?: boolean
  matches?: unknown
  occurrenceCount?: number
  syntaxOk?: boolean | null
  lineNumbersStripped?: boolean
  whitespaceAligned?: boolean
}

/**
 * One guarded edit: validate path, backup, match (exact → line-number-prefix
 * strip → whitespace-align), replace, syntax-check, auto-rollback on failure.
 */
export async function safeEdit(
  request: SafeEditRequest,
  options: SafeEditOptions,
): Promise<SafeEditOutcome> {
  let { old = '', new: newText = '', occurrence = 0, replaceAll = false } = request
  const mode: SafeEditMode = request.mode ?? 'replace'
  const filepath = resolve(request.filepath)
  const common: SafeEditOutcome = { ok: false, file: filepath }

  const pathError = checkPathAllowed(options.root, filepath)
  if (pathError !== null) return { ...common, ok: false, error: pathError }

  const stats = await stat(filepath).catch(() => undefined)
  if (stats === undefined) return { ...common, ok: false, error: '文件不存在：' + request.filepath }
  if (!stats.isFile()) return { ...common, ok: false, error: '路径不是文件：' + request.filepath }
  if (stats.size > SAFE_EDIT_MAX_SIZE) return { ...common, ok: false, error: '文件超过 5MB 上限，拒绝编辑。' }

  if (mode === 'replace' && old === '') return { ...common, ok: false, error: 'old 参数不能为空字符串（空替换会损毁文件）。' }
  if (mode === 'insert_at_line' && newText === '') return { ...common, ok: false, error: 'insert_at_line 模式 new 不能为空。' }
  if (occurrence < 0) return { ...common, ok: false, error: 'occurrence 不能为负数。' }
  if (occurrence > 0 && replaceAll) return { ...common, ok: false, error: 'occurrence 与 replace_all 不能同时使用。' }

  const raw = await readFile(filepath, 'utf8').catch(normalizeReadError(filepath))
  const hasCrlf = raw.indexOf('\r') !== -1
  let content = normalizeEol(raw)

  if (mode === 'replace') {
    let patched = old
    let oldCount = countOccurrences(content, patched)

    if (oldCount === 0) {
      const stripped = stripLineNumberPrefixes(patched)
      if (stripped !== patched && countOccurrences(content, stripped) > 0) {
        patched = stripped
        oldCount = countOccurrences(content, patched)
        common.lineNumbersStripped = true
      }
    }
    if (oldCount === 0) {
      const aligned = alignWhitespace(content, normalizeEol(patched), normalizeEol(newText))
      if (aligned !== null) {
        patched = aligned.old
        newText = aligned.newText
        oldCount = countOccurrences(content, patched)
        common.whitespaceAligned = true
      }
    }
    if (oldCount === 0) {
      return {
        ...common,
        ok: false,
        error: '未找到匹配文本，文件未修改。',
        proposal: 'old 文本未命中。可把精确文本（含缩进）作为 old 重试，或用 safe_read 确认内容后复制。',
        options: ['复制精确文本作为 old', '用 occurrence/replace_all 消歧'],
      }
    }
    if (oldCount > 1 && !replaceAll && occurrence === 0) {
      const positions = collectPositions(content, patched).map(idx => {
        const lineNum = content.slice(0, idx).split('\n').length
        const lineStart = content.lastIndexOf('\n', idx - 1) + 1
        const lineEnd = content.indexOf('\n', idx)
        const preview = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 80)
        return { line: lineNum, col: idx - lineStart + 1, preview }
      })
      return {
        ...common,
        ok: false,
        error: `old 文本出现了 ${oldCount} 次，请用 occurrence=N 指定第几次（1..${oldCount}）或 replace_all=true。`,
        proposal: '使用 occurrence=N 或 replace_all=true',
        matches: positions.slice(0, 20),
        occurrenceCount: oldCount,
      }
    }
    if (occurrence > oldCount) return { ...common, ok: false, error: `occurrence=${occurrence} 超过匹配总数 ${oldCount}。` }

    // ── backup then edit ──
    let backupPath: string
    try {
      backupPath = await backupFor(options.backupDir, filepath)
    } catch (error) {
      return { ...common, ok: false, error: '无法创建备份：' + errorMessage(error) }
    }
    common.backup = backupPath

    let next: string
    if (occurrence > 0 && !replaceAll) {
      const idx = collectPositions(content, patched)[occurrence - 1]
      next = content.slice(0, idx) + normalizeEol(newText) + content.slice(idx + patched.length)
    } else {
      next = content.split(patched).join(normalizeEol(newText))
    }
    next = hasCrlf ? next.replace(/\n/g, '\r\n') : next
    if (!(await writeGuarded(filepath, next, common))) return common

    const failed = await finishEdit(common, filepath, options)
    if (failed !== null) return failed
    return { ...common, ok: true }
  }

  // ── line-addressed modes ──
  const lines = content.split('\n')
  const totalLines = lines.length
  if (mode === 'insert_at_line') {
    const line = request.line ?? 0
    if (line < 0 || line > totalLines) {
      return { ...common, ok: false, error: `line=${line} 越界（0 ≤ line ≤ ${totalLines}）。` }
    }
    let backupPath: string
    try {
      backupPath = await backupFor(options.backupDir, filepath)
    } catch (error) {
      return { ...common, ok: false, error: '无法创建备份：' + errorMessage(error) }
    }
    common.backup = backupPath
    const insert = normalizeEol(newText)
    const nextArr = line === 0 ? [insert, ...lines] : [...lines.slice(0, line), insert, ...lines.slice(line)]
    const next = hasCrlf ? nextArr.join('\r\n') : nextArr.join('\n')
    if (!(await writeGuarded(filepath, next, common))) return common
    const failed = await finishEdit(common, filepath, options)
    if (failed !== null) return failed
    return { ...common, ok: true, evidence: { insertedAfterLine: line } }
  }
  if (mode === 'delete_lines') {
    const startLine = request.startLine ?? 0
    const endLine = request.endLine ?? 0
    if (startLine < 1 || endLine < startLine || endLine > totalLines) {
      return { ...common, ok: false, error: `行号越界：start=${startLine}, end=${endLine}，文件 ${totalLines} 行。` }
    }
    let backupPath: string
    try {
      backupPath = await backupFor(options.backupDir, filepath)
    } catch (error) {
      return { ...common, ok: false, error: '无法创建备份：' + errorMessage(error) }
    }
    common.backup = backupPath
    const nextArr = [...lines.slice(0, startLine - 1), ...lines.slice(endLine)]
    const next = hasCrlf ? nextArr.join('\r\n') : nextArr.join('\n')
    if (!(await writeGuarded(filepath, next, common))) return common
    const failed = await finishEdit(common, filepath, options)
    if (failed !== null) return failed
    return { ...common, ok: true, evidence: { deletedLines: [startLine, endLine] } }
  }

  return { ...common, ok: false, error: `非法 mode：${mode}` }
}

/** Tolerate intermediate read errors → normalize to a thrown Error message. */
function normalizeReadError(path: string) {
  return (error: unknown) => {
    throw new Error(errorMessage(error) || ('无法读取文件：' + path))
  }
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1
}

async function writeGuarded(filepath: string, next: string, common: SafeEditOutcome): Promise<boolean> {
  try {
    await atomicWriteText(filepath, next)
    return true
  } catch (error) {
    common.error = '写入失败：' + errorMessage(error)
    common.ok = false
    return false
  }
}

async function runSyntaxCheck(
  filepath: string,
  custom: SafeEditOptions['syntaxCheck'],
): Promise<{ ok: boolean; skipped: boolean; errors: unknown[] }> {
  if (custom !== undefined) return await custom(filepath)
  return await syntaxCheckFile(filepath)
}

/** Syntax gate after a successful write: on failure restore the pre-edit
 * backup. Returns a terminal failure outcome, or null to proceed. */
async function finishEdit(
  common: SafeEditOutcome,
  filepath: string,
  options: SafeEditOptions,
): Promise<SafeEditOutcome | null> {
  const check = await runSyntaxCheck(filepath, options.syntaxCheck)
  if (check.skipped) {
    common.syntaxOk = null
    return null
  }
  if (check.ok) {
    common.syntaxOk = true
    return null
  }
  common.syntaxOk = false
  const restored = await copyFile(common.backup ?? '', filepath).then(() => true).catch(() => false)
  if (restored) {
    return { ...common, ok: false, rolledBack: true, error: '语法检查失败，已自动回滚到备份：' + (common.backup ?? '') }
  }
  return { ...common, ok: false, rolledBack: false, error: '语法检查失败且回滚失败；备份：' + (common.backup ?? '') }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Restore a file from a backup; the pre-restore state is itself backed up. */
export async function safeRollback(
  filepath: string,
  backupDir: string,
  root: string,
  backupName?: string,
): Promise<{ ok: boolean; error?: string; file?: string; restoredFrom?: string; currentStateBackup?: string }> {
  const resolved = resolve(filepath)
  const pathError = checkPathAllowed(root, resolved)
  if (pathError !== null) return { ok: false, error: pathError }
  await mkdir(backupDir, { recursive: true })
  const stem = resolved.split(sep).pop() ?? 'file'
  let backupPath = backupDir + sep + (backupName ?? '')
  if (backupName === undefined || backupName === '') {
    const names = (await readdir(backupDir)).filter(name => name.startsWith(stem + '.') && name.endsWith('.bak')).sort().reverse()
    if (names.length === 0) return { ok: false, error: '没有找到该文件的备份。' }
    backupPath = backupDir + sep + names[0]
  }
  if (!(await stat(backupPath).catch(() => undefined))) return { ok: false, error: '备份不存在：' + backupName }
  const curTs = new Date().toISOString().replace(/[:.]/g, '-')
  const pre = backupDir + sep + stem + '.' + curTs + '.prerollback.bak'
  await copyFile(resolved, pre) // pre-rollback state so a bad rollback is reversible
  await copyFile(backupPath, resolved)
  return { ok: true, file: resolved, restoredFrom: backupPath, currentStateBackup: pre }
}

/** List backups for a file (all when filepath omitted). */
export async function listBackups(backupDir: string, filepath?: string): Promise<{ ok: boolean; backups: Array<{ name: string; size: number; time: string }>; total: number }> {
  await mkdir(backupDir, { recursive: true })
  const stem = filepath?.split(sep).pop()?.slice(0, 0) ?? ''
  const names = (await readdir(backupDir).catch(() => [])).filter(name => name.endsWith('.bak'))
  const filtered = filepath === undefined ? names : names.filter(name => name.startsWith((filepath.split(sep).pop() ?? 'file') + '.'))
  const items = await Promise.all(filtered.map(async name => {
    const s = await stat(backupDir + sep + name).catch(() => undefined)
    return s === undefined
      ? null
      : { name, size: s.size, time: new Date(s.mtimeMs).toISOString() }
  }))
  const backups = items.filter((item): item is NonNullable<typeof item> => item !== null).sort((a, b) => b.name.localeCompare(a.name))
  return { ok: true, backups: backups.slice(0, 50), total: backups.length }
}
