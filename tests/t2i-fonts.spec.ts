/**
 * Font resolution tests for the t2i card renderer with a controllable font
 * collection: @napi-rs/canvas is mocked ONLY for GlobalFonts (families getter
 * + registerFromPath no-op) while createCanvas stays real, so inkCheck and
 * renderTextImage run the real Skia pipeline. Assertions are robust to
 * fontconfig fallback behavior on the host (a missing family may still render
 * '中' via fallback ink, in which case inkCheck does not shift the chain).
 * @module dsh-onebot/tests/t2i-fonts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Test-controlled font collection (the mocked GlobalFonts.families). */
const fontState = vi.hoisted(() => ({
  families: [] as Array<{ family: string }>,
}))

vi.mock(import('@napi-rs/canvas'), async importOriginal => {
  const actual = await importOriginal<typeof import('@napi-rs/canvas')>()
  const globalFonts = {
    registerFromPath: () => true,
    has: () => false,
    get families() {
      return fontState.families
    },
  }
  return {
    ...actual,
    GlobalFonts: globalFonts as unknown as typeof actual.GlobalFonts,
  }
})

import { FontManager } from '../src/t2i/fonts.js'
import { renderTextImage } from '../src/t2i/index.js'

describe('FontManager family resolution (t2i #22)', () => {
  beforeEach(() => {
    fontState.families = []
  })

  it('resolves Windows CJK candidates from the live font collection', () => {
    // Hiragino is the first static candidate so it is chosen first; whether
    // inkCheck shifts it (missing-glyph tofu) or not (fontconfig fallback
    // ink), 'Microsoft YaHei' must be present in the chain either way.
    fontState.families = [{ family: 'Hiragino Sans GB' }, { family: 'Microsoft YaHei' }]
    const font = FontManager.create()
    expect(font.cjkChain).toContain('Microsoft YaHei')
    expect(font.usable).toBe(true)
  })

  it('prefers monoFamilies over fontFamilies for code text', () => {
    fontState.families = [{ family: 'Consolas' }, { family: 'Cascadia Code' }]
    const font = FontManager.create({ monoFamilies: ['Cascadia Code'], fontFamilies: ['Consolas'] })
    expect(font.codeFamilyFor('ascii')).toBe('Cascadia Code')
  })

  it('falls back to common mono families matched in the collection', () => {
    // 'Menlo' is outside the Linux platform candidates but inside the common
    // mono fallbacks; a static CJK candidate avoids the Noto extraction path.
    fontState.families = [{ family: 'Noto Sans CJK SC' }, { family: 'Menlo' }]
    const font = FontManager.create()
    expect(font.codeFamilyFor('ascii')).toBe('Menlo')
  })

  it('appends known CJK fallbacks matched from the live collection', () => {
    // 'PingFang SC' is in no static candidate list; 'Songti SC' (a static MAC
    // candidate) is first, so a possible inkCheck shift keeps PingFang visible.
    fontState.families = [{ family: 'Songti SC' }, { family: 'PingFang SC' }]
    const font = FontManager.create()
    expect(font.cjkChain).toContain('PingFang SC')
    expect(font.usable).toBe(true)
  })

  it('renders a >150 char text as a PNG card when the collection has a CJK hit', () => {
    fontState.families = [{ family: 'Hiragino Sans GB' }, { family: 'Microsoft YaHei' }]
    const body = '这是一段超过一百五十个字符的正文，用来验证字体命中时不再降级为纯文本。'.repeat(6)
    expect(body.length).toBeGreaterThan(150)
    const png = renderTextImage(body)
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.length).toBeGreaterThan(1024)
  })
})
