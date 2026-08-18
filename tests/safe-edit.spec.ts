import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeEdit, safeRollback, listBackups, alignWhitespace, stripLineNumberPrefixes, checkPathAllowed } from '../src/safe-edit.js'

async function fixtureFile(content: string): Promise<{ root: string; file: string; backups: string }> {
  const root = mkdtempSync(join(tmpdir(), 'safeedit-'))
  const file = join(root, 'sample.txt')
  await writeFile(file, content, 'utf8')
  const backups = join(root, '.backups')
  return { root, file, backups }
}

describe('safe-edit', () => {
  it('exact replace works and leaves a backup', async () => {
    const { root, file, backups } = await fixtureFile('第一行\n第二行\n第三行\n')
    const out = await safeEdit({ filepath: file, old: '第二行', new: '改过了' }, { root, backupDir: backups })
    expect(out.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('第一行\n改过了\n第三行\n')
    expect((await readdir(backups)).some(n => n.endsWith('.bak'))).toBe(true)
  })

  it('whitespace-aligned fallback matches when indentation differs', async () => {
    const { root, file, backups } = await fixtureFile('if (x) {\n    foo()\n    bar()\n}\n')
    const out = await safeEdit(
      { filepath: file, old: 'foo()\nbar()', new: 'baz()' },
      { root, backupDir: backups },
    )
    expect(out.ok).toBe(true)
    expect(out.whitespaceAligned).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('if (x) {\n    baz()\n}\n')
  })

  it('strips safe-read line-number prefixes when needed', async () => {
    const { root, file, backups } = await fixtureFile('alpha\nbeta\n')
    const out = await safeEdit(
      { filepath: file, old: '  2│ alpha\n  3│ beta', new: 'gamma' },
      { root, backupDir: backups },
    )
    expect(out.ok).toBe(true)
    expect(out.lineNumbersStripped).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('gamma\n')
  })

  it('rejects multi-match unless occurrence / replace_all is given', async () => {
    const { root, file, backups } = await fixtureFile('x = 1\nx = 2\nx = 3\n')
    const out = await safeEdit({ filepath: file, old: 'x = ', new: 'y = ' }, { root, backupDir: backups })
    expect(out.ok).toBe(false)
    expect(out.occurrenceCount).toBe(3)
    expect(out.matches).toHaveLength(3)

    const second = await safeEdit({ filepath: file, old: 'x = ', new: 'y = ', occurrence: 2 }, { root, backupDir: backups })
    expect(second.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('x = 1\ny = 2\nx = 3\n')

    const third = await safeEdit({ filepath: file, old: 'x = ', new: 'z = ', occurrence: 99 }, { root, backupDir: backups })
    expect(third.ok).toBe(false)
  })

  it('insert_at_line and delete_lines modes', async () => {
    const { root, file, backups } = await fixtureFile('a\nb\nc\n')
    const ins = await safeEdit({ filepath: file, mode: 'insert_at_line', line: 1, new: 'BETWEEN' }, { root, backupDir: backups })
    expect(ins.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('a\nBETWEEN\nb\nc\n')

    const del = await safeEdit({ filepath: file, mode: 'delete_lines', startLine: 1, endLine: 2 }, { root, backupDir: backups })
    expect(del.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('b\nc\n')
  })

  it('rejects paths outside the editable root and empty roots', async () => {
    const { root, file, backups } = await fixtureFile('content\n')
    const other = mkdtempSync(join(tmpdir(), 'safeedit-out-'))
    const outside = await safeEdit({ filepath: join(other, 'x.txt'), old: 'x', new: 'y' }, { root, backupDir: backups })
    expect(outside.ok).toBe(false)
    expect(String(outside.error ?? '')).toContain('超出')

    const noRoot = await safeEdit({ filepath: file, old: 'content', new: 'z' }, { root: '', backupDir: backups })
    expect(noRoot.ok).toBe(false)
    expect(String(noRoot.error ?? '')).toContain('未配置')
  })

  it('rolls back on syntax-check failure and keeps the backup', async () => {
    const { root, file, backups } = await fixtureFile('function ok() { return 1 }\n')
    const failing = async () => ({ ok: false, skipped: false, errors: [{ msg: 'SyntaxError: missing )' }] })
    const out = await safeEdit({ filepath: file, old: 'function ok()', new: 'function broken(' }, { root, backupDir: backups, syntaxCheck: failing })
    expect(out.ok).toBe(false)
    expect(out.rolledBack).toBe(true)
    // File restored to the pre-edit content.
    expect(await readFile(file, 'utf8')).toBe('function ok() { return 1 }\n')
  })

  it('safeRollback restores a file from its backup', async () => {
    const { root, file, backups } = await fixtureFile('原始内容\n')
    await safeEdit({ filepath: file, old: '原始内容', new: '改坏了' }, { root, backupDir: backups })
    expect(await readFile(file, 'utf8')).toBe('改坏了\n')
    const rb = await safeRollback(file, backups, root)
    expect(rb.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('原始内容\n')
    expect((await listBackups(backups, file)).total).toBeGreaterThan(0)
  })

  it('path guard helper rejects traversal and symlinked escapes', () => {
    expect(checkPathAllowed('/root', '/root/sub/file.ts')).toBeNull()
    expect(String(checkPathAllowed('/root', '/root/../etc/passwd') ?? '')).not.toBe('')
    expect(String(checkPathAllowed('/root', '/etc/passwd') ?? '')).not.toBe('')
  })

  it('alignWhitespace and stripLineNumberPrefixes are pure helpers', () => {
    expect(alignWhitespace('a\n  foo\n  bar\n', 'foo\nbar', 'baz')).toEqual({ old: '  foo\n  bar', newText: '  baz' })
    expect(stripLineNumberPrefixes('  12│ hello\n  13│ world')).toBe('hello\nworld')
  })
})
