/**
 * Font manager for the t2i card renderer (port of t2i_render.py's
 * _FONT_FALLBACK_PATHS / build_font_chain / _resolve_font / _is_emoji).
 *
 * Skia's canvas resolves font FAMILY NAMES on macOS from the auto-loaded
 * system fonts (Hiragino Sans GB / Songti SC / Menlo / Apple Color Emoji),
 * but silently falls back to tofu when a named family is missing (PingFang
 * SC is NOT available on macOS 26), so every character class is drawn with
 * an explicitly chosen family and measured with the SAME family
 * (measure == draw is the renderer's iron rule, T2I_DEV_DOC §5.1).
 * @module dsh-onebot/t2i/fonts
 */

import { GlobalFonts, createCanvas } from '@napi-rs/canvas'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

/** Character classes for font selection (mirrors _is_emoji / _code_font_for). */
export type CharClass = 'emoji' | 'zwj' | 'ascii' | 'cjk'

/** Zero-width codepoints: variation selector FE0F and ZWJ 200D. */
function isZeroWidth(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return cp === 0xFE0F || cp === 0x200D
}

/** Emoji ranges used by the Python original (no flags/ZWJ composition). */
function isEmojiCp(cp: number): boolean {
  if (cp >= 0x1F000 && cp <= 0x1FAFF) return true
  if (cp >= 0x2600 && cp <= 0x27BF) return true
  if (cp >= 0x2B00 && cp <= 0x2BFF) return true
  if (cp === 0x00A9 || cp === 0x00AE || cp === 0x2122) return true
  return false
}

/**
 * Classify one character for font selection. The emoji font never enters
 * the CJK chain (its cmap contains digits; same trap as the original).
 * @param ch - single character.
 * @returns the class.
 */
export function classifyChar(ch: string): CharClass {
  if (ch === '') return 'cjk'
  if (isZeroWidth(ch)) return 'zwj'
  const cp = ch.codePointAt(0) ?? 0
  if (isEmojiCp(cp)) return 'emoji'
  // Python's mono rule: ord < 0x2E80 (Latin/digits/symbols) uses the mono font
  // in code context; everything else is CJK-class.
  if (cp < 0x2E80) return 'ascii'
  return 'cjk'
}

/** Configuration for font discovery. */
export interface FontConfig {
  /** Font files to register (Linux deployments, custom fonts). */
  fontFiles?: readonly string[]
  /** Preferred family names, tried before platform defaults. */
  fontFamilies?: readonly string[]
}

/** System families verified present on macOS 26 (auto-loaded by the addon). */
const MAC_CJK_CANDIDATES = ['Hiragino Sans GB', 'Songti SC', 'STHeiti', 'Arial Unicode MS']
const MAC_MONO_CANDIDATES = ['Menlo', 'SF Mono', 'Courier New']
const MAC_EMOJI_CANDIDATES = ['Apple Color Emoji', 'Noto Color Emoji']
/** Extra family names that may appear after registering Noto on Linux. */
const LINUX_CJK_FAMILIES = ['Noto Sans CJK SC', 'Noto Sans SC', 'WenQuanYi Zen Hei', 'WenQuanYi Micro Hei', 'Unifont']

/** Linux candidate font FILES (the original Hermes chain + DejaVu mono). */
const LINUX_CJK_FILES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/opentype/unifont/unifont.otf',
  '/usr/share/fonts/opentype/unifont/unifont_upper.otf',
]
const LINUX_MONO_FILES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/opentype/urw-base35/NimbusMonoPS-Regular.otf',
]
const LINUX_EMOJI_FILES = ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf']

/**
 * The font manager: platform family resolution, per-character-class family
 * lookup, and a width cache. One instance per plugin (lazy init).
 */
export class FontManager {
  private readonly cjkFamilies: string[] = []
  private monoFamily: string | undefined
  private emojiFamily: string | undefined
  private readonly widthCache = new Map<string, number>()
  private readonly measureCtx = createCanvas(4, 4).getContext('2d')
  private usableFlag = false
  private inkChecked = false

  /** Build a manager from config (registering files first). */
  static create(config: FontConfig = {}): FontManager {
    const manager = new FontManager()
    manager.init(config)
    return manager
  }

  /** Whether at least one CJK family is usable. */
  get usable(): boolean {
    return this.usableFlag
  }

  /** The resolved CJK family chain (fallback order). */
  get cjkChain(): readonly string[] {
    return this.cjkFamilies
  }

  /** Family for a character class in body text. */
  familyFor(cls: CharClass): string | undefined {
    if (cls === 'emoji') return this.emojiFamily
    return this.cjkFamilies[0]
  }

  /** Family for a character class in code text (mono for ASCII). */
  codeFamilyFor(cls: CharClass): string | undefined {
    if (cls === 'emoji') return this.emojiFamily
    if (cls === 'ascii') return this.monoFamily ?? this.cjkFamilies[0]
    return this.cjkFamilies[0]
  }

  /**
   * Cached width of one character with a family at a size.
   * @param ch - the character.
   * @param family - resolved family name.
   * @param size - font size in px.
   * @returns width in px.
   */
  charWidth(ch: string, family: string, size: number): number {
    const key = 'w|' + family + '|' + size + '|' + ch
    const cached = this.widthCache.get(key)
    if (cached !== undefined) return cached
    this.measureCtx.font = size + 'px "' + family + '"'
    const width = this.measureCtx.measureText(ch).width
    this.widthCache.set(key, width)
    return width
  }

