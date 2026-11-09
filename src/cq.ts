/**
 * OneBot 11 message parsing: CQ-code unescaping, segment-array → text/media
 * extraction, mention detection, and face-id → emoji mapping. Ported from the
 * Hermes onebot_utils.py (CQ parsing half). Pure functions, no I/O.
 * @module dsh-onebot/cq
 */

import { QQ_FACES } from './qq-faces.js'

/** One OneBot 11 message segment. */
export interface OneBotSegment {
  type: string
  data: Record<string, string>
}

/** A media reference extracted from an inbound message, resolved by media.ts. */
export interface MediaRef {
  kind: 'image' | 'voice' | 'video' | 'file'
  /** Remote URL to download (image/voice/video). */
  url?: string
  /** raw file field: base64://..., file://..., or a hash. */
  file?: string
  /** OneBot file_id (NapCat file segments carry the real id here). */
  fileId?: string
  name?: string
  subType?: string
  /** Stickers only: the exact `[表情包...]` text parseMessage wrote for this ref,
   * so buildBody swaps this ref's own slot and not the next photo's `[图片]`. */
  stickerLabel?: string
}

/** A fully parsed inbound message. */
export interface ParsedMessage {
  /** Plain text with media placeholders, ready for the agent. */
  text: string
  media: MediaRef[]
  /** OneBot message_id of the quoted (reply) message, if any. */
  replyId?: string
  /** OneBot forward id embedded in the message, if any. */
  forwardId?: string
}

/**
 * Reverse the CQ escaping NapCat applies inside attribute values
 * (&amp; → &, &#91; → [, &#93; → ], &#44; → ,). Skipping this broke
 * image-CDN downloads with a 403 (the & in signed URLs arrived escaped).
 * @param value - raw CQ attribute value or text.
 * @returns unescaped value.
 */
export function cqUnescape(value: string): string {
  return value
    .replaceAll('&#91;', '[')
    .replaceAll('&#93;', ']')
    .replaceAll('&#44;', ',')
    .replaceAll('&amp;', '&')
}


