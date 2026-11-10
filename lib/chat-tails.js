/**
 * T4 (PR port 上下文尾巴): the last few messages of the previous session,
 * carried into a fresh session after /new so the model keeps the thread.
 * Ported from the external contribution's lib/local/chat-tails.js:
 * per chat at most TAIL_MAX_MESSAGES entries, each clipped to TAIL_TEXT_MAX,
 * same-turn assistant outputs merged (longest wins), debounced 800ms
 * persistence to mediaDir/chat-tails.json (forced on stop).
 * The two review-mandated fixes live at the bridge wiring (greeting dispatch
 * at role 'member', not 'admin'; tail injection only on a genuine
 * user-initiated /new, never impersonating source.kind 'user'). Port fix:
 * preload() lets the bridge warm the cache at start — the contribution only
 * loaded the file on the first read, so every push before that read was
 * silently dropped and the very first /new always had an empty tail.
 * @module dsh-onebot/chat-tails
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError } from './errors.js';
/** 每个 chat 只留最近这么多条尾巴。 */
export const TAIL_MAX_MESSAGES = 8;
/** 每条尾巴文本截断上限（字符）。 */
export const TAIL_TEXT_MAX = 300;
/** 落盘文件名（位于 mediaDir 下）。 */
export const TAILS_FILE = 'chat-tails.json';
/** 没有尾巴时的开场提示（也让模型说一句，别一上来就沉默）。 */
export const NEW_SESSION_GREETING_PROMPT = '（刚开了一个新会话，上面是之前几句。接着往下聊，说一句就行。）';
/** 同一回合的多条 assistant 输出，间隔小于这个就当是同一轮，并成一条。 */
const SAME_TURN_MS = 30_000;
/** 落盘防抖（ms）。 */
const SAVE_DEBOUNCE_MS = 800;
/** 入站管线派来的文本先做净化：信封 <user_message …>…</user_message> 展开为
 * 里面的正文（贡献者版本整段删掉，会把消息体一起丢掉），再剥掉外层可信
 * 元数据前缀（时间戳 / 群档位 / 受限用户标记），尾巴只留人读的消息内容。 */
function normalizeTailText(text) {
    let out = String(text ?? '').replace(/<user_message\b[^>]*>([\s\S]*?)<\/user_message>/g, '$1');
    for (let i = 0; i < 3; i++) {
        if (!/^\[[^\]\n]{1,40}\] /.test(out))
            break;
        out = out.replace(/^\[[^\]\n]{1,40}\] /, '');
    }
    return out.trim();
}
/** 把尾巴拼成新会话第一回合的开场提示（空尾巴 = 纯问候句）。 */
export function buildGreetingPrompt(tail) {
    if (!Array.isArray(tail) || tail.length === 0)
        return NEW_SESSION_GREETING_PROMPT;
    const lines = tail.map(item => (item.role === 'assistant' ? '我：' : '主人：') + item.text);
    return '（刚开了一个新会话。下面是之前几句——）\n' + lines.join('\n') + '\n\n' + NEW_SESSION_GREETING_PROMPT;
}
export class ChatTails {
    mediaDir;
    log;
    cache;
    loading;
    timer;
    turnAt = new Map();
    constructor(options) {
        this.mediaDir = options.mediaDir;
        this.log = options.log;
    }
    get path() {
        return join(this.mediaDir, TAILS_FILE);
    }
    /** 启动预热（移植修正）：提前首读落盘缓存，避免首条 push 因缓存未加载被
     * 静默丢掉（贡献者版本首次 /new 必空尾）。 */
    preload() {
        void this.load();
    }
    /** 读这个 chat 的尾巴；没有就空数组。 */
    async read(chatId) {
        await this.load();
        const list = this.cache?.[chatId];
        return Array.isArray(list) ? list : [];
    }
    /** 首次读盘（共享 promise：并发调用只读一次。不用布尔锁——否则重启后
     * 第一条 /new 会拿到空缓存）。 */
    load() {
        if (this.loading === undefined) {
            this.loading = (async () => {
                let parsed;
                try {
                    parsed = JSON.parse(await readFile(this.path, 'utf8'));
                }
                catch {
                    parsed = undefined;
                }
                if (this.cache === undefined) {
                    this.cache = parsed !== null && typeof parsed === 'object' ? parsed : {};
                }
                return this.cache;
            })();
        }
        return this.loading;
    }
    /** 记一句进尾巴：剥掉入站管线的宿主信封与可信元数据前缀（同一回合的
     * 多条 assistant 并成一条（留最长的），只留最近 TAIL_MAX_MESSAGES 条）。 */
    push(chatId, role, text) {
        const body = normalizeTailText(text);
        if (body === '' || this.cache === undefined)
            return;
        const now = Date.now();
        const sameTurn = (this.turnAt.get(chatId) ?? 0) > now - SAME_TURN_MS;
        const list = Array.isArray(this.cache[chatId]) ? this.cache[chatId] : [];
        const last = list[list.length - 1];
        if (role === 'assistant' && sameTurn && last !== undefined && last.role === 'assistant' && last.turn === list.length - 1) {
            if (body.length > last.text.length)
                last.text = body.slice(0, TAIL_TEXT_MAX);
        }
        else {
            list.push({ role, text: body.slice(0, TAIL_TEXT_MAX), turn: list.length });
        }
        while (list.length > TAIL_MAX_MESSAGES)
            list.shift();
        this.cache[chatId] = list;
        this.turnAt.set(chatId, now);
        this.scheduleSave();
    }
    /** 丢掉这个 chat 的内存副本（/new 之后重新攒）。 */
    drop(chatId) {
        if (this.cache !== undefined && this.cache[chatId] !== undefined) {
            this.cache[chatId] = [];
            this.scheduleSave();
        }
    }
    /** 防抖落盘：连着说几句只写一次。 */
    scheduleSave() {
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.save();
        }, SAVE_DEBOUNCE_MS);
    }
    /** 落盘（失败只记日志，别让写盘错误影响聊天）。 */
    async save() {
        if (this.cache === undefined)
            return;
        try {
            await mkdir(this.mediaDir, { recursive: true });
            await writeFile(this.path, JSON.stringify(this.cache, null, 2), 'utf8');
        }
        catch (error) {
            this.log('warn', 'chat-tails 落盘失败: ' + describeError(error));
        }
    }
    /** 关闭：清定时器并强制落一次盘，别让防抖吞掉最后几句。 */
    async stop() {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        await this.save();
    }
}
