/**
 * Skia canvas wrapper for the t2i card renderer. Mirrors the Python drawing
 * primitives (_draw_runs / _draw_code_text) with the character-class run
 * model: every run is drawn with its explicitly chosen family and advanced by
 * the SUM of per-character widths measured with the SAME family
 * (measure == draw is the renderer's iron rule, T2I_DEV_DOC §5.1).
 *
 * Text drawing convention (PIL-compatible): y is the ASCENDER line of the
 * line box; text is drawn at baseline y + fontAscent.
 * @module dsh-onebot/t2i/canvas
 */

import { createCanvas } from '@napi-rs/canvas'
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas'
import { classifyChar } from './fonts.js'
import type { FontManager } from './fonts.js'

/** The CJK code font scale used inside code capsules (26px → 22px). */
export function codeFontSize(fullSize: number): number {
  return Math.max(12, Math.floor(fullSize * 0.85))
}

/** Card colors (verbatim from the Python original). */
export const COLORS = {
  topbar: '#2196f3',
  titleLine: '#e6e6e6',
  quote: '#b4b4b4',
  codeBlockBg: '#f0f0f0',
  codeCapsuleBg: '#eef1f8',
  codeCapsuleOutline: '#ced7eb',
  codeCapsuleText: '#2f4882',
  tableHeaderBg: '#f0f0f0',
  tableAltRowBg: '#f8f8f8',
  tableGrid: '#d2d2d2',
  footerGrey: '#828282',
  footerBrand: '#002fa7',
  ink: '#000000',
  white: '#ffffff',
}

/**
 * One render target: an offscreen canvas with the drawing primitives used by
 * the element classes.
 */
export class CardCanvas {
  readonly width: number
  readonly height: number
  /** The font manager this card measures/draws with. */
  readonly font: FontManager
  private readonly canvas: Canvas
  private readonly ctx: SKRSContext2D

  constructor(width: number, height: number, font: FontManager) {
    this.width = width
    this.height = height
    this.font = font
    this.canvas = createCanvas(width, height)
    this.ctx = this.canvas.getContext('2d')
    this.ctx.fillStyle = COLORS.white
    this.ctx.fillRect(0, 0, width, height)
    this.ctx.textAlign = 'left'
  }

  /** Encode the card as PNG bytes. */
  toPng(): Buffer {
    return this.canvas.toBuffer('image/png')
  }

  // ------------------------------------------------------------ primitives

  /** Fill a rectangle. */
  fillRect(x: number, y: number, w: number, h: number, fill: string): void {
    this.ctx.fillStyle = fill
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
  }

