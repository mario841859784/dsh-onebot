import { describe, expect, it } from 'vitest'
import { stripMarkdown, extractForwardBlocks, scanSensitive } from '../src/split.js'

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

describe('stripMarkdown underscores', () => {
  it.each([
    ['a snake_case filename', 'foo_bar_baz.py'],
    ['two filenames on one line', '改 my_file.txt 和 your_file.txt'],
    ['a CJK filename', '报告_第一版_终稿.docx'],
    ['a URL', 'https://example.com/a_b_c/d.png'],
    ['a Windows path', 'C:\\work_dir\\sub_dir\\x.txt'],
    ['a tool name', 'qq_send_image'],
    ['a constant name', 'SOME_CONST_NAME'],
    ['snake_case across lines', 'a_b\nc_d'],
    ['a leading and a trailing underscore on different lines', '_cache 目录\nclass_ 参数'],
  ])('keeps %s', (_name, text) => {
    expect(stripMarkdown(text)).toBe(text)
  })
  it('keeps underscores inside inline code', () => {
    expect(stripMarkdown('看 \x60foo_bar_baz.py\x60 这个文件')).toBe('看 foo_bar_baz.py 这个文件')
  })
  it('keeps underscores in both the text and the URL of a link', () => {
    expect(stripMarkdown('[a_b_c](https://x.io/a_b_c)')).toBe('a_b_c (https://x.io/a_b_c)')
  })
  it.each([
    ['_italic_', 'italic'],
    ['__bold__', 'bold'],
    ['这是 _斜体_ 和 __粗体__ 。', '这是 斜体 和 粗体 。'],
    ['（_斜体_），__粗体__！', '（斜体），粗体！'],
    ['第一行\n_斜体_\n__粗体__', '第一行\n斜体\n粗体'],
    ['_一_ _二_', '一 二'],
    ['__一__ __二__', '一 二'],
    ['这是 ___粗斜体___ 。', '这是 粗斜体 。'],
  ])('still strips real emphasis in %j', (text, expected) => {
    expect(stripMarkdown(text)).toBe(expected)
  })
})

describe('stripMarkdown emphasis boundaries (issue #38)', () => {
  it('keeps arithmetic asterisks intact', () => {
    expect(stripMarkdown('2*3*4 = 24')).toBe('2*3*4 = 24')
    expect(stripMarkdown('3*4*5=60')).toBe('3*4*5=60')
    expect(stripMarkdown('长 5*3 米，宽 2*4 米')).toBe('长 5*3 米，宽 2*4 米')
    expect(stripMarkdown('2**10 和 3**4')).toBe('2**10 和 3**4')
  })
  it('keeps bare SELECT asterisks, even from inline code', () => {
    expect(stripMarkdown('SELECT * FROM a; SELECT * FROM b;')).toBe('SELECT * FROM a; SELECT * FROM b;')
    expect(stripMarkdown('\x60SELECT * FROM a\x60')).toBe('SELECT * FROM a')
  })
  it('does not pair asterisks across lines', () => {
    expect(stripMarkdown('3*4=12\n5*6=30')).toBe('3*4=12\n5*6=30')
  })
  it('still strips legitimate emphasis', () => {
    expect(stripMarkdown('**粗体** 和 *斜体*')).toContain('粗体 和 斜体')
    expect(stripMarkdown('这是*斜体*文字')).toContain('这是斜体文字')
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
