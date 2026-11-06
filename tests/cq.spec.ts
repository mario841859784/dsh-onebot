import { describe, expect, it } from 'vitest'
import type { OneBotSegment } from '../src/cq.js'
import { cqUnescape, parseMessage, detectExplicitMention, detectMention, parseCqString, faceToEmoji, stripLeadingBotMention } from '../src/cq.js'

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

  it('falls back to resId when a forward segment carries no id', () => {
    const parsed = parseMessage(
      [{ type: 'forward', data: { resId: 'res-9' } }],
      '',
    )
    expect(parsed.forwardId).toBe('res-9')
    expect(parsed.text).toBe('[合并转发]')
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
  it('fails closed for a reply without an author in arrays and CQ strings', () => {
    expect(detectMention([{ type: 'reply', data: { id: '1' } }], '', '10001', '')).toBe(false)
    expect(detectMention(undefined, '[CQ:reply,id=1] hello', '10001', '')).toBe(false)
    expect(detectMention(undefined, '[CQ:reply,id=1][CQ:at,qq=999] hello', '10001', '')).toBe(false)
  })
  it('A8: reply mentions only when it determinably replies to the bot itself', () => {
    // Replied-to user qq == learned selfId → mention.
    expect(detectMention([{ type: 'reply', data: { id: '1', qq: '10001' } }], '', '10001', '')).toBe(true)
    // selfId unknown but qq == configured botQQ → mention (same bot-id resolution).
    expect(detectMention([{ type: 'reply', data: { id: '1', qq: '10002' } }], '', '', '10002')).toBe(true)
    // Replied-to user is someone else → not a mention.
    expect(detectMention([{ type: 'reply', data: { id: '1', qq: '999' } }], '', '10001', '')).toBe(false)
  })
  it('falls back to CQ strings', () => {
    expect(detectMention(undefined, '[CQ:at,qq=10001] hi', '10001', '')).toBe(true)
    expect(detectMention(undefined, 'hi', '10001', '')).toBe(false)
  })
  it('fails closed when bot id unknown', () => {
    expect(detectMention([{ type: 'at', data: { qq: '10001' } }], '', '', '')).toBe(false)
    expect(detectMention([{ type: 'reply', data: { id: '1' } }], '', '', '')).toBe(false)
  })
})

describe('detectExplicitMention', () => {
  it('never treats a reply as an explicit @, even when its qq names the bot', () => {
    expect(detectExplicitMention([{ type: 'reply', data: { id: '1', qq: '10001' } }], '', '10001', '')).toBe(false)
  })
  it('preserves explicit @bot and @all triggers in both message formats', () => {
    for (const qq of ['10001', 'all']) {
      expect(detectExplicitMention([{ type: 'at', data: { qq } }], '', '10001', '')).toBe(true)
      expect(detectExplicitMention(undefined, `[CQ:at,qq=${qq}] hi`, '', '10001')).toBe(true)
    }
  })
})

describe('stripLeadingBotMention', () => {
  const at = (qq: string) => ({ type: 'at', data: { qq } })
  const text = (value: string) => ({ type: 'text', data: { text: value } })
  /** Strip with the text parseMessage produces for this same message. */
  const strip = (segments: OneBotSegment[] | undefined, raw: string, selfId = '10002', botQQ = '') =>
    stripLeadingBotMention(parseMessage(segments, raw).text, segments, raw, selfId, botQQ)

  it('keeps a digit glued to the mention, in both message formats', () => {
    expect(strip([at('10002'), text('1')], '')).toBe('1')
    expect(strip([at('10002'), text('1 2')], '')).toBe('1 2')
    expect(strip(undefined, '[CQ:at,qq=10002]1')).toBe('1')
    expect(strip([], '[CQ:at,qq=10002]1')).toBe('1')
  })

  it('falls back to botQQ while selfId is unknown', () => {
    expect(strip([at('10002'), text('1')], '', '', '10002')).toBe('1')
  })

  it('leaves every other message alone', () => {
    expect(strip([at('20003'), text(' 1')], '')).toBe('@20003 1')
    expect(strip([at('100021')], '')).toBe('@100021')
    expect(strip([at('all'), text(' 1')], '')).toBe('@全体成员 1')
    expect(strip([text('1 '), at('10002')], '')).toBe('1 @10002')
    expect(strip([at('20003'), at('10002'), text(' 1')], '')).toBe('@20003@10002 1')
    expect(strip([text('@10002 1')], '')).toBe('@10002 1')
    expect(strip([at('10002'), text('1')], '', '', '')).toBe('@100021')
  })
})

describe('faceToEmoji', () => {
  it('maps known and unknown ids', () => {
    expect(faceToEmoji('0')).toBe('😀')
    expect(faceToEmoji('999999')).toBe('😀')
  })
})