/** QQ face id → emoji (common set; unknown ids fall back to a neutral face). */
const FACE_EMOJI: Record<string, string> = {
  '0': '😀', '1': '😁', '2': '😂', '3': '🤣', '4': '😃', '5': '😄', '6': '😅', '7': '😆',
  '8': '😉', '9': '😊', '10': '😋', '11': '😎', '12': '😍', '13': '😘', '14': '🥰', '15': '😗',
  '18': '😙', '19': '😚', '20': '😐', '21': '😑', '22': '😶', '23': '😏', '24': '😣', '25': '😥',
  '26': '😮', '27': '🤐', '28': '😯', '29': '😪', '30': '😫', '31': '🥱', '32': '😴', '33': '😌',
  '34': '😛', '35': '😜', '36': '😝', '37': '🤤', '38': '😒', '39': '😓', '40': '😔', '41': '😕',
  '42': '🙃', '43': '🤑', '44': '😲', '45': '☹️', '46': '🙁', '47': '😖', '48': '😞', '49': '😟',
  '50': '😤', '51': '😢', '52': '😭', '53': '😦', '54': '😧', '55': '😨', '56': '😩', '57': '🤯',
  '58': '😬', '59': '😰', '60': '😱', '61': '🥵', '62': '🥶', '63': '😳', '64': '🤪', '65': '😵',
  '66': '😡', '67': '😠', '68': '🤬', '69': '😷', '70': '🤒', '71': '🤕', '72': '🤢', '73': '🤮',
  '74': '🥳', '75': '🥴', '76': '😺', '77': '😸', '78': '😹', '79': '😻', '80': '😼', '81': '😽',
  '82': '🙀', '83': '😿', '84': '😾', '96': '🙈', '97': '🙉', '98': '🙊', '99': '💋',
  '100': '💘', '101': '💝', '102': '💖', '103': '💗', '104': '💓', '105': '💞', '106': '💕',
  '107': '💌', '108': '💔', '109': '💟', '110': '❤️', '111': '🧡', '112': '💛', '113': '💚',
  '114': '💙', '115': '💜', '116': '🤎', '117': '🖤', '118': '🤍', '121': '👍', '122': '👎',
  '123': '👌', '124': '👏', '125': '🙏', '126': '🤝', '127': '💪', '128': '🤙', '129': '✌️',
  '130': '🤞', '131': '🖕', '132': '🤟', '133': '🤘', '134': '🤛', '135': '🤜', '136': '👈',
  '137': '👉', '138': '👆', '139': '👇', '140': '☝️', '141': '✋', '142': '🤚', '143': '🖐️',
  '144': '🖖', '145': '👋', '146': '🤗', '147': '🤔', '148': '🤫', '149': '🤭', '150': '🤥',
  '151': '🤨', '152': '🧐', '153': '🤓', '154': '😈', '155': '👿', '156': '👹', '157': '👺',
  '158': '💀', '159': '👻', '160': '👽', '161': '🤖', '170': '👶', '171': '👧',
  '172': '🧒', '173': '👦', '174': '👩', '175': '🧑', '176': '👨', '177': '👵', '178': '🧓',
  '179': '👴', '180': '👲', '181': '👳', '182': '🧕', '183': '👮', '184': '👷', '185': '💂',
  '186': '🕵️', '199': '👩‍🏭', '200': '👨‍🏭', '201': '👩‍💻', '202': '👨‍💻', '203': '👩‍💼',
  '204': '👨‍💼', '205': '👩‍🔧', '206': '👨‍🔧', '207': '👩‍🔬', '208': '👨‍🔬', '209': '👩‍🎨',
  '210': '👨‍🎨', '211': '👩‍🚒', '212': '👨‍🚒', '213': '👩‍✈️', '214': '👨‍✈️', '215': '👩‍🚀',
  '216': '👨‍🚀', '217': '👩‍⚖️', '218': '👨‍⚖️', '219': '🦸', '225': '🦹', '231': '🧙',
  '237': '🧚', '243': '🧛', '249': '🧜', '255': '🧞', '261': '🧟', '267': '🦄',
  '268': '🦍', '269': '🐶', '270': '🐱', '271': '🦁', '272': '🐯', '273': '🐨',
  '274': '🐼', '275': '🐻', '276': '🦊', '277': '🐸', '278': '🐵', '279': '🐔',
  '280': '🐧', '281': '🐦', '282': '🐤', '283': '🦆', '284': '🦅', '285': '🦉',
  '286': '🐴', '287': '🦄', '288': '🐝', '289': '🐛', '290': '🦋', '291': '🐌',
  '292': '🐞', '293': '🐜', '294': '🦟', '295': '🦗', '296': '🕷️', '297': '🦂',
  '298': '🐢', '299': '🐍', '300': '🦎', '301': '🦖', '302': '🦕', '303': '🐙',
  '304': '🦑', '305': '🦐', '306': '🦞', '307': '🦀', '308': '🐡', '309': '🐠',
  '310': '🐟', '311': '🐬', '312': '🐳', '313': '🐋', '314': '🦈', '315': '🐊',
  '316': '🐅', '317': '🐆', '318': '🦓', '319': '🦌', '320': '🦙', '321': '🐪',
  '322': '🐫', '323': '🦒', '324': '🐘', '325': '🦏', '326': '🦛', '327': '🐭',
  '328': '🐹', '329': '🐰', '330': '🐿️', '331': '🦔', '332': '🦇', '333': '🐻',
  '334': '🐺', '335': '🐗', '336': '🐮', '337': '🐷', '338': '🐽', '339': '🐏',
  '340': '🐑', '341': '🐐', '342': '🐪', '343': '🐂', '344': '🐃', '345': '🐄',
  '346': '🐎', '347': '🐖', '348': '🐀', '349': '🐁', '350': '🐈', '351': '🐩',
  '352': '🐕', '353': '🐓', '354': '🦃', '355': '🦚', '356': '🦜', '357': '🦢',
  '358': '🦩', '359': '🕊️', '360': '🐇', '361': '🦝', '362': '🦨', '363': '🦡',
  '364': '🦦', '365': '🦥', '366': '🐁', '367': '🐉', '368': '🐲', '369': '🐢',
}

