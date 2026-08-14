/**
 * Markdown parsing for the t2i card renderer (port of t2i_render.py's
 * parse_inline / MarkdownParser / _literal_n_to_newlines). Links and images
 * are intentionally left as literal text (original limitation, §6).
 * @module dsh-onebot/t2i/parser
 */
import type { InlinePart } from './measure.js';
/**
 * Convert literal "\\n" sequences in LLM output to real newlines.
 * Inline-code segments are protected first (their literal \\n becomes a
 * space, since a capsule cannot contain line breaks); a double backslash
 * before n ("\\\\n") is preserved untouched.
 * @param text - model-produced text.
 * @returns text with literal newlines converted.
 */
export declare function literalNToNewlines(text: string): string;
/**
 * Parse inline styles in one line into a part sequence. Overlapping markers
 * keep the outermost match (the original filters by non-overlapping order).
 * @param line - one line of text.
 * @returns inline parts.
 */
export declare function parseInline(line: string): InlinePart[];
/** Parse one table row into cells. */
export declare function parseTableRow(line: string): string[];
/** Block element types produced by the parser. */
export type BlockElement = {
    kind: 'text';
    content: string;
} | {
    kind: 'header';
    content: string;
    level: number;
} | {
    kind: 'quote';
    content: string;
} | {
    kind: 'list';
    content: string;
} | {
    kind: 'ordered';
    content: string;
    number: number;
} | {
    kind: 'code';
    content: string;
} | {
    kind: 'table';
    header: string[];
    rows: string[][];
};
/**
 * Parse markdown text into block elements (port of MarkdownParser.parse).
 * @param text - the markdown text.
 * @returns block elements.
 */
export declare function parseBlocks(text: string): BlockElement[];
