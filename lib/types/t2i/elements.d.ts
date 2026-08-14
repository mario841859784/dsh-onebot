/**
 * Block element layout and rendering (port of t2i_render.py's element
 * classes). Element heights are pure functions of (element, layout context);
 * rendering draws onto a CardCanvas and returns the next y.
 * @module dsh-onebot/t2i/elements
 */
import type { CardCanvas } from './canvas.js';
import type { FontManager } from './fonts.js';
import type { InlinePart, WidthSource } from './measure.js';
import type { BlockElement } from './parser.js';
/** Layout context shared by height and render passes. */
export interface LayoutCtx {
    width: number;
    size: number;
    widthSource: WidthSource;
}
/** Width source backed by the font manager (measure == draw). */
export declare class FontWidthSource implements WidthSource {
    private readonly font;
    constructor(font: FontManager);
    charWidth(ch: string, size: number, code: boolean): number;
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
export declare function renderInlineParts(card: CardCanvas, x: number, y: number, parts: InlinePart[], size: number, fill: string, ctx: LayoutCtx): number;
/** Height of a block element (the calculate_height port). */
export declare function elementHeight(el: BlockElement, ctx: LayoutCtx): number;
/** Header font size for a level (42 - (level-1)*4, level capped at 6). */
export declare function headerFontSize(level: number): number;
/** Render a block element; returns the next y. */
export declare function renderElement(el: BlockElement, card: CardCanvas, ctx: LayoutCtx, x: number, y: number): number;
