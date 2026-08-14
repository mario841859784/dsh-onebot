/**
 * Outbound text shaping: sentence-boundary splitting, Markdown stripping for
 * QQ, [[qq_forward]] block parsing, and the sensitive-intent audit.
 * Ported from the Hermes onebot_utils.py split/markdown half.
 * @module dsh-onebot/split
 */

/** Sentence-ending punctuation, verbatim from the original _SENTENCE_BOUNDS. */
const SENTENCE_BOUNDS = new Set(['。', '！', '？', '!', '?', '；', ';', '\n'])

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
export function splitLongText(text: string, splitLength: number): string[] {
  const limit = splitLength > 0 ? splitLength : 100
  const content = text.trim()
  if (content === '') return []
  if (content.length <= limit) return [content]

  const parts: string[] = []
  let start = 0
  const n = content.length
  while (start < n) {
    const end = Math.min(start + limit, n)
    if (end >= n) {
      parts.push(content.slice(start))
      break
    }
    // Backward scan for the last sentence boundary inside the window.
    let cut = -1
    for (let i = end - 1; i >= start; i -= 1) {
      if (SENTENCE_BOUNDS.has(content[i])) {
        cut = i
        break
      }
    }
    if (cut < 0) {
      // No punctuation: prefer the last space so words/URLs survive.
      let space = -1
      for (let i = end - 1; i > start; i -= 1) {
        if (content[i] === ' ') {
          space = i
          break
        }
      }
      cut = space > start ? space : end - 1
    }
    let cutEnd = cut + 1
    // Never split a surrogate pair: if the boundary lands between the two
    // halves (the char before the cut is a high surrogate), move it back.
    const before = content.charCodeAt(cutEnd - 1)
    if (before >= 0xD800 && before <= 0xDBFF) {
      cutEnd -= 1
    }
    parts.push(content.slice(start, cutEnd).replace(/[ \t]+$/, ''))
    start = cutEnd
  }
  return parts.filter(p => p.trim() !== '')
}

/**
 * Strip Markdown into QQ-friendly plain text. QQ does not render Markdown;
 * headings, emphasis, links, code fences, and tables are flattened. The
 * internal [[qq_forward]] markers are preserved (handled before this runs).
 * @param text - model-produced Markdown text.
 * @returns plain text for QQ.
 */
export function stripMarkdown(text: string): string {
  let out = text
    // Code fences: keep the inner text, drop the fence lines.
    .replace(/\x60\x60\x60[^\n]*\n([\s\S]*?)\x60\x60\x60/g, (_, body: string) => body + '\n')
    .replace(/\x60\x60\x60([\s\S]*?)\x60\x60\x60/g, '$1')
    // Inline code: keep content, drop backticks.
    .replace(/\x60([^\x60\n]+)\x60/g, '$1')
    // Headings.
    .replace(/^#{1,6}[ \t]+/gm, '')
    // Emphasis.
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(^|[^_])_([^_]+)_([^_]|$)/g, '$1$2$3')
    .replace(/~~([^~]+)~~/g, '$1')
    // Links and images.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1 ($2)')
    // Blockquote markers.
    .replace(/^[ \t]*>[ \t]?/gm, '')
    // Table rows: keep cell text separated by spaces; drop divider rows.
    .split('\n')
    .map(line => {
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('|') && !line.includes('\n')) {
        const cells = line.split('|').filter(c => c.trim() !== '')
        if (cells.every(c => /^:?-{2,}:?$/.test(c.trim()))) return ''
      }
      if (line.trim().startsWith('|')) {
        return line.split('|').map(c => c.trim()).filter(c => c !== '').join(' ')
      }
      return line
    })
    .filter(line => line !== '')
    .join('\n')
    // Horizontal rules.
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    // Collapse 3+ blank lines.
    .replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/** One [[qq_forward]] block: a named message node. */
export interface ForwardNode {
  name: string
  content: string
}

/** The [[qq_forward]] marker regex (imported from cq.ts for single sourcing). */
import { FORWARD_BLOCK_RE } from './cq.js'
export { FORWARD_BLOCK_RE }

/**
 * Extract [[qq_forward]] blocks from reply text. The blocks are removed from
 * the returned body text; empty-name blocks default the sender name.
 * @param text - the reply text (before Markdown stripping).
 * @param defaultName - node name when the block omits one.
 * @returns body text without blocks, plus the parsed nodes.
 */
export function extractForwardBlocks(text: string, defaultName: string): { body: string; nodes: ForwardNode[] } {
  const nodes: ForwardNode[] = []
  const body = text.replace(FORWARD_BLOCK_RE, (_, block: string) => {
    const trimmed = block.trim()
    if (trimmed === '') return ''
    const lines = trimmed.split('\n')
    const first = lines[0].trim()
    let name = defaultName
    let content = trimmed
    if (first.length <= 24 && !first.includes('：') && !first.includes(':') && lines.length > 1) {
      name = first
      content = lines.slice(1).join('\n').trim()
    }
    if (content !== '') nodes.push({ name, content })
    return ''
  })
  return { body, nodes }
}

/** Sensitive-intent audit: log a WARNING when outbound text matches. */
const DEFAULT_SENSITIVE_PATTERNS = [
  /(?:rm\s+-rf|format\s+[a-z]:|diskpart|mkfs\.)/i,
  /(?:shutdown|reboot|poweroff|init\s+0)/i,
  /(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)/i,
  /(?:sk-|ghp_|api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S+/i,
]

/**
 * Check outbound text against sensitive patterns (soft audit, non-blocking).
 * @param text - outbound text.
 * @param patterns - configured patterns; empty list disables the audit.
 * @returns matched patterns (strings), or [] when clean or disabled.
 */
export function scanSensitive(text: string, patterns: readonly string[]): string[] {
  const list = patterns.length > 0 ? patterns : DEFAULT_SENSITIVE_PATTERNS
  const hits: string[] = []
  for (const p of list) {
    const re = p instanceof RegExp ? p : new RegExp(p, 'i')
    if (re.test(text)) hits.push(String(p))
  }
  return hits
}
