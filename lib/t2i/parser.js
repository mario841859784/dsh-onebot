/**
 * Markdown parsing for the t2i card renderer (port of t2i_render.py's
 * parse_inline / MarkdownParser / _literal_n_to_newlines). Links and images
 * are intentionally left as literal text (original limitation, §6).
 * @module dsh-onebot/t2i/parser
 */
/**
 * Convert literal "\\n" sequences in LLM output to real newlines.
 * Inline-code segments are protected first (their literal \\n becomes a
 * space, since a capsule cannot contain line breaks); a double backslash
 * before n ("\\\\n") is preserved untouched.
 * @param text - model-produced text.
 * @returns text with literal newlines converted.
 */
export function literalNToNewlines(text) {
    const held = [];
    const protect = (segment) => {
        const fixed = segment.replace(/(?<!\\)\\n/g, ' ');
        held.push(fixed);
        return '\x00CODE' + (held.length - 1) + '\x00';
    };
    const protectedText = text.replace(/\x60[^\x60\n]*\x60/g, protect);
    const converted = protectedText.replace(/(?<!\\)\\n/g, '\n');
    return converted.replace(/\x00CODE(\d+)\x00/g, (_, index) => held[Number(index)] ?? '');
}
/** Inline style patterns, in the original order (__ maps to BOLD, per code). */
const INLINE_PATTERNS = [
    { pattern: /\*\*([\s\S]*?)\*\*/g, cls: 'bold' },
    { pattern: /\*(?!\*)([\s\S]*?)\*/g, cls: 'italic' },
    { pattern: /(?<![A-Za-z0-9])__([\s\S]*?)__(?![A-Za-z0-9])/g, cls: 'bold' },
    { pattern: /(?<![A-Za-z0-9])_(?!_)([\s\S]*?)_(?![A-Za-z0-9])/g, cls: 'italic' },
    { pattern: /~~([\s\S]*?)~~/g, cls: 'strike' },
    { pattern: /\x60([^\x60\n]*)\x60/g, cls: 'code' },
];
/**
 * Parse inline styles in one line into a part sequence. Overlapping markers
 * keep the outermost match (the original filters by non-overlapping order).
 * @param line - one line of text.
 * @returns inline parts.
 */
export function parseInline(line) {
    const markers = [];
    for (const { pattern, cls } of INLINE_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
            const start = match.index ?? 0;
            markers.push({ start, end: start + match[0].length, text: match[1], cls });
        }
    }
    if (markers.length === 0)
        return [{ cls: null, content: line }];
    markers.sort((a, b) => a.start - b.start || a.end - b.end);
    const filtered = [];
    let lastEnd = 0;
    for (const marker of markers) {
        if (marker.start >= lastEnd) {
            filtered.push(marker);
            lastEnd = marker.end;
        }
    }
    const out = [];
    let cursor = 0;
    for (const marker of filtered) {
        if (marker.start > cursor) {
            const gap = line.slice(cursor, marker.start);
            if (gap !== '')
                out.push({ cls: null, content: gap });
        }
        out.push({ cls: marker.cls, content: marker.text });
        cursor = marker.end;
    }
    if (cursor < line.length)
        out.push({ cls: null, content: line.slice(cursor) });
    return out;
}
/** Table separator detection. */
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|?\s*$/;
function isTableSeparator(line) {
    if (!line.includes('|') || !line.includes('-'))
        return false;
    return TABLE_SEP_RE.test(line);
}
/** Parse one table row into cells. */
export function parseTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|'))
        s = s.slice(1);
    if (s.endsWith('|'))
        s = s.slice(0, -1);
    return s.split('|').map(cell => cell.trim());
}
/**
 * Parse markdown text into block elements (port of MarkdownParser.parse).
 * @param text - the markdown text.
 * @returns block elements.
 */
export function parseBlocks(text) {
    const elements = [];
    const lines = text.split('\n');
    let i = 0;
    let orderedCounter = 0;
    while (i < lines.length) {
        const line = lines[i].replace(/\s+$/, '');
        // Table: current line has | and the next is a separator row.
        if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
            const header = parseTableRow(line);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                rows.push(parseTableRow(lines[i]));
                i += 1;
            }
            elements.push({ kind: 'table', header, rows });
            continue;
        }
        if (line.trim() === '') {
            elements.push({ kind: 'text', content: '' });
            i += 1;
            continue;
        }
        if (line.startsWith('#')) {
            let level = 0;
            while (level < line.length && line[level] === '#')
                level += 1;
            elements.push({ kind: 'header', content: line.slice(level).trim(), level: Math.min(level, 6) });
            i += 1;
            continue;
        }
        if (line.startsWith('>')) {
            elements.push({ kind: 'quote', content: line.replace(/^>+/, '').trim() });
            i += 1;
            continue;
        }
        if (line.startsWith('\x60\x60\x60')) {
            const codeLines = [];
            i += 1;
            while (i < lines.length && !lines[i].startsWith('\x60\x60\x60')) {
                codeLines.push(lines[i]);
                i += 1;
            }
            i += 1;
            elements.push({ kind: 'code', content: codeLines.join('\n') });
            continue;
        }
        const ulMatch = /^\s*[-*+]\s+/.exec(line);
        if (ulMatch !== null) {
            elements.push({ kind: 'list', content: line.replace(/^\s*[-*+]\s+/, '') });
            i += 1;
            continue;
        }
        const olMatch = /^\s*(\d+)[.)]\s+/.exec(line);
        if (olMatch !== null) {
            orderedCounter = Number(olMatch[1]);
            elements.push({ kind: 'ordered', content: line.slice(olMatch[0].length), number: orderedCounter });
            i += 1;
            continue;
        }
        elements.push({ kind: 'text', content: line });
        i += 1;
    }
    return elements;
}
