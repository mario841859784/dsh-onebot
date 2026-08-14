/**
 * Line-breaking and segment measurement (port of t2i_render.py's
 * TextMeasurer / split_inline_lines / _seg_width). Pure layout logic with an
 * injectable width source so unit tests run without real fonts.
 *
 * Iron rule (T2I_DEV_DOC §5.1): every wrap/center/column computation uses the
 * ACTUAL drawn width — inline-code capsules add their padding, bold adds 1px,
 * italic adds 8px — and split_to_fit reserves that extra width so a single
 * styled segment never overflows a line.
 * @module dsh-onebot/t2i/measure
 */
/** Inline style classes (the Python BoldTextElement/ItalicTextElement/...). */
export type InlineClass = 'bold' | 'italic' | 'strike' | 'code';
/** One inline part: plain text or a styled segment. */
export interface InlinePart {
    cls: InlineClass | null;
    content: string;
}
/** Width source: per-character widths in body or code context at a size. */
export interface WidthSource {
    /**
     * Width of one character.
     * @param ch - the character.
     * @param size - font size in px (body context).
     * @param code - code context (mono for ASCII, CJK scaled down).
     * @returns width in px.
     */
    charWidth(ch: string, size: number, code: boolean): number;
}
/** Summed width of a plain text run. */
export declare function textWidth(source: WidthSource, text: string, size: number): number;
/** Summed width of a code content run (mono/small-CJK widths). */
export declare function codeWidth(source: WidthSource, text: string, size: number): number;
/**
 * The ACTUAL drawn width of one inline part (the _seg_width port):
 * code capsule = code width + 14 (pad_x*2 + 2), bold = width + 1,
 * italic = width + 8 (shear overhang), plain = width.
 * @param part - the inline part.
 * @param source - width source.
 * @param size - font size in px.
 * @returns drawn width in px.
 */
export declare function segWidth(part: InlinePart, source: WidthSource, size: number): number;
/**
 * Characters that must never start a line (CJK punctuation prohibition).
 * Ported verbatim from the Python _HEAD_BANNED.
 */
export declare const HEAD_BANNED: Set<string>;
/**
 * Greedy line-breaking that prefers spaces, honors the head-ban, and hard-
 * cuts only as a last resort (port of TextMeasurer.split_to_fit).
 * @param text - the text to break.
 * @param maxWidth - available width.
 * @param width - per-character width function (NOT the summed run width).
 * @returns lines.
 */
export declare function splitToFit(text: string, maxWidth: number, width: (ch: string) => number): string[];
/**
 * Break a sequence of inline parts into lines, keeping styled segments whole
 * (port of split_inline_lines). Reserves style extra width per segment,
 * handles cross-element head-ban (plain segments shed a leading punctuation
 * prefix onto the previous line; styled segments wrap whole), and merges
 * adjacent same-class segments back together.
 * @param parts - inline parts (with newlines already normalized).
 * @param maxWidth - available line width.
 * @param source - width source.
 * @param size - font size in px.
 * @returns lines of inline parts.
 */
export declare function splitInlineLines(parts: InlinePart[], maxWidth: number, source: WidthSource, size: number): InlinePart[][];
