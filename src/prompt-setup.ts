/**
 * T4 (PR port 提示词文件): PromptLoader — per-kind (group:/dm:) extra prompt
 * files and memory files, composed when the channel scope is installed on a
 * session agent. Ported from the external contribution's
 * lib/local/prompt-setup.js with the review-mandated fixes:
 * 1. readFileCached invalidates by mtime (the contribution cached forever —
 *    an edited prompt file was only picked up after a plugin reload);
 * 2. build() keys on the chat id prefix (group:/dm:) to pick the file;
 * 3. the memory read is synchronous — the contribution's async snapshot
 *    pattern ("return the previous value, refresh in background") left the
 *    first turn's memory empty.
 * 配置放「会话组」（index.ts schema）；记忆只喂私聊且开关默认关（裁定口径，
 * 与贡献者的缺省开启不同）。
 * @module dsh-onebot/prompt-setup
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ChannelLog } from './prompt.js'
import { readMemoryFiles } from './prompt.js'
import { describeError } from './errors.js'

/** Strip the per-line leading/trailing whitespace of a prompt file (templates
 * are often indented inside config/YAML blocks), then trim the whole text. */
export function stripPromptIndent(raw: string): string {
  return raw.split('\n').map(line => line.trim()).join('\n').trim()
}

/** Expand a leading `~/` (or a bare `~`) to the user's home directory. */
export function expandHome(file: string): string {
  if (file === '~') return homedir()
  if (file.startsWith('~/')) return join(homedir(), file.slice(2))
  return file
}

/** The config subset the loader reads (structural — BridgeConfig satisfies it). */
export interface PromptFilesConfig {
  /** 私聊（dm:）会话的附加设定文件路径；空/缺省 = 不注入。 */
  dmPromptFile?: string
  /** 群聊（group:）会话的附加设定文件路径；空/缺省 = 不注入。 */
  groupPromptFile?: string
  /** 记忆文件开关：默认关（裁定口径；记忆只喂私聊）。 */
  memoryFilesEnabled?: boolean
  /** 记忆文件路径列表（~/ 展开）。 */
  memoryFiles?: readonly string[]
}

/** One cache entry: the stat mtime the text was read at. */
interface CachedFile {
  mtimeMs: number
  text: string
}

export class PromptLoader {
  private readonly log: ChannelLog
  private readonly fileCache = new Map<string, CachedFile>()

  constructor(options: { log: ChannelLog }) {
    this.log = options.log
  }

  /** mtime 失效的读文件缓存（评审修正①）：文件被编辑（mtime 变化）后下一次
   * build 即读到新内容；读取失败（含文件不存在）清缓存、告警并返回空串。 */
  private readFileCached(file: string): string {
    try {
      const mtimeMs = statSync(file).mtimeMs
      const cached = this.fileCache.get(file)
      if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.text
      const text = readFileSync(file, 'utf8')
      this.fileCache.set(file, { mtimeMs, text })
      return text
    } catch (error) {
      this.fileCache.delete(file)
      this.log('warn', '提示词文件读取失败，已跳过 ' + file + ': ' + describeError(error))
      return ''
    }
  }

  /** 按 chat 类型（chatId 的 group:/dm: 前缀）挑选文件并组装附加设定/记忆
   * 文本。记忆只喂私聊（群聊 memoryText 恒为空串）且开关默认关。 */
  build(chatId: string, config: PromptFilesConfig): { kind: 'group' | 'dm'; extra: string; memoryText: string } {
    const kind = chatId.startsWith('group:') ? 'group' : 'dm'
    const file = (kind === 'group' ? config.groupPromptFile : config.dmPromptFile) ?? ''
    const extra = typeof file === 'string' && file.trim() !== ''
      ? stripPromptIndent(this.readFileCached(expandHome(file)))
      : ''
    const memoryText = kind === 'dm' && config.memoryFilesEnabled === true
      ? readMemoryFiles(config.memoryFiles ?? [], this.log)
      : ''
    return { kind, extra, memoryText }
  }
}
