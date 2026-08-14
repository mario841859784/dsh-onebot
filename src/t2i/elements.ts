/**
 * Block element layout and rendering (port of t2i_render.py's element
 * classes). Element heights are pure functions of (element, layout context);
 * rendering draws onto a CardCanvas and returns the next y.
 * @module dsh-onebot/t2i/elements
 */

import type { CardCanvas } from './canvas.js'
import { COLORS, codeFontSize } from './canvas.js'
import type { FontManager } from './fonts.js'
import { classifyChar } from './fonts.js'
import type { InlinePart, WidthSource } from './measure.js'
import { codeWidth, segWidth, splitInlineLines, splitToFit, textWidth } from './measure.js'
import { parseInline } from './parser.js'
import type { BlockElement } from './parser.js'

/** Layout context shared by height and render passes. */
export interface LayoutCtx {
  width: number
  size: number
  widthSource: WidthSource
}

/** Width source backed by the font manager (measure == draw). */
export class FontWidthSource implements WidthSource {
  constructor(private readonly font: FontManager) {}

  charWidth(ch: string, size: number, code: boolean): number {
    if (ch === '') return 0
    const cls = classifyChar(ch)
    if (cls === 'zwj') return 0
    if (cls === 'emoji') {
      const target = code ? codeFontSize(size) : size
      const width = this.font.emojiWidth(target)
      if (width > 0) return width
      const family = this.font.familyFor('cjk')
      return family !== undefined ? this.font.charWidth(ch, family, target) : target
    }
    if (code) {
      const family = this.font.codeFamilyFor(cls)
      const runSize = cls === 'ascii' ? size : codeFontSize(size)
      return family !== undefined ? this.font.charWidth(ch, family, runSize) : runSize
    }
    const family = this.font.familyFor('cjk')
    return family !== undefined ? this.font.charWidth(ch, family, size) : size
  }
}

/** Split an inline-part list into lines for an element's width budget. */
function linesFor(content: string, ctx: LayoutCtx, budget: number, size?: number): InlinePart[][] {
  const parts = parseInline(content)
  return splitInlineLines(parts, budget, ctx.widthSource, size ?? ctx.size)
}

/**
 * Render one inline part sequence at the ascender line y (the
 * render_inline_parts port).
 * @param card - the card.
 * @param x - left edge.
 * @param y - ascender line.
 * @param parts - inline parts.
 * @param size - font size.
 * @param fill - color.
 * @param ctx - layout context (width source).
 * @returns the advanced x.
 */
export function renderInlineParts(
  card: CardCanvas,
  x: number,
  y: number,
  parts: InlinePart[],
  size: number,
  fill: string,
  ctx: LayoutCtx,
): number {
  let cx = x
  for (const part of parts) {
    const cls = part.cls
    if (cls === null) {
      card.drawBodyRuns(part.content, cx, y, size, fill)
      cx += textWidth(ctx.widthSource, part.content, size)
    } else if (cls === 'bold') {
      card.drawBodyRuns(part.content, cx, y, size, fill)
      card.drawBodyRuns(part.content, cx + 1, y, size, fill, true)
      cx += textWidth(ctx.widthSource, part.content, size) + 1
    } else if (cls === 'italic') {
      // AFFINE shear (1, 0.2, 0, 1) around the segment origin.
      const w = textWidth(ctx.widthSource, part.content, size)
      card.withTransform(cx, y, () => {
        card.drawBodyRuns(part.content, 0, 0, size, fill)
      })
      cx += w + 8
    } else if (cls === 'strike') {
      card.drawBodyRuns(part.content, cx, y, size, fill)
      const w = textWidth(ctx.widthSource, part.content, size)
      card.hLine(cx, y + Math.floor(size / 2), cx + w, fill, 1)
      cx += w
    } else if (cls === 'code') {
      const w = codeWidth(ctx.widthSource, part.content, size)
      const padX = 6
      const padY = 5
      // Light blue-grey capsule with a thin border (internal height
      // size + 2*padY + 1 = 37px ≤ line height size + 12 = 38px).
      card.fillRoundRect(cx, y + 1, w + padX * 2, size + padY * 2 + 1, 6, COLORS.codeCapsuleBg)
      card.strokeRoundRect(cx, y + 1, w + padX * 2, size + padY * 2 + 1, 6, COLORS.codeCapsuleOutline)
      card.drawCodeRuns(part.content, cx + padX, y + padY + 3, size, COLORS.codeCapsuleText)
      cx += w + padX * 2 + 2
    }
  }
  return cx
}

