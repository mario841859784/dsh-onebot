/**
 * A8: findCommand must probe PATH by direct access() checks — no `sh -c`
 * involved, so the configured name is never shell-interpreted. Every case
 * points PATH at temp dirs, keeping the probe hermetic regardless of what
 * the host has installed (the x-bit cases need POSIX semantics).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findCommand } from '../src/stt.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

// POSIX semantics: extensionless programs and the x bit (Windows has neither; see below)
describe.skipIf(process.platform === 'win32')('findCommand (A8 PATH scan, no shell)', () => {
  it('returns the absolute path of an executable match on PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-find-hit-'))
    const program = join(dir, 'fake-whisper')
    await writeFile(program, '#!/bin/sh\nexit 0\n')
    await chmod(program, 0o755)
    vi.stubEnv('PATH', dir)
    await expect(findCommand('fake-whisper')).resolves.toBe(program)
  })

  it('returns undefined when PATH points at an empty dir', async () => {
    vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'stt-find-empty-')))
    await expect(findCommand('fake-whisper')).resolves.toBeUndefined()
  })

  it('skips a non-executable file and keeps scanning the next dir', async () => {
    const noExec = mkdtempSync(join(tmpdir(), 'stt-find-noexec-'))
    const exec = mkdtempSync(join(tmpdir(), 'stt-find-exec-'))
    await writeFile(join(noExec, 'fake-whisper'), 'plain data, no x bit')
    await chmod(join(noExec, 'fake-whisper'), 0o644)
    const program = join(exec, 'fake-whisper')
    await writeFile(program, '#!/bin/sh\nexit 0\n')
    await chmod(program, 0o755)

    // A dir holding only a non-executable match must not satisfy the probe...
    vi.stubEnv('PATH', noExec)
    await expect(findCommand('fake-whisper')).resolves.toBeUndefined()

    // ...but the scan must continue into later dirs and find the real one.
    vi.stubEnv('PATH', noExec + ':' + exec)
    await expect(findCommand('fake-whisper')).resolves.toBe(program)
  })
})

// Windows: only what a shell-less spawn can start, resolved the way libuv does
describe.runIf(process.platform === 'win32')('findCommand on Windows (.com/.exe, no PATHEXT)', () => {
  it('finds ffmpeg.exe when asked for ffmpeg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-find-win-'))
    const program = join(dir, 'ffmpeg.exe')
    await writeFile(program, '')
    vi.stubEnv('PATH', dir)
    await expect(findCommand('ffmpeg')).resolves.toBe(program)
  })

  it('takes a name that already has an extension as given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-find-win-exact-'))
    await writeFile(join(dir, 'whisper-cli.exe'), '')
    vi.stubEnv('PATH', dir)
    await expect(findCommand('whisper-cli.exe')).resolves.toBe(join(dir, 'whisper-cli.exe'))
  })

  it('ignores .bat/.cmd and the extensionless npm shim even when PATHEXT lists them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-find-win-shim-'))
    for (const f of ['whisper', 'whisper.cmd', 'whisper.bat', 'whisper.ps1']) await writeFile(join(dir, f), '')
    vi.stubEnv('PATH', dir)
    vi.stubEnv('PATHEXT', '.CMD;.BAT;.COM;.EXE')
    // before: 'whisper' (a sh script) matched first, and spawn could not start it;
    // a .cmd-only tool now reads as "not found on PATH" rather than spawn EINVAL
    await expect(findCommand('whisper')).resolves.toBeUndefined()

    await writeFile(join(dir, 'whisper.exe'), '')
    await expect(findCommand('whisper')).resolves.toBe(join(dir, 'whisper.exe'))
  })

  it('tries .com before .exe in a dir, and an earlier PATH dir before a later one', async () => {
    const first = mkdtempSync(join(tmpdir(), 'stt-find-win-first-'))
    const later = mkdtempSync(join(tmpdir(), 'stt-find-win-later-'))
    await writeFile(join(first, 'ffmpeg.exe'), '')
    await writeFile(join(later, 'ffmpeg.com'), '')
    vi.stubEnv('PATH', first + ';' + later)
    await expect(findCommand('ffmpeg')).resolves.toBe(join(first, 'ffmpeg.exe'))

    await writeFile(join(first, 'ffmpeg.com'), '')
    await expect(findCommand('ffmpeg')).resolves.toBe(join(first, 'ffmpeg.com'))
  })
})
