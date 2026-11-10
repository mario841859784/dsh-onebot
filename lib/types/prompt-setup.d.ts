import type { ChannelLog } from './prompt.js';
/** Strip the per-line leading/trailing whitespace of a prompt file (templates
 * are often indented inside config/YAML blocks), then trim the whole text. */
export declare function stripPromptIndent(raw: string): string;
/** Expand a leading `~/` (or a bare `~`) to the user's home directory. */
export declare function expandHome(file: string): string;
/** The config subset the loader reads (structural — BridgeConfig satisfies it). */
export interface PromptFilesConfig {
    /** 私聊（dm:）会话的附加设定文件路径；空/缺省 = 不注入。 */
    dmPromptFile?: string;
    /** 群聊（group:）会话的附加设定文件路径；空/缺省 = 不注入。 */
    groupPromptFile?: string;
    /** 记忆文件开关：默认关（裁定口径；记忆只喂私聊）。 */
    memoryFilesEnabled?: boolean;
    /** 记忆文件路径列表（~/ 展开）。 */
    memoryFiles?: readonly string[];
}
export declare class PromptLoader {
    private readonly log;
    private readonly fileCache;
    constructor(options: {
        log: ChannelLog;
    });
    /** mtime 失效的读文件缓存（评审修正①）：文件被编辑（mtime 变化）后下一次
     * build 即读到新内容；读取失败（含文件不存在）清缓存、告警并返回空串。 */
    private readFileCached;
    /** 按 chat 类型（chatId 的 group:/dm: 前缀）挑选文件并组装附加设定/记忆
     * 文本。记忆只喂私聊（群聊 memoryText 恒为空串）且开关默认关。 */
    build(chatId: string, config: PromptFilesConfig): {
        kind: 'group' | 'dm';
        extra: string;
        memoryText: string;
    };
}