  /**
   * Font ascent (alphabetic baseline offset) for line layout.
   * @param family - resolved family name.
   * @param size - font size in px.
   * @returns ascent in px.
   */
  ascent(family: string, size: number): number {
    const key = 'a|' + family + '|' + size
    const cached = this.widthCache.get(key)
    if (cached !== undefined) return cached
    this.measureCtx.font = size + 'px "' + family + '"'
    const ascent = this.measureCtx.measureText('中').fontBoundingBoxAscent
    this.widthCache.set(key, ascent)
    return ascent
  }

  /**
   * Font descent for vertical centering.
   * @param family - resolved family name.
   * @param size - font size in px.
   * @returns descent in px.
   */
  descent(family: string, size: number): number {
    const key = 'd|' + family + '|' + size
    const cached = this.widthCache.get(key)
    if (cached !== undefined) return cached
    this.measureCtx.font = size + 'px "' + family + '"'
    const descent = this.measureCtx.measureText('中').fontBoundingBoxDescent
    this.widthCache.set(key, descent)
    return descent
  }

  /**
   * Emoji width at a size (1 em for color fonts).
   * @param size - target size in px.
   * @returns width in px (0 when no color emoji family).
   */
  emojiWidth(size: number): number {
    if (this.emojiFamily === undefined) return 0
    return this.charWidth('😀', this.emojiFamily, size)
  }

  /**
   * Ink self-check: render '中' at 40px with the primary CJK family and count
   * dark pixels. A missing family renders a hollow tofu box, which would
   * silently corrupt every card, so unusable families are dropped.
   */
  private inkCheck(): void {
    if (this.inkChecked) return
    this.inkChecked = true
    const family = this.cjkFamilies[0]
    if (family === undefined) return
    const canvas = createCanvas(60, 60)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 60, 60)
    ctx.font = '40px "' + family + '"'
    ctx.fillStyle = '#000000'
    ctx.fillText('中', 5, 45)
    const data = ctx.getImageData(0, 0, 60, 60).data
    let ink = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 128) ink += 1
    }
    // A real CJK glyph at 40px has well over 600 dark pixels; a hollow
    // fallback box stays far below that (measured ~224 for a missing family).
    if (ink < 600) {
      this.cjkFamilies.shift()
    }
  }

  private init(config: FontConfig): void {
    // 1. Register user-supplied font files (Linux deployments, custom fonts).
    for (const file of config.fontFiles ?? []) {
      if (existsSync(file)) GlobalFonts.registerFromPath(file)
    }
    // 2. On Linux (no system font auto-load), register the candidate files.
    if (process.platform !== 'darwin') {
      for (const file of [...LINUX_CJK_FILES, ...LINUX_MONO_FILES, ...LINUX_EMOJI_FILES]) {
        if (existsSync(file)) GlobalFonts.registerFromPath(file)
      }
    }
    // 3. Resolve families against what the font collection actually exposes.
    const available = new Set(GlobalFonts.families.map(f => f.family))
    const firstAvailable = (candidates: readonly string[]): string | undefined => {
      for (const name of candidates) {
        if (available.has(name)) return name
      }
      return undefined
    }
    const preferred = config.fontFamilies ?? []
    const cjkFirst = firstAvailable([...preferred, ...MAC_CJK_CANDIDATES, ...LINUX_CJK_FAMILIES])
    // 4. Noto CJK ttc on Linux: the registered default face may be JP/Mono;
    //    extract the CJK SC face with fontkit into a temp ttf and register it.
    if (cjkFirst === undefined && process.platform !== 'darwin') {
      this.extractNotoScFace()
    }
    if (cjkFirst !== undefined) this.cjkFamilies.push(cjkFirst)
    for (const name of [...MAC_CJK_CANDIDATES, ...LINUX_CJK_FAMILIES]) {
      if (name !== cjkFirst && available.has(name) && !this.cjkFamilies.includes(name)) {
        this.cjkFamilies.push(name)
      }
    }
    this.monoFamily = firstAvailable([...preferred, ...MAC_MONO_CANDIDATES])
    this.emojiFamily = firstAvailable([...preferred, ...MAC_EMOJI_CANDIDATES])
    this.inkCheck()
    this.usableFlag = this.cjkFamilies.length > 0
  }

  /** fontkit: extract the "CJK SC" face from NotoSansCJK-Regular.ttc. */
  private extractNotoScFace(): void {
    try {
      // fontkit's ESM entry is the browser build; load the Node build lazily
      // via require (only reached on Linux).
      const require = createRequire(import.meta.url)
      const fontkit = require('fontkit') as {
        openSync(path: string): { fonts?: Array<{
          postscriptName?: string
          characterSet: Iterable<number>
          glyphForCodePoint(cp: number): unknown
          createSubset(): { includeGlyph(g: unknown): void; encode(): Buffer }
        }> }
      }
      for (const file of LINUX_CJK_FILES) {
        if (!existsSync(file)) continue
        const opened = fontkit.openSync(file) as { fonts?: Array<{
          postscriptName?: string
          characterSet: Iterable<number>
          glyphForCodePoint(cp: number): unknown
          createSubset(): { includeGlyph(g: unknown): void; encode(): Buffer }
        }> }
        const faces = opened.fonts
        if (!Array.isArray(faces)) continue
        for (const face of faces) {
          const name = face.postscriptName ?? ''
          if (name.includes('SC') && !name.includes('Mono')) {
            const subset = face.createSubset()
            for (const cp of face.characterSet) {
              subset.includeGlyph(face.glyphForCodePoint(cp))
            }
            const dir = mkdtempSync(join(tmpdir(), 'dsh-onebot-font-'))
            const out = join(dir, name + '.ttf')
            writeFileSync(out, subset.encode())
            GlobalFonts.registerFromPath(out, name)
            this.cjkFamilies.push(name)
            return
          }
        }
        break
      }
    } catch (error) {
      console.warn('[dsh-onebot] Noto SC face extraction failed:', error instanceof Error ? error.message : String(error))
    }
  }
}