// T6（PR port 官方表情名表）：上面那张 emoji 对照是硬凑的，遇到表外的 id
// 全塌成一个😀，对话里看不出对方发了什么。QQ 官方名表（NapCat 自带名，源自
// 贡献者 qq-faces.json）随包内置为 src/qq-faces.ts，按 id 查名字，形如「[微笑]」。

/** 表情呈现风格：'name' 用官方名（默认），'emoji' 用上面那张 emoji 对照表。 */
let faceStyle: 'name' | 'emoji' = 'name'

/** Set the face presentation style (T6 PR port faceStyle 配置；非法值回落 'name'). */
export function setFaceStyle(style: string | undefined | null): void {
  faceStyle = style === 'emoji' ? 'emoji' : 'name'
}

/** The built-in official QQ face name table (T6 PR port；测试/工具面). */
export function faceNames(): Readonly<Record<string, string>> {
  return QQ_FACES
}

/** Map a QQ face id to its presentation text, with a fallback for unknown ids.
 * faceStyle='name'（默认）：官方名「[微笑]」，表外 id 降级「[表情id]」；
 * faceStyle='emoji'：旧 emoji 对照表，表外 id 降级 😀。 */
export function faceToEmoji(id: string): string {
  if (faceStyle === 'name') {
    const name = QQ_FACES[String(id)]
    if (typeof name === 'string' && name !== '') return '[' + name + ']'
    return '[表情' + id + ']'
  }
  return FACE_EMOJI[id] ?? '😀'
}

const CQ_AT_RE = /\[CQ:at,qq=([^,\]]+)\]/g

/**
 * Detect explicit @bot / @all only; a reply segment never implies an @.
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 * @returns whether this message explicitly mentions the known bot.
 */
export function detectExplicitMention(
  segments: OneBotSegment[] | undefined,
  raw: string,
  selfId: string,
  botQQ: string,
  atAllCounts = false,
): boolean {
  const bot = selfId !== '' ? selfId : botQQ
  if (bot === '') return false
  if (segments !== undefined) {
    return segments.some(seg => seg.type === 'at' && (seg.data.qq === bot || (atAllCounts && seg.data.qq === 'all')))
  }
  CQ_AT_RE.lastIndex = 0
  for (const m of raw.matchAll(CQ_AT_RE)) {
    if (m[1] === bot || (atAllCounts && m[1] === 'all')) return true
  }
  return false
}

/**
 * T1 (PR port): 唤醒词命中判定——只认消息开头命中。用 startsWith 而非
 * includes：消息正文里偶然提到唤醒词（如有人在句中写到唤醒词）不再误触；
 * 大小写不敏感、两侧空白忽略；空词表恒 false。
 * @param text - 消息纯文本（segmentText 结果）。
 * @param names - 唤醒词表（管理员档或成员档）。
 * @returns 是否以任一唤醒词开头。
 */
export function detectWakeName(text: string, names: readonly string[]): boolean {
  const needle = text.trim().toLowerCase()
  if (needle === '') return false
  return names.some(name => {
    const wake = name.trim().toLowerCase()
    return wake !== '' && needle.startsWith(wake)
  })
}

/**
 * Detect explicit mentions or a reply with a known bot author, fail-closed.
 * A standard OneBot reply contains only an id; the inbound group gate must
 * resolve its author through get_msg before allowing a reply-only trigger.
 * @param segments - preferred OneBot segment array.
 * @param raw - CQ string fallback.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured fallback bot QQ id.
 * @param options - T1 (PR port) 引用即叫/@全体即叫 开关（缺省=上游语义）。
 * @returns false for replies whose author cannot be determined synchronously.
 */
