/**
 * System-prompt section for the OneBot channel: platform constraints the
 * model must follow while chatting via QQ. The dsh equivalent of the Hermes
 * platform_hint.
 * @module dsh-onebot/prompt
 */
/** T4 (PR port 记忆文件)：单条日志回调形状（结构类型，避免依赖 bridge）。 */
export type ChannelLogLevel = 'info' | 'warn' | 'error' | 'debug';
export type ChannelLog = (level: ChannelLogLevel, message: string) => void;
/** T4 (PR port 记忆文件)：单个记忆文件的截断上限（字符）。 */
export declare const MEMORY_FILE_MAX_CHARS = 8000;
/** T4 (PR port 记忆文件)：全部记忆文件拼后的总上限（字符）。 */
export declare const MEMORY_TOTAL_MAX_CHARS = 12000;
/**
 * T4 (PR port 记忆文件)：同步读取记忆文件列表，拼接成可注入 system prompt
 * 的文本。逐文件截断到 MEMORY_FILE_MAX_CHARS，累计超过 MEMORY_TOTAL_MAX_CHARS
 * 截断并停止；读取失败/空文件跳过只告警。与贡献者版本的差异（评审修正）：
 * 同步实现——首次调用即返回内容（贡献者的「同步返回上次、后台异步读」
 * 快照模式会让第一回合记忆必空）。
 * @param files - 记忆文件路径列表（支持 ~/ 展开；非串/空项跳过）。
 * @param log - 可选日志回调（读取失败 warn）。
 * @returns 拼接后的记忆文本（`\n\n---\n\n` 分隔；无可读文件时为空串）。
 */
export declare function readMemoryFiles(files: readonly string[], log?: ChannelLog): string;
/**
 * Build the platform-guidance section text.
 * @param restrictedMembers - whether restricted-member mode is active.
 * @param extra - T4 (PR port 提示词文件)：本会话附加设定（人设文案，来自
 *   dm/group 提示词文件；空 = 不注入该段，旧调用不传即保持原行为）。
 * @param memoryText - T4 (PR port 记忆文件)：记忆文件内容（仅私聊；空 = 不注入）。
 * @returns the section text.
 */
export declare function buildPlatformPrompt(restrictedMembers: boolean, extra?: string, memoryText?: string): string;