// ---------------------------------------------------------------- elements

/** Height of a block element (the calculate_height port). */
export function elementHeight(el: BlockElement, ctx: LayoutCtx): number {
  switch (el.kind) {
    case 'text': {
      if (el.content.trim() === '') return 10
      return linesFor(el.content, ctx, ctx.width - 20).length * (ctx.size + 12)
    }
    case 'header': {
      const headerSize = headerFontSize(el.level)
      const lines = linesFor(el.content, ctx, ctx.width - 20, headerSize)
      return Math.max(1, lines.length) * headerSize + 30
    }
    case 'quote': {
      const lines = linesFor(el.content, ctx, ctx.width - 35)
      return lines.length * (ctx.size + 10) + 12
    }
    case 'list': {
      const lines = linesFor(el.content, ctx, ctx.width - 45)
      return lines.length * (ctx.size + 10) + 16
    }
    case 'ordered': {
      const lines = linesFor(el.content, ctx, ctx.width - 55)
      return lines.length * (ctx.size + 10) + 16
    }
    case 'code': {
      const wrapped = wrapCodeLines(el.content, ctx)
      if (el.content.trim() === '') return 40
      return wrapped.length * (ctx.size + 4) + 40
    }
    case 'table':
      return tableLayout(el, ctx).height
  }
}

/** Header font size for a level (42 - (level-1)*4, level capped at 6). */
export function headerFontSize(level: number): number {
  return 42 - (level - 1) * 4
}

/** Wrap code-block lines at the code budget. */
function wrapCodeLines(content: string, ctx: LayoutCtx): string[] {
  const wrapped: string[] = []
  for (const line of content.split('\n')) {
    wrapped.push(...splitToFit(line, ctx.width - 40, ch => ctx.widthSource.charWidth(ch, ctx.size, true)))
  }
  return wrapped
}