export function detectMention(
  segments: OneBotSegment[] | undefined,
  raw: string,
  selfId: string,
  botQQ: string,
  options: { reply?: boolean; atAll?: boolean } = {},
): boolean {
  if (detectExplicitMention(segments, raw, selfId, botQQ, options.atAll === true)) return true
  const bot = selfId !== '' ? selfId : botQQ
  if (bot === '') return false
  const list = segments !== undefined ? segments : parseCqString(raw)
  // T1 (PR port): 引用即叫——任何回复都算叫机器人，作者核实交由上游
  // skipQuoteVerify 跳过（见 inbound.ts 的 requireMention 复核块）。
  if (options.reply === true) return list.some(seg => seg.type === 'reply')
  // A bare reply id contains no author information and cannot imply mention.
  return list.some(seg => seg.type === 'reply' && String(seg.data.qq ?? '') === bot)
}

/**
 * Drop the bot's own @ from the start of parsed text. Goes by the first segment,
 * not a text prefix: with bot 10002, "@100021" is either @10002 followed by "1"
 * or an @ of member 100021, and the text alone cannot tell them apart.
 * @param text - parsed text from parseMessage for this same message.
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 * @returns the text after the mention, or the text unchanged when the message
 *   does not start with an @ of the bot.
 */
export function stripLeadingBotMention(
  text: string,
  segments: OneBotSegment[] | undefined,
  raw: string,
  selfId: string,
  botQQ: string,
): string {
  const bot = selfId !== '' ? selfId : botQQ
  if (bot === '') return text
  const first = (segments !== undefined && segments.length > 0 ? segments : parseCqString(raw))[0]
  if (first?.type !== 'at' || first.data.qq !== bot) return text
  return text.slice(bot.length + 1)
}

/** Split a raw CQ string into segments; used only when no segment array exists. */
export function parseCqString(raw: string): OneBotSegment[] {
  const segments: OneBotSegment[] = []
  const re = /\[CQ:([a-z]+),([^\]]*)\]/g
  let last = 0
  for (const m of raw.matchAll(re)) {
    if (m.index !== undefined && m.index > last) {
      segments.push({ type: 'text', data: { text: raw.slice(last, m.index) } })
    }
    const data: Record<string, string> = {}
    for (const pair of m[2].split(',')) {
      const eq = pair.indexOf('=')
      if (eq > 0) data[pair.slice(0, eq)] = cqUnescape(pair.slice(eq + 1))
    }
    segments.push({ type: m[1], data })
    last = (m.index ?? 0) + m[0].length
  }
  if (last < raw.length) {
    segments.push({ type: 'text', data: { text: raw.slice(last) } })
  }
  return segments
}

