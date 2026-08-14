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
/** Summed width of a plain text run. */
export function textWidth(source, text, size) {
    let total = 0;
    for (const ch of text)
        total += source.charWidth(ch, size, false);
    return total;
}
/** Summed width of a code content run (mono/small-CJK widths). */
export function codeWidth(source, text, size) {
    let total = 0;
    for (const ch of text)
        total += source.charWidth(ch, size, true);
    return total;
}
/**
 * The ACTUAL drawn width of one inline part (the _seg_width port):
 * code capsule = code width + 14 (pad_x*2 + 2), bold = width + 1,
 * italic = width + 8 (shear overhang), plain = width.
 * @param part - the inline part.
 * @param source - width source.
 * @param size - font size in px.
 * @returns drawn width in px.
 */
export function segWidth(part, source, size) {
    if (part.cls === 'code')
        return codeWidth(source, part.content, size) + 14;
    if (part.cls === 'bold')
        return textWidth(source, part.content, size) + 1;
    if (part.cls === 'italic')
        return textWidth(source, part.content, size) + 8;
    return textWidth(source, part.content, size);
}
/**
 * Characters that must never start a line (CJK punctuation prohibition).
 * Ported verbatim from the Python _HEAD_BANNED.
 */
export const HEAD_BANNED = new Set('，。：；！？、）」』】》〉》」』﹂〕%‰℃:;!?.,…—・·');
/**
 * Greedy line-breaking that prefers spaces, honors the head-ban, and hard-
 * cuts only as a last resort (port of TextMeasurer.split_to_fit).
 * @param text - the text to break.
 * @param maxWidth - available width.
 * @param width - per-character width function (NOT the summed run width).
 * @returns lines.
 */
export function splitToFit(text, maxWidth, width) {
    if (text === '')
        return [];
    const lines = [];
    let cur = '';
    let curW = 0;
    let lastSpace = -1;
    for (const ch of text) {
        const w = width(ch);
        if (cur !== '' && curW + w > maxWidth) {
            // Head-ban: a trailing punctuation char must not start the next line;
            // carry it down together with its host character.
            if (HEAD_BANNED.has(ch)) {
                const prev = cur[cur.length - 1];
                if (prev !== undefined && !HEAD_BANNED.has(prev) && prev !== ' ') {
                    lines.push(cur.slice(0, -1));
                    cur = prev + ch;
                    curW = width(prev) + w;
                    lastSpace = -1;
                    continue;
                }
                // Consecutive punctuation/space tail: fold in (slight overflow ok).
                cur += ch;
                curW += w;
                continue;
            }
            // Prefer breaking at the last space to keep whole words together.
            if (lastSpace > 0) {
                const head = cur.slice(0, lastSpace);
                const tail = cur.slice(lastSpace + 1);
                const newW = textWidthOf(tail, width) + w;
                if (head !== '' && newW <= maxWidth) {
                    lines.push(head);
                    cur = tail + ch;
                    curW = newW;
                    lastSpace = cur.lastIndexOf(' ');
                    continue;
                }
                // Fallback failed (empty head or still overflowing) → hard cut.
            }
            lines.push(cur);
            cur = ch;
            curW = w;
            lastSpace = -1;
        }
        else {
            cur += ch;
            curW += w;
            if (ch === ' ')
                lastSpace = cur.length - 1;
        }
    }
    if (cur !== '')
        lines.push(cur);
    return lines;
}
/** Width of a text run via the per-char function. */
function textWidthOf(text, width) {
    let total = 0;
    for (const ch of text)
        total += width(ch);
    return total;
}
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
export function splitInlineLines(parts, maxWidth, source, size) {
    const lines = [[]];
    let curW = 0;
    for (const part of parts) {
        const content = part.content.replaceAll('\n', ' ');
        if (content === '')
            continue;
        const reserve = part.cls === 'code' ? 14 : part.cls === 'italic' ? 8 : part.cls === 'bold' ? 1 : 0;
        const widthFn = (ch) => source.charWidth(ch, size, part.cls === 'code');
        const segments = splitToFit(content, maxWidth - reserve, widthFn);
        for (const seg of segments) {
            const segPart = { cls: part.cls, content: seg };
            const w = segWidth(segPart, source, size);
            if (lines[lines.length - 1].length > 0 && curW + w > maxWidth) {
                // Cross-element head-ban: plain segments shed a leading punctuation
                // prefix onto the previous line (slight overflow accepted); styled
                // segments are content-atomic and wrap whole.
                if (part.cls === null && seg.length > 0 && HEAD_BANNED.has(seg[0])) {
                    let i = 0;
                    while (i < seg.length && HEAD_BANNED.has(seg[i]))
                        i += 1;
                    const punct = seg.slice(0, i);
                    const rest = seg.slice(i);
                    if (punct !== '') {
                        lines[lines.length - 1].push({ cls: null, content: punct });
                        curW += textWidth(source, punct, size);
                    }
                    if (rest !== '') {
                        lines.push([]);
                        curW = 0;
                        lines[lines.length - 1].push({ cls: null, content: rest });
                        curW += textWidth(source, rest, size);
                    }
                    continue;
                }
                lines.push([]);
                curW = 0;
            }
            lines[lines.length - 1].push(segPart);
            curW += w;
        }
    }
    // Merge adjacent same-class segments (long code re-glued into one capsule).
    const merged = [];
    for (const line of lines) {
        const mline = [];
        for (const part of line) {
            const last = mline[mline.length - 1];
            if (last !== undefined && last.cls === part.cls) {
                mline[mline.length - 1] = { cls: part.cls, content: last.content + part.content };
            }
            else {
                mline.push(part);
            }
        }
        merged.push(mline);
    }
    return merged.filter(line => line.length > 0);
}