/** Render a block element; returns the next y. */
export function renderElement(el: BlockElement, card: CardCanvas, ctx: LayoutCtx, x: number, y: number): number {
  switch (el.kind) {
    case 'text': {
      if (el.content.trim() === '') return y + 10
      for (const line of linesFor(el.content, ctx, ctx.width - 20)) {
        renderInlineParts(card, x, y, line, ctx.size, COLORS.ink, ctx)
        y += ctx.size + 12
      }
      return y
    }
    case 'header': {
      const headerSize = headerFontSize(el.level)
      const lines = linesFor(el.content, ctx, ctx.width - 20, headerSize)
      y += 10
      if (lines.length > 0) {
        renderInlineParts(card, x, y, lines[0], headerSize, COLORS.ink, ctx)
        y += headerSize + 12
      }
      card.hLine(x, y, ctx.width - 10, COLORS.titleLine, 3)
      return y + 10
    }
    case 'quote': {
      const lines = linesFor(el.content, ctx, ctx.width - 35)
      const total = lines.length * (ctx.size + 10)
      card.vLine(x + 3, y + 6, y + total + 6, COLORS.quote, 5)
      let ty = y + 6
      for (const line of lines) {
        renderInlineParts(card, x + 15, ty, line, ctx.size, COLORS.quote, ctx)
        ty += ctx.size + 10
      }
      return y + total + 12
    }
    case 'list': {
      const lines = linesFor(el.content, ctx, ctx.width - 45)
      y += 8
      const family = card.font.familyFor('cjk')
      if (family !== undefined) card.drawRun('•', x + 5, y, family, ctx.size, COLORS.ink)
      let ty = y
      for (const line of lines) {
        renderInlineParts(card, x + 25, ty, line, ctx.size, COLORS.ink, ctx)
        ty += ctx.size + 10
      }
      return ty + 8
    }
    case 'ordered': {
      const lines = linesFor(el.content, ctx, ctx.width - 55)
      y += 8
      const family = card.font.familyFor('cjk')
      if (family !== undefined) card.drawRun(String(el.number) + '.', x + 5, y, family, ctx.size, COLORS.ink)
      let ty = y
      for (const line of lines) {
        renderInlineParts(card, x + 35, ty, line, ctx.size, COLORS.ink, ctx)
        ty += ctx.size + 10
      }
      return ty + 8
    }
    case 'code': {
      const wrapped = wrapCodeLines(el.content, ctx)
      const contentHeight = wrapped.length * (ctx.size + 4)
      const total = contentHeight + 30
      card.fillRoundRect(x, y + 5, ctx.width - 10 - x, total, 5, COLORS.codeBlockBg)
      let ty = y + 15
      for (const line of wrapped) {
        card.drawCodeRuns(line, x + 15, ty, ctx.size, COLORS.ink)
        ty += ctx.size + 4
      }
      return y + total + 10
    }
    case 'table': {
      const layout = tableLayout(el, ctx)
      return renderTable(el, layout, card, ctx, x, y)
    }
  }
}

// ------------------------------------------------------------------ table

const TABLE_COL_GAP = 4

interface TableLayout {
  colWidths: number[]
  /** rows × cells × lines × parts. */
  cellLines: InlinePart[][][][]
  rowHeights: number[]
  nCols: number
  height: number
}

/** Two-pass column layout (the TableElement._layout port). */
function tableLayout(el: BlockElement & { kind: 'table' }, ctx: LayoutCtx): TableLayout {
  const width = ctx.width
  const size = ctx.size
  const nCols = Math.max(el.header.length, ...el.rows.map(r => r.length), 1)
  const padX = 10
  const maxContentW = width - 30 - TABLE_COL_GAP * (nCols - 1) - padX * 2 * nCols

  const splitCells = (colWidths: number[]): InlinePart[][][][] => {
    const out: InlinePart[][][][] = []
    for (const row of [el.header, ...el.rows]) {
      const cells = [...row, ...Array(Math.max(0, nCols - row.length)).fill('')]
      const rowLines: InlinePart[][][] = []
      for (let ci = 0; ci < nCols; ci += 1) {
        const cell = cells[ci] ?? ''
        rowLines.push(splitInlineLines(parseInline(cell.trim()), Math.max(20, (colWidths[ci] ?? 0) - padX * 2), ctx.widthSource, size))
      }
      out.push(rowLines)
    }
    return out
  }

  const measureCols = (cellLines: InlinePart[][][][]): number[] => {
    const widths: number[] = []
    for (let ci = 0; ci < nCols; ci += 1) {
      let maxW = 0
      for (const rowLines of cellLines) {
        for (const line of rowLines[ci] ?? []) {
          let w = 0
          for (const part of line) w += segWidth(part, ctx.widthSource, size)
          if (w > maxW) maxW = w
        }
      }
      widths.push(Math.floor(maxW) + padX * 2)
    }
    return widths
  }

  // Pass 1: equal split, measure.
  let cellLines = splitCells(Array(nCols).fill(Math.floor(maxContentW / nCols)))
  let colWidths = measureCols(cellLines)
  // Compress proportionally when the total exceeds the card, then re-wrap.
  const total = colWidths.reduce((a, b) => a + b, 0) + TABLE_COL_GAP * (nCols - 1)
  if (total > width - 30) {
    const avail = width - 30 - TABLE_COL_GAP * (nCols - 1)
    const ratio = avail / colWidths.reduce((a, b) => a + b, 0)
    colWidths = colWidths.map(w => Math.max(30, Math.floor(w * ratio)))
    cellLines = splitCells(colWidths)
    colWidths = measureCols(cellLines)
  }
  // Stretch to fill the available card width (remainder to the last column).
  const avail = width - 30 - TABLE_COL_GAP * (nCols - 1)
  const current = colWidths.reduce((a, b) => a + b, 0)
  if (current < avail) {
    const extra = avail - current
    const per = Math.floor(extra / nCols)
    colWidths = colWidths.map(w => w + per)
    colWidths[nCols - 1] += extra - per * nCols
  }
  const rowHeights = cellLines.map(rowLines => {
    const maxLines = Math.max(...rowLines.map(l => l.length), 1)
    return maxLines * (size + 14) + 12
  })
  const height = rowHeights.reduce((a, b) => a + b, 0) + 20
  return { colWidths, cellLines, rowHeights, nCols, height }
}

