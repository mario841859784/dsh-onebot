import { describe, expect, it } from 'vitest'
import type { InlinePart, WidthSource } from '../src/t2i/measure.js'
import { HEAD_BANNED, codeWidth, segWidth, splitInlineLines, splitToFit, textWidth } from '../src/t2i/measure.js'

/** Deterministic width: ASCII = 1, CJK = 2, space = 0.5 (no real fonts). */
const stub: WidthSource = {
  charWidth(ch, _size, _code) {
    if (ch === ' ') return 0.5
    if (ch.codePointAt(0)! < 0x2E80) return 1
    return 2
  },
}

describe('splitToFit', () => {
  it('hard-cuts without spaces', () => {
    const lines = splitToFit('abcdefgh', 4, c => stub.charWidth(c, 26, false))
    expect(lines).toEqual(['abcd', 'efgh'])
  })

  it('prefers breaking at the last space', () => {
    const lines = splitToFit('ab cd ef', 4, c => stub.charWidth(c, 26, false))
    expect(lines).toEqual(['ab', 'cd', 'ef'])
  })

  it('carries a banned punctuation with its host char', () => {
    // 一二三四五 (5×2=10) then ， would overflow maxWidth 10 → carry 五，
    const lines = splitToFit('一二三四五，六七', 10, c => stub.charWidth(c, 26, false))
    expect(lines).toEqual(['一二三四', '五，六七'])
    for (const line of lines) {
      expect(HEAD_BANNED.has(line[0])).toBe(false)
    }
  })

  it('keeps every line within budget except banned folds', () => {
    const text = '这是一个很长的句子，用来测试各种换行情况。Second sentence here.'
    const lines = splitToFit(text, 20, c => stub.charWidth(c, 26, false))
    for (const line of lines) {
      let w = 0
      for (const ch of line) w += stub.charWidth(ch, 26, false)
      // banned-fold lines may exceed by one char; others must fit
      if (!HEAD_BANNED.has(line[line.length - 1] ?? '')) {
        expect(w).toBeLessThanOrEqual(20)
      }
    }
    // Content is preserved modulo spaces eaten by space-backtracking
    // (the original drops the break space), so compare space-stripped text.
    expect(lines.join('').replaceAll(' ', '')).toBe(text.replaceAll(' ', ''))
  })
})

describe('textWidth / codeWidth / segWidth', () => {
  it('sums plain widths', () => {
    expect(textWidth(stub, 'ab 中', 26)).toBe(1 + 1 + 0.5 + 2)
  })
  it('segWidth adds style extras', () => {
    expect(segWidth({ cls: null, content: 'ab' }, stub, 26)).toBe(2)
    expect(segWidth({ cls: 'bold', content: 'ab' }, stub, 26)).toBe(3)
    expect(segWidth({ cls: 'italic', content: 'ab' }, stub, 26)).toBe(10)
    expect(segWidth({ cls: 'code', content: 'ab' }, stub, 26)).toBe(codeWidth(stub, 'ab', 26) + 14)
  })
})

describe('splitInlineLines', () => {
  it('wraps styled segments whole', () => {
    const parts: InlinePart[] = [
      { cls: null, content: 'plain text here' },
      { cls: 'code', content: 'longCodeSegment' },
    ]
    const lines = splitInlineLines(parts, 30, stub, 26)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      const w = line.reduce((acc, p) => acc + segWidth(p, stub, 26), 0)
      expect(w).toBeLessThanOrEqual(30)
    }
  })

  it('sheds a leading punctuation prefix onto the previous line', () => {
    const parts: InlinePart[] = [
      { cls: null, content: '一段文本' },
      { cls: null, content: '，续句' },
    ]
    const lines = splitInlineLines(parts, 12, stub, 26)
    expect(lines.length).toBeGreaterThan(1)
    // no line starts with a banned char
    for (const line of lines) {
      const first = line[0]?.content[0] ?? ''
      expect(HEAD_BANNED.has(first)).toBe(false)
    }
  })

  it('merges adjacent same-class segments', () => {
    const parts: InlinePart[] = [
      { cls: 'code', content: 'ab' },
      { cls: 'code', content: 'cd' },
    ]
    const lines = splitInlineLines(parts, 100, stub, 26)
    expect(lines[0]).toHaveLength(1)
    expect(lines[0][0].content).toBe('abcd')
  })

  it('normalizes newlines inside content to spaces', () => {
    const lines = splitInlineLines([{ cls: null, content: 'a\nb' }], 100, stub, 26)
    expect(lines[0][0].content).toBe('a b')
  })
})
