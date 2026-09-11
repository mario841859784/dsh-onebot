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

describe('findCommand (A8 PATH scan, no shell)', () => {
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