/** Render the table (the TableElement.render port). */
function renderTable(
  el: BlockElement & { kind: 'table' },
  layout: TableLayout,
  card: CardCanvas,
  ctx: LayoutCtx,
  x: number,
  y: number,
): number {
  void el
  const size = ctx.size
  const tableX = x + 10
  const tableW = layout.colWidths.reduce((a, b) => a + b, 0) + TABLE_COL_GAP * (layout.nCols - 1)
  let cy = y + 10

  // Header row.
  const headerLines = layout.cellLines[0] ?? []
  const headerH = Math.max(...headerLines.map(l => l.length), 1) * (size + 14) + 12
  card.fillRect(tableX, cy, tableW, headerH, COLORS.tableHeaderBg)
  let hx = tableX
  for (let ci = 0; ci < layout.nCols; ci += 1) {
    let ty = cy + 6
    for (const line of headerLines[ci] ?? []) {
      const lineW = line.reduce((acc, part) => acc + segWidth(part, ctx.widthSource, size), 0)
      const cx = hx + (layout.colWidths[ci] - lineW) / 2
      renderInlineParts(card, cx, ty, line, size, COLORS.ink, ctx)
      ty += size + 14
    }
    hx += layout.colWidths[ci] + TABLE_COL_GAP
  }
  cy += headerH

  // Data rows with alternating shading (even rows shaded).
  for (let ri = 1; ri < layout.cellLines.length; ri += 1) {
    const rowLines = layout.cellLines[ri] ?? []
    const rowH = Math.max(...rowLines.map(l => l.length), 1) * (size + 14) + 12
    if (ri % 2 === 0) {
      card.fillRect(tableX, cy, tableW, rowH, COLORS.tableAltRowBg)
    }
    hx = tableX
    for (let ci = 0; ci < layout.nCols; ci += 1) {
      let ty = cy + 6
      for (const line of rowLines[ci] ?? []) {
        const lineW = line.reduce((acc, part) => acc + segWidth(part, ctx.widthSource, size), 0)
        const cx = hx + (layout.colWidths[ci] - lineW) / 2
        renderInlineParts(card, cx, ty, line, size, COLORS.ink, ctx)
        ty += size + 14
      }
      hx += layout.colWidths[ci] + TABLE_COL_GAP
    }
    cy += rowH
  }

  // Grid lines; the right border sits at the table's real right edge.
  hx = tableX
  for (const cw of layout.colWidths) {
    card.vLine(hx, y + 10, cy, COLORS.tableGrid, 1)
    hx += cw + TABLE_COL_GAP
  }
  card.vLine(tableX + tableW, y + 10, cy, COLORS.tableGrid, 1)
  card.hLine(tableX, cy, tableX + tableW, COLORS.tableGrid, 1)
  return cy + 10
}
