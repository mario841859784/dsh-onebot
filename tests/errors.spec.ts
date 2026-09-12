/**
 * M3-E3a: the shared error-exit formatter (errors.ts) — message extraction,
 * cause-chain joining and the error-level stack suffix.
 * @module dsh-onebot/tests/errors
 */
import { describe, expect, it } from 'vitest'

import { describeError, errorStack } from '../src/errors.js'

describe('describeError', () => {
  it('extracts the message from an Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('stringifies non-Error values', () => {
    expect(describeError('plain failure')).toBe('plain failure')
    expect(describeError(42)).toBe('42')
    expect(describeError(undefined)).toBe('undefined')
  })

  it('joins a cause chain', () => {
    const root = new Error('disk full')
    const middle = new Error('write failed', { cause: root })
    const top = new Error('save failed', { cause: middle })
    expect(describeError(top)).toBe('save failed (cause: write failed (cause: disk full))')
  })

  it('treats a non-Error cause as its stringified value', () => {
    expect(describeError(new Error('wrapped', { cause: 'raw string' }))).toBe('wrapped (cause: raw string)')
  })

  it('caps a self-referencing cause chain instead of hanging', () => {
    const loop: Error = new Error('loop')
    ;(loop as { cause?: unknown }).cause = loop
    expect(describeError(loop)).toBe('loop' + ' (cause: loop'.repeat(5) + ')'.repeat(5))
  })
})

describe('errorStack', () => {
  it('returns the newline-prefixed stack for Errors', () => {
    const error = new Error('boom')
    expect(errorStack(error)).toBe('\n' + error.stack)
  })

  it('returns an empty suffix for non-Error values', () => {
    expect(errorStack('nope')).toBe('')
    expect(errorStack(undefined)).toBe('')
  })
})
