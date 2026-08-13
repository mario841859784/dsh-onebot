import { describe, expect, it } from 'vitest'
import { cqUnescape, parseMessage, detectMention, parseCqString, faceToEmoji } from '../src/cq.js'

describe('cqUnescape', () => {
  it('reverses CQ attribute escaping', () => {
    expect(cqUnescape('a&amp;b')).toBe('a&b')
    expect(cqUnescape('&#91;x&#93;')).toBe('[x]')
    expect(cqUnescape('&#44;')).toBe(',')
    expect(cqUnescape('plain')).toBe('plain')
  })
})

describe('parseMessage', () => {
  it('parses a segment array with text and image', () => {
    const parsed = parseMessage(
      [
        { type: 'text', data: { text: '你好 ' } },
        { type: 'image', data: { url: 'https://example.com/a.jpg?x=1&amp;y=2' } },
      ],
      '',
    )
    expect(parsed.text).toBe('你好 [图片]')
    expect(parsed.media).toHaveLength(1)
    expect(parsed.media[0].kind).toBe('image')
  })

  it('falls back to CQ string parsing', () => {
    const parsed = parseMessage(undefined, 'hi [CQ:face,id=0] [CQ:image,url=https://x/y.png]')
    expect(parsed.text).toContain('hi')
    expect(parsed.text).toContain('😀')
    expect(parsed.media).toHaveLength(1)
  })

  it('extracts reply and forward ids', () => {
    const parsed = parseMessage(
      [
        { type: 'reply', data: { id: '123' } },
        { type: 'text', data: { text: '看看' } },
        { type: 'forward', data: { id: 'fwd-1' } },
      ],
      '',
    )
    expect(parsed.replyId).toBe('123')
    expect(parsed.forwardId).toBe('fwd-1')
  })

  it('handles at and poke segments', () => {
    const parsed = parseMessage(
      [
        { type: 'at', data: { qq: 'all' } },
        { type: 'text', data: { text: ' ' } },
        { type: 'poke', data: {} },
      ],
      '',
    )
    expect(parsed.text).toContain('@全体成员')
    expect(parsed.text).toContain('[戳一戳]')
  })
})

describe('parseCqString', () => {
  it('unescapes attribute values', () => {
    const segments = parseCqString('[CQ:image,url=https://x/a.jpg?a=1&amp;b=2]')
    expect(segments[0].data.url).toBe('https://x/a.jpg?a=1&b=2')
  })
})

describe('detectMention', () => {
  it('detects at via segments', () => {
    expect(detectMention([{ type: 'at', data: { qq: '10001' } }], '', '10001', '')).toBe(true)
    expect(detectMention([{ type: 'at', data: { qq: '999' } }], '', '10001', '')).toBe(false)
  })
  it('detects reply as mention', () => {
    expect(detectMention([{ type: 'reply', data: { id: '1' } }], '', '10001', '')).toBe(true)
  })
  it('falls back to CQ strings', () => {
    expect(detectMention(undefined, '[CQ:at,qq=10001] hi', '10001', '')).toBe(true)
    expect(detectMention(undefined, 'hi', '10001', '')).toBe(false)
  })
  it('fails closed when bot id unknown', () => {
    expect(detectMention([{ type: 'at', data: { qq: '10001' } }], '', '', '')).toBe(false)
  })
})

describe('faceToEmoji', () => {
  it('maps known and unknown ids', () => {
    expect(faceToEmoji('0')).toBe('😀')
    expect(faceToEmoji('999999')).toBe('😀')
  })
})
