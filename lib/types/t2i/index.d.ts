/**
 * The t2i card renderer entry (port of MarkdownRenderer + render_text_image).
 * Two passes: element heights are computed first, then elements render onto
 * the card; the top bar ("To 昵称") and the footer ("Powered by <brand>")
 * frame the content.
 * @module dsh-onebot/t2i/index
 */
import { CardCanvas } from './canvas.js';
import { FontManager } from './fonts.js';
/** Card geometry (fixed by the original renderer). */
export declare const CARD_WIDTH = 800;
export declare const BODY_FONT_SIZE = 26;
/** Render options. */
export interface RenderOptions {
    /** Top bar title (e.g. "To 昵称"); absent → no top bar. */
    title?: string;
    /** Footer brand (default "dsh"). */
    footerBrand?: string;
    /** Font files to register (Linux deployments). */
    fontFiles?: readonly string[];
    /** Preferred font family names. */
    fontFamilies?: readonly string[];
}
/**
 * Render markdown text as a styled PNG card (synchronous; the original was
 * also synchronous PIL work). Throws when no usable CJK font family exists.
 * @param text - markdown text (literal \\n sequences are converted).
 * @param options - title/footer/fonts.
 * @returns PNG bytes.
 */
export declare function renderTextImage(text: string, options?: RenderOptions): Buffer;
export { FontManager, CardCanvas };
