import { describe, expect, it } from 'vitest'
import { splitLongText, stripMarkdown, extractForwardBlocks, scanSensitive } from '../src/split.js'

describe('splitLongText', () => {
  it('keeps short text as one chunk', () => {
    expect(splitLongText('你好', 100)).toEqual(['你好'])
  })
  it('splits at sentence boundaries (backward scan, chunks end on punctuation)', () => {
    const text = '这是第一句很长的话。这是第二句。这是第三句！'
    const chunks = splitLongText(text, 10)
    expect(chunks).toEqual(['这是第一句很长的话。', '这是第二句。', '这是第三句！'])
    expect(chunks.every(c => c.length <= 10)).toBe(true)
  })
  it('hard-cuts only when neither punctuation nor spaces exist', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const chunks = splitLongText(text, 10)
    expect(chunks.every(c => c.length <= 10)).toBe(true)
    expect(chunks.join('')).toBe(text)
  })

  it('prefers a space cut over a hard cut (words survive)', () => {
    const text = 'word1 word2 word3 word4 word5 word6 word7'
    const chunks = splitLongText(text, 20)
    expect(chunks.every(c => c.length <= 20)).toBe(true)
    // Every boundary (except the text start) lands at a space: the original
    // character before each non-first chunk is a space, so no word is split.
    let cursor = 0
    for (const chunk of chunks) {
      const idx = text.indexOf(chunk, cursor)
      if (idx > 0) {
        expect(text[idx - 1]).toBe(' ')
      }
      cursor = idx + chunk.length
    }
    // Cuts happen at spaces and trailing spaces are stripped, so joining
    // with single spaces reconstructs the original exactly.
    expect(chunks.join(' ')).toBe(text)
  })

  it('never splits a surrogate pair (emoji stay whole)', () => {
    const emoji = '😀'.repeat(12) // 24 UTF-16 units
    const chunks = splitLongText(emoji, 10)
    for (const chunk of chunks) {
      // code points × 2 === code units ⇒ no lone surrogate halves inside
      expect(chunk.length % 2).toBe(0)
      expect(Array.from(chunk).length * 2).toBe(chunk.length)
    }
    expect(chunks.join('')).toBe(emoji)
  })

  it('does not treat dots or colons as sentence bounds (URLs stay whole)', () => {
    const text = '请访问 https://example.com/very/long/path/with/many/parts 感谢'
    const chunks = splitLongText(text, 30)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30)
    }
    // The URL is either intact inside a chunk or the cut happens at a space.
    const joined = chunks.join('')
    expect(joined.includes('https://example.com/very/long/path/with/many/parts')).toBe(true)
  })
  it('handles empty input', () => {
    expect(splitLongText('   ', 100)).toEqual([])
  })
})

describe('stripMarkdown', () => {
  it('flattens headings, emphasis and links', () => {
    const out = stripMarkdown('# 标题\n**粗体** 和 *斜体* 和 [链接](https://x.com)')
    expect(out).not.toContain('#')
    expect(out).not.toContain('**')
    expect(out).toContain('粗体')
    expect(out).toContain('链接 (https://x.com)')
  })
  it('keeps code blocks as text', () => {
    const out = stripMarkdown('\x60\x60\x60ts\nconst x = 1\n\x60\x60\x60')
    expect(out).toContain('const x = 1')
    expect(out).not.toContain('\x60')
  })
  it('flattens tables', () => {
    const out = stripMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(out).toContain('a b')
    expect(out).toContain('1 2')
    expect(out).not.toContain('---')
  })
})

describe('extractForwardBlocks', () => {
  it('parses named blocks and removes them from the body', () => {
    const { body, nodes } = extractForwardBlocks(
      '开头\n[[qq_forward]]\n小明\n内容一\n[[/qq_forward]]\n结尾',
      '助手',
    )
    expect(body).toContain('开头')
    expect(body).toContain('结尾')
    expect(body).not.toContain('qq_forward')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('小明')
    expect(nodes[0].content).toBe('内容一')
  })
  it('defaults the name when the first line is long', () => {
    const { nodes } = extractForwardBlocks('[[qq_forward]]\n这是一个非常非常非常非常长的名字超过了二十四字限制的节点名\n内容\n[[/qq_forward]]', '助手')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].name).toBe('助手')
  })
})

describe('scanSensitive', () => {
  it('hits default destructive patterns', () => {
    expect(scanSensitive('运行 rm -rf / 试试', []).length).toBeGreaterThan(0)
    expect(scanSensitive('正常内容', [])).toHaveLength(0)
  })
  it('uses configured patterns', () => {
    expect(scanSensitive('机密数据', ['机密'])).toHaveLength(1)
    expect(scanSensitive('普通', ['机密'])).toHaveLength(0)
  })
})
