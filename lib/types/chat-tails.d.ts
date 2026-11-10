import type { ChannelLog } from './prompt.js';
/** 每个 chat 只留最近这么多条尾巴。 */
export declare const TAIL_MAX_MESSAGES = 8;
/** 每条尾巴文本截断上限（字符）。 */
export declare const TAIL_TEXT_MAX = 300;
/** 落盘文件名（位于 mediaDir 下）。 */
export declare const TAILS_FILE = "chat-tails.json";
/** 没有尾巴时的开场提示（也让模型说一句，别一上来就沉默）。 */
export declare const NEW_SESSION_GREETING_PROMPT = "\uFF08\u521A\u5F00\u4E86\u4E00\u4E2A\u65B0\u4F1A\u8BDD\uFF0C\u4E0A\u9762\u662F\u4E4B\u524D\u51E0\u53E5\u3002\u63A5\u7740\u5F80\u4E0B\u804A\uFF0C\u8BF4\u4E00\u53E5\u5C31\u884C\u3002\uFF09";
export type TailRole = 'user' | 'assistant';
export interface TailEntry {
    role: TailRole;
    text: string;
    turn: number;
}
/** 把尾巴拼成新会话第一回合的开场提示（空尾巴 = 纯问候句）。 */
export declare function buildGreetingPrompt(tail: readonly TailEntry[]): string;
export declare class ChatTails {
    private readonly mediaDir;
    private readonly log;
    private cache;
    private loading;
    private timer;
    private readonly turnAt;
    constructor(options: {
        mediaDir: string;
        log: ChannelLog;
    });
    get path(): string;
    /** 启动预热（移植修正）：提前首读落盘缓存，避免首条 push 因缓存未加载被
     * 静默丢掉（贡献者版本首次 /new 必空尾）。 */
    preload(): void;
    /** 读这个 chat 的尾巴；没有就空数组。 */
    read(chatId: string): Promise<TailEntry[]>;
    /** 首次读盘（共享 promise：并发调用只读一次。不用布尔锁——否则重启后
     * 第一条 /new 会拿到空缓存）。 */
    private load;
    /** 记一句进尾巴：剥掉入站管线的宿主信封与可信元数据前缀（同一回合的
     * 多条 assistant 并成一条（留最长的），只留最近 TAIL_MAX_MESSAGES 条）。 */
    push(chatId: string, role: TailRole, text: string): void;
    /** 丢掉这个 chat 的内存副本（/new 之后重新攒）。 */
    drop(chatId: string): void;
    /** 防抖落盘：连着说几句只写一次。 */
    private scheduleSave;
    /** 落盘（失败只记日志，别让写盘错误影响聊天）。 */
    save(): Promise<void>;
    /** 关闭：清定时器并强制落一次盘，别让防抖吞掉最后几句。 */
    stop(): Promise<void>;
}
