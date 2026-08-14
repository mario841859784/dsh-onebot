/**
 * Outbound text shaping: sentence-boundary splitting, Markdown stripping for
 * QQ, [[qq_forward]] block parsing, and the sensitive-intent audit.
 * Ported from the Hermes onebot_utils.py split/markdown half.
 * @module dsh-onebot/split
 */
/**
 * Split long text into chunks no longer than splitLength at sentence
 * boundaries (port of the original _split_reply).
 *
 * Each window is scanned BACKWARD for the last sentence boundary, so chunks
 * stay within the limit and end on punctuation. When a window contains no
 * punctuation the cut prefers the last space (keeps words/URLs intact);
 * only as a last resort is the chunk hard-cut at the limit. Boundaries
 * never split a surrogate pair (emoji stay whole).
 * @param text - the full reply text.
 * @param splitLength - maximum chunk length (<= 0 resets to 100).
 * @returns text chunks.
 */
export declare function splitLongText(text: string, splitLength: number): string[];
/**
 * Strip Markdown into QQ-friendly plain text. QQ does not render Markdown;
 * headings, emphasis, links, code fences, and tables are flattened. The
 * internal [[qq_forward]] markers are preserved (handled before this runs).
 * @param text - model-produced Markdown text.
 * @returns plain text for QQ.
 */
export declare function stripMarkdown(text: string): string;
/** One [[qq_forward]] block: a named message node. */
export interface ForwardNode {
    name: string;
    content: string;
}
/** The [[qq_forward]] marker regex (imported from cq.ts for single sourcing). */
import { FORWARD_BLOCK_RE } from './cq.js';
export { FORWARD_BLOCK_RE };
/**
 * Extract [[qq_forward]] blocks from reply text. The blocks are removed from
 * the returned body text; empty-name blocks default the sender name.
 * @param text - the reply text (before Markdown stripping).
 * @param defaultName - node name when the block omits one.
 * @returns body text without blocks, plus the parsed nodes.
 */
export declare function extractForwardBlocks(text: string, defaultName: string): {
    body: string;
    nodes: ForwardNode[];
};
/**
 * Check outbound text against sensitive patterns (soft audit, non-blocking).
 * @param text - outbound text.
 * @param patterns - configured patterns; empty list disables the audit.
 * @returns matched patterns (strings), or [] when clean or disabled.
 */
export declare function scanSensitive(text: string, patterns: readonly string[]): string[];
