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
/** Character classes for font selection (mirrors _is_emoji / _code_font_for). */
export type CharClass = 'emoji' | 'zwj' | 'ascii' | 'cjk';
/**
 * Classify one character for font selection. The emoji font never enters
 * the CJK chain (its cmap contains digits; same trap as the original).
 * @param ch - single character.
 * @returns the class.
 */
export declare function classifyChar(ch: string): CharClass;
/** Configuration for font discovery. */
export interface FontConfig {
    /** Font files to register (Linux deployments, custom fonts). */
    fontFiles?: readonly string[];
    /** Preferred family names, tried before platform defaults. */
    fontFamilies?: readonly string[];
}
/**
 * The font manager: platform family resolution, per-character-class family
 * lookup, and a width cache. One instance per plugin (lazy init).
 */
export declare class FontManager {
    private readonly cjkFamilies;
    private monoFamily;
    private emojiFamily;
    private readonly widthCache;
    private readonly measureCtx;
    private usableFlag;
    private inkChecked;
    /** Build a manager from config (registering files first). */
    static create(config?: FontConfig): FontManager;
    /** Whether at least one CJK family is usable. */
    get usable(): boolean;
    /** The resolved CJK family chain (fallback order). */
    get cjkChain(): readonly string[];
    /** Family for a character class in body text. */
    familyFor(cls: CharClass): string | undefined;
    /** Family for a character class in code text (mono for ASCII). */
    codeFamilyFor(cls: CharClass): string | undefined;
    /**
     * Cached width of one character with a family at a size.
     * @param ch - the character.
     * @param family - resolved family name.
     * @param size - font size in px.
     * @returns width in px.
     */
    charWidth(ch: string, family: string, size: number): number;
    /**
     * Font ascent (alphabetic baseline offset) for line layout.
     * @param family - resolved family name.
     * @param size - font size in px.
     * @returns ascent in px.
     */
    ascent(family: string, size: number): number;
    /**
     * Font descent for vertical centering.
     * @param family - resolved family name.
     * @param size - font size in px.
     * @returns descent in px.
     */
    descent(family: string, size: number): number;
    /**
     * Emoji width at a size (1 em for color fonts).
     * @param size - target size in px.
     * @returns width in px (0 when no color emoji family).
     */
    emojiWidth(size: number): number;
    /**
     * Ink self-check: render '中' at 40px with the primary CJK family and count
     * dark pixels. A missing family renders a hollow tofu box, which would
     * silently corrupt every card, so unusable families are dropped.
     */
    private inkCheck;
    private init;
    /** fontkit: extract the "CJK SC" face from NotoSansCJK-Regular.ttc. */
    private extractNotoScFace;
}
