import { describe, expect, it } from 'vitest'
import { splitLongText, stripMarkdown, extractForwardBlocks, scanSensitive } from '../src/split.js'

describe('splitLongText', () => {
  it('keeps short text as one chunk', () => {
    expect(splitLongText('你好', 100)).toEqual(['你好'])
  })
  it('splits at sentence boundaries', () => {
    const text = '这是第一句很长的话。这是第二句。这是第三句！'
    const chunks = splitLongText(text, 10)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })
  it('hard-cuts when no boundary is near', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const chunks = splitLongText(text, 10)
    expect(chunks.every(c => c.length <= 10)).toBe(true)
    expect(chunks.join('')).toBe(text)
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
