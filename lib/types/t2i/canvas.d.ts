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
import type { FontManager } from './fonts.js';
/** The CJK code font scale used inside code capsules (26px → 22px). */
export declare function codeFontSize(fullSize: number): number;
/** Card colors (verbatim from the Python original). */
export declare const COLORS: {
    topbar: string;
    titleLine: string;
    quote: string;
    codeBlockBg: string;
    codeCapsuleBg: string;
    codeCapsuleOutline: string;
    codeCapsuleText: string;
    tableHeaderBg: string;
    tableAltRowBg: string;
    tableGrid: string;
    footerGrey: string;
    footerBrand: string;
    ink: string;
    white: string;
};
/**
 * One render target: an offscreen canvas with the drawing primitives used by
 * the element classes.
 */
export declare class CardCanvas {
    readonly width: number;
    readonly height: number;
    /** The font manager this card measures/draws with. */
    readonly font: FontManager;
    private readonly canvas;
    private readonly ctx;
    constructor(width: number, height: number, font: FontManager);
    /** Encode the card as PNG bytes. */
    toPng(): Buffer;
    /** Fill a rectangle. */
    fillRect(x: number, y: number, w: number, h: number, fill: string): void;
    /** Fill a rounded rectangle. */
    fillRoundRect(x: number, y: number, w: number, h: number, radius: number, fill: string): void;
    /** Stroke a rounded rectangle outline. */
    strokeRoundRect(x: number, y: number, w: number, h: number, radius: number, color: string): void;
    /** Run a drawing callback under an AFFINE shear (italic simulation). */
    withTransform(dx: number, dy: number, draw: () => void): void;
    /** Stroke a horizontal line. */
    hLine(x1: number, y: number, x2: number, color: string, width?: number): void;
    /** Stroke a vertical line. */
    vLine(x: number, y1: number, y2: number, color: string, width?: number): void;
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
    drawRun(text: string, x: number, y: number, family: string, size: number, fill: string, dy?: number): void;
    /** Summed width of one run: per-char widths with the run's family. */
    runWidth(text: string, family: string, size: number): number;
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
    drawBodyRuns(text: string, x: number, y: number, size: number, fill: string, skipEmoji?: boolean): number;
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
    drawCodeRuns(text: string, x: number, y: number, size: number, fill: string): number;
}