/** QQ card fields written for people, in display order. Avatars, previews and icons never qualify. */
const CARD_TEXT_KEYS = ['tag', 'source', 'title', 'nickname', 'name', 'desc', 'contact', 'address', 'text', 'content']
/** QQ card fields that say where the card leads. */
const CARD_LINK_KEYS = ['qqdocurl', 'jumpUrl', 'jumpurl', 'jump_url', 'doc_url', 'url']
/** A card nothing readable could be taken from. */
const CARD_PLACEHOLDER = '[卡片]'
/** Caps: code points per field, code points of all fields joined, how many fields, link length. */
const CARD_MAX_FIELD = 160
const CARD_MAX_TEXT = 360
const CARD_MAX_FIELDS = 5
const CARD_MAX_LINK = 200
/** A link must already be free of everything cardPlain would have to rewrite. */
const CARD_LINK_RE = /^https?:\/\/[^\s<>"\[\]\p{Cc}\p{Cf}]+$/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Cap at a code-point count so an astral character is never cut in half. */
function capChars(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('').trimEnd()
}

/**
 * Undo CQ and XML escaping, every nested layer at once. expandQuote and
 * qq_group_history run cqUnescape over the parsed text, so an &#91; left in a
 * card (or &amp;#91;, at any depth) would come back as a real [ there.
 */
function cardUnescape(value: string): string {
  return cqUnescape(value.replace(/&(?:amp;)+/g, '&'))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

/**
 * Reduce one card field to a single line. Cards are written by other people:
 * square brackets could pass for this plugin's own markers ([图片:path]) and
 * take a media slot in buildBody, angle brackets could pass for the
 * user_message boundary, invisible characters could hide text from a reader.
 * They go first, or removing one could join a broken-up escape back together.
 */
function cardPlain(value: string): string {
  const flat = cardUnescape(value.replace(/\p{Cf}/gu, ''))
    .replace(/\p{Cc}/gu, ' ')
    .replaceAll('<', '＜')
    .replaceAll('>', '＞')
    .replaceAll('[', '（')
    .replaceAll(']', '）')
    .replace(/\s+/g, ' ')
    .trim()
  return capChars(flat, CARD_MAX_FIELD)
}

/** The strings a card object holds under these keys, in key order. */
function cardStrings(source: Record<string, unknown> | undefined, keys: readonly string[]): string[] {
  if (source === undefined) return []
  return keys.map(key => source[key]).filter((value): value is string => typeof value === 'string')
}

/** Assemble the card text from fields already through cardPlain and raw link candidates. */
function cardText(fields: readonly string[], links: readonly string[]): string {
  const kept = [...new Set(fields)].filter(field => field !== '').slice(0, CARD_MAX_FIELDS)
  const link = links.map(cardUnescape).find(url => url.length <= CARD_MAX_LINK && CARD_LINK_RE.test(url))
  const body = [capChars(kept.join(' · '), CARD_MAX_TEXT), link ?? ''].filter(part => part !== '').join(' ')
  return body === '' ? CARD_PLACEHOLDER : '[卡片:' + body + ']'
}

/**
 * Readable text of a json segment: text fields of the first object in meta,
 * one level deeper when that object has none, then prompt, then desc.
 * @param raw - the segment's data field (a JSON string; some implementations may parse it).
 * @returns '[卡片:...]', or '[卡片]' when nothing readable can be taken from it.
 */
function cardFromJson(raw: unknown): string {
  let card = raw
  if (typeof card === 'string') {
    try {
      card = JSON.parse(card)
    } catch {
      return CARD_PLACEHOLDER
    }
  }
  if (!isRecord(card)) return CARD_PLACEHOLDER
  const block = isRecord(card.meta) ? Object.values(card.meta).find(isRecord) : undefined
  const inner = block !== undefined ? Object.values(block).find(isRecord) : undefined
  const plain = (source: Record<string, unknown> | undefined, keys: readonly string[]): string[] =>
    cardStrings(source, keys).map(cardPlain).filter(field => field !== '')
  const fields = [plain(block, CARD_TEXT_KEYS), plain(inner, CARD_TEXT_KEYS), plain(card, ['prompt']), plain(card, ['desc'])]
    .find(list => list.length > 0) ?? []
  return cardText(fields, [...cardStrings(block, CARD_LINK_KEYS), ...cardStrings(inner, CARD_LINK_KEYS)])
}

/**
 * Readable text of an xml segment: brief, title, summary and the url attribute.
 * @param raw - the segment's data field.
 * @returns '[卡片:...]', or '[卡片]' when nothing readable can be taken from it.
 */
function cardFromXml(raw: unknown): string {
  if (typeof raw !== 'string') return CARD_PLACEHOLDER
  const attr = (name: string): string | undefined => {
    const m = new RegExp('(?:\\s|^)' + name + '=(?:"([^"]*)"|\'([^\']*)\')').exec(raw)
    return m?.[1] ?? m?.[2]
  }
  // [^<>] and [^<] stop at the next tag, which keeps the scan linear on hostile input.
  const tag = (name: string): string | undefined =>
    new RegExp('<' + name + '\\b[^<>]*>([^<]*)</' + name + '>').exec(raw)?.[1]
  const fields = [attr('brief'), tag('title'), tag('summary')].map(value => cardPlain(value ?? ''))
  return cardText(fields, [attr('url') ?? ''])
}

/**
 * Parse a OneBot message (segment array preferred, CQ string fallback) into
 * text + media references. Media appear as placeholders in the text; media.ts
 * resolves each ref to a local path afterwards.
 * @param segments - message segment array (preferred).
 * @param raw - raw CQ string (fallback / complement).
 * @returns parsed text, media refs, and the quoted message id.
 */
export function parseMessage(segments: OneBotSegment[] | undefined, raw: string): ParsedMessage {
  const textParts: string[] = []
  const media: MediaRef[] = []
  let replyId: string | undefined
  let forwardId: string | undefined

  const appendImage = (data: Record<string, string>): void => {
    const subType = data.sub_type ?? data['sub-type']
    const ref: MediaRef = { kind: 'image', url: data.url || undefined, file: data.file || undefined, subType }
    if (String(subType) === '1') {
      // Sticker: keep the image entry (some setups can only see it this way)
      // and label it with the file/url like the [文件:...] tag style.
      const label = data.file || data.url
      ref.stickerLabel = label ? `[表情包:${label}]` : '[表情包]'
      textParts.push(ref.stickerLabel)
    } else {
      textParts.push('[图片]')
    }
    media.push(ref)
  }

  const list = segments !== undefined && segments.length > 0 ? segments : parseCqString(raw)
  for (const seg of list) {
    switch (seg.type) {
      case 'text':
        if (seg.data.text !== '') textParts.push(seg.data.text)
        break
      case 'image':
        appendImage(seg.data)
        break
      case 'face':
        textParts.push(faceToEmoji(seg.data.id ?? ''))
        break
      case 'record':
        media.push({ kind: 'voice', url: seg.data.url || undefined, file: seg.data.file || undefined })
        textParts.push('[语音]')
        break
      case 'video':
        media.push({ kind: 'video', url: seg.data.url || undefined, file: seg.data.file || undefined })
        textParts.push('[视频]')
        break
      case 'file':
        // NapCat's file segment: `file` holds the file NAME (not a path),
        // `file_id` the real id, `name` is usually absent. Keep the raw
        // fields for media.ts; the display name falls back to `file`.
        media.push({
          kind: 'file',
          url: seg.data.url || undefined,
          file: seg.data.file || undefined,
          fileId: seg.data.file_id || undefined,
          name: seg.data.name || seg.data.file || undefined,
        })
        textParts.push(seg.data.name || seg.data.file ? `[文件:${seg.data.name || seg.data.file}]` : '[文件]')
        break
      case 'at': {
        const qq = seg.data.qq ?? ''
        textParts.push(qq === 'all' ? '@全体成员' : `@${qq}`)
        break
      }
      case 'reply':
        if (seg.data.id !== undefined) {
          replyId = seg.data.id
          textParts.push('[引用]')
        }
        break
      case 'forward':
        // NapCat uses `id`; go-cqhttp-style implementations may use `resId`.
        if (seg.data.id !== undefined || seg.data.resId !== undefined) {
          forwardId = seg.data.id ?? seg.data.resId
          textParts.push('[合并转发]')
        }
        break
      case 'json':
        textParts.push(cardFromJson(seg.data.data))
        break
      case 'xml':
        textParts.push(cardFromXml(seg.data.data))
        break
      case 'mface':
        // Market sticker: keep the image when a url exists, label it like a sticker.
        if (seg.data.url) {
          const stickerLabel = `[表情包:${seg.data.url}]`
          media.push({ kind: 'image', url: seg.data.url, file: seg.data.file || undefined, stickerLabel })
          textParts.push(stickerLabel)
        } else {
          textParts.push('[表情包]')
        }
        break
      case 'poke':
        textParts.push('[戳一戳]')
        break
      case 'contact':
        textParts.push(seg.data.name ? `[联系人:${seg.data.name}]` : '[联系人]')
        break
      case 'location':
        textParts.push('[位置]')
        break
      case 'share':
        textParts.push(seg.data.title ? `[分享:${seg.data.title}]` : '[分享]')
        break
      default:
        // Unknown segment types keep their placeholder role; no crash.
        textParts.push(`[${seg.type}]`)
        break
    }
  }

  const text = textParts.join('').trim()
  return { text, media, replyId, forwardId }
}

/** Extract the plain text of a quoted (get_msg) message for [引用] expansion. */
export function segmentText(segments: OneBotSegment[] | undefined, raw: string): string {
  return parseMessage(segments, raw).text
}

/** Marker regex shared with split.ts (outbound [[qq_forward]]). */
export const FORWARD_BLOCK_RE = /\[\[qq_forward\]\]([\s\S]*?)\[\[\/qq_forward\]\]/g