  /** Fill a rounded rectangle. */
  fillRoundRect(x: number, y: number, w: number, h: number, radius: number, fill: string): void {
    this.ctx.fillStyle = fill
    this.ctx.beginPath()
    this.ctx.roundRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), radius)
    this.ctx.fill()
  }

  /** Stroke a rounded rectangle outline. */
  strokeRoundRect(x: number, y: number, w: number, h: number, radius: number, color: string): void {
    this.ctx.strokeStyle = color
    this.ctx.lineWidth = 1
    this.ctx.beginPath()
    this.ctx.roundRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), radius)
    this.ctx.stroke()
  }

  /** Run a drawing callback under an AFFINE shear (italic simulation). */
  withTransform(dx: number, dy: number, draw: () => void): void {
    this.ctx.save()
    this.ctx.transform(1, 0.2, 0, 1, dx, dy)
    draw()
    this.ctx.restore()
  }

  /** Stroke a horizontal line. */
  hLine(x1: number, y: number, x2: number, color: string, width = 1): void {
    this.ctx.strokeStyle = color
    this.ctx.lineWidth = width
    this.ctx.beginPath()
    this.ctx.moveTo(Math.round(x1), Math.round(y))
    this.ctx.lineTo(Math.round(x2), Math.round(y))
    this.ctx.stroke()
  }

  /** Stroke a vertical line. */
  vLine(x: number, y1: number, y2: number, color: string, width = 1): void {
    this.ctx.strokeStyle = color
    this.ctx.lineWidth = width
    this.ctx.beginPath()
    this.ctx.moveTo(Math.round(x), Math.round(y1))
    this.ctx.lineTo(Math.round(x), Math.round(y2))
    this.ctx.stroke()
  }

  // ------------------------------------------------------------ text runs

  /**
   * Draw one text run at the ascender line y.
   * @param text - the run text (shares one family).
   * @param x - left edge.
   * @param y - ascender line (baseline is y + ascent).
   * @param family - resolved family name.
   * @param size - font size in px.
   * @param fill - color.
   * @param dy - extra vertical offset (code-font alignment).
   */
  drawRun(text: string, x: number, y: number, family: string, size: number, fill: string, dy = 0): void {
    this.ctx.font = size + 'px "' + family + '"'
    this.ctx.fillStyle = fill
    this.ctx.textBaseline = 'alphabetic'
    this.ctx.fillText(text, x, y + dy + this.font.ascent(family, size))
  }

  /** Summed width of one run: per-char widths with the run's family. */
  runWidth(text: string, family: string, size: number): number {
    let total = 0
    for (const ch of text) total += this.font.charWidth(ch, family, size)
    return total
  }

  /**
   * Draw body text with per-character-class runs (the _draw_runs port).
   * Emoji are drawn with the color emoji family (falling back to the CJK
   * family when no color font exists); zero-width chars advance nothing.
   * When skipEmoji is set (bold second pass), emoji keep their width but are
   * not painted (avoids the 1px ghost the original warns about).
   * @param text - the text.
   * @param x - left edge.
   * @param y - ascender line.
   * @param size - body font size in px.
   * @param fill - color.
   * @param skipEmoji - skip painting emoji but keep their advance.
   * @returns the advanced x.
   */
  drawBodyRuns(text: string, x: number, y: number, size: number, fill: string, skipEmoji = false): number {
    // Iterate by CODE POINTS: string indexing would split surrogate pairs
    // (emoji) into lone halves that classify as CJK and render monochrome.
    const chars = Array.from(text)
    let cx = x
    let i = 0
    while (i < chars.length) {
      const cls = classifyChar(chars[i])
      if (cls === 'zwj') {
        i += 1
        continue
      }
      if (cls === 'emoji') {
        const emojiFamily = this.font.familyFor('emoji')
        if (emojiFamily !== undefined) {
          const width = this.font.emojiWidth(size)
          if (!skipEmoji && width > 0) this.drawRun(chars[i], cx, y, emojiFamily, size, fill)
          cx += width
        } else {
          const family = this.font.familyFor('cjk')
          if (family !== undefined) {
            if (!skipEmoji) this.drawRun(chars[i], cx, y, family, size, fill)
            cx += this.font.charWidth(chars[i], family, size)
          }
        }
        i += 1
        continue
      }
      // ascii + cjk share the primary CJK family in body text.
      const family = this.font.familyFor('cjk')
      if (family === undefined) {
        cx += size
        i += 1
        continue
      }
      let j = i + 1
      while (j < chars.length) {
        const next = classifyChar(chars[j])
        if (next === 'ascii' || next === 'cjk') {
          j += 1
          continue
        }
        break
      }
      const run = chars.slice(i, j).join('')
      this.drawRun(run, cx, y, family, size, fill)
      cx += this.runWidth(run, family, size)
      i = j
    }
    return cx
  }

  /**
   * Draw code text (the _draw_code_text port): ASCII uses the mono family at
   * full size with a 1px downward nudge; CJK uses the CJK family at the
   * reduced code size, vertically centered; emoji at the code size.
   * @param text - the code content.
   * @param x - left edge.
   * @param y - ascender line.
   * @param size - the body font size (code size is derived).
   * @param fill - color.
   * @returns the advanced x.
   */
  drawCodeRuns(text: string, x: number, y: number, size: number, fill: string): number {
    const codeSize = codeFontSize(size)
    const cjkDy = Math.floor((size - codeSize) / 2)
    const chars = Array.from(text)
    let cx = x
    let i = 0
    while (i < chars.length) {
      const cls = classifyChar(chars[i])
      if (cls === 'zwj') {
        i += 1
        continue
      }
      let family: string | undefined
      let runSize: number
      let dy: number
      if (cls === 'emoji') {
        family = this.font.codeFamilyFor('emoji')
        runSize = codeSize
        dy = cjkDy
      } else if (cls === 'ascii') {
        family = this.font.codeFamilyFor('ascii')
        runSize = size
        dy = 1
      } else {
        family = this.font.codeFamilyFor('cjk')
        runSize = codeSize
        dy = cjkDy
      }
      if (family === undefined) {
        cx += runSize
        i += 1
        continue
      }
      let j = i + 1
      while (j < chars.length) {
        const next = classifyChar(chars[j])
        if (next === 'zwj') break
        if (next === 'emoji' && cls !== 'emoji') break
        if (next !== 'emoji' && cls === 'emoji') break
        if ((next === 'ascii') !== (cls === 'ascii')) break
        j += 1
      }
      const run = chars.slice(i, j).join('')
      this.drawRun(run, cx, y, family, runSize, fill, dy)
      cx += this.runWidth(run, family, runSize)
      i = j
    }
    return cx
  }
}
