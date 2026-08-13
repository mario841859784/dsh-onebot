/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import { fileToBase64 } from './media.js';
import { transcriptLabel } from './stt.js';
import { cqUnescape, detectMention, parseMessage, segmentText } from './cq.js';
import { buildChatId, buildGroupMessagePrefix, classifyUserRole, dmAllowed, groupAllowed, RESTRICTED_PREFIX, sessionIdForChat, splitChatId, } from './chat.js';
import { extractForwardBlocks, scanSensitive, splitLongText, stripMarkdown } from './split.js';
/** The mapping file name inside the media dir. */
const MAPPING_FILE = 'chat-sessions.json';
/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export class ChatBridge {
    deps;
    chats = new Map();
    bySession = new Map();
    stopping = false;
    mappingSaveTimer;
    constructor(deps) {
        this.deps = deps;
    }
    /** Start listening: wire connection handlers and the session event feed. */
    start() {
        const { connection, ctx } = this.deps;
        connection.selfId = this.deps.config.botQQ;
        ctx.on('session/event', (session, event) => {
            this.onSessionEvent(session, event);
        });
        ctx.on('session/flush', (session) => {
            void this.onSessionFlush(session);
        });
        connection.onStatus = (connected) => {
            this.deps.log(connected ? 'info' : 'warn', 'OneBot ' + (connected ? 'connected' : 'disconnected'));
        };
        void this.loadMapping().then(() => {
            if (this.stopping)
                return;
            this.deps.log('info', 'bridge ready (' + this.chats.size + ' resumed chat(s))');
        });
    }
    /** Stop everything: dispose agents, save mapping, cancel timers. */
    async stop() {
        this.stopping = true;
        if (this.mappingSaveTimer !== undefined) {
            clearTimeout(this.mappingSaveTimer);
            this.mappingSaveTimer = undefined;
        }
        for (const chat of this.chats.values()) {
            this.stopTyping(chat);
            try {
                await chat.dispose();
            }
            catch (error) {
                this.deps.log('warn', 'agent dispose failed: ' + String(error));
            }
        }
        this.chats.clear();
        this.bySession.clear();
        await this.saveMapping();
    }
    /** Map an agent session id back to its chat (for model tools). */
    chatForSession(sessionId) {
        return this.bySession.get(sessionId);
    }
    /** Whether the connection is usable for sends. */
    get connected() {
        return this.deps.connection.connected;
    }
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId, text, options = {}) {
        return this.enqueue(chatId, async () => {
            if (!this.deps.connection.connected) {
                throw new OneBotNotConnectedError();
            }
            const hits = scanSensitive(text, this.deps.config.sensitivePatterns);
            if (hits.length > 0) {
                this.deps.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '));
            }
            const ids = [];
            const { body, nodes } = extractForwardBlocks(text, '助手');
            if (nodes.length > 0) {
                await this.sendForward(chatId, nodes);
                ids.push('forward');
            }
            const plain = stripMarkdown(body);
            if (plain !== '') {
                const chunks = splitLongText(plain, this.deps.config.splitLength);
                for (const chunk of chunks) {
                    const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: chunk } }], options);
                    if (id !== undefined)
                        ids.push(id);
                }
            }
            return ids;
        });
    }
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments) {
        return this.enqueue(chatId, () => this.sendMsg(chatId, segments, {}));
    }
    // ------------------------------------------------------------ inbound
    /**
     * Inbound OneBot message event → agent turn. All policy and media work is
     * contained: a failure here logs and drops the message, never the host.
     */
    async handleInbound(event) {
        if (this.stopping)
            return;
        try {
            await this.processInbound(event);
        }
        catch (error) {
            this.deps.log('error', 'inbound handling failed: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    async processInbound(event) {
        const messageType = event.message_type;
        if (messageType !== 'private' && messageType !== 'group')
            return;
        const userId = String(event.user_id ?? '');
        if (userId === '')
            return;
        if (this.deps.config.ignoreSelf && this.deps.connection.selfId !== '' && userId === this.deps.connection.selfId) {
            return;
        }
        const groupId = messageType === 'group' ? String(event.group_id ?? '') : '';
        const policy = this.deps.policy;
        if (messageType === 'private') {
            if (!dmAllowed(userId, policy)) {
                this.deps.log('debug', 'ignoring DM from non-allowed user ' + userId);
                return;
            }
        }
        else {
            if (!groupAllowed(groupId, policy)) {
                this.deps.log('debug', 'ignoring group message from non-allowed group ' + groupId);
                return;
            }
        }
        const segments = Array.isArray(event.message) ? event.message : undefined;
        const raw = typeof event.raw_message === 'string' ? event.raw_message : String(event.message ?? '');
        const parsed = parseMessage(segments, raw);
        const mentioned = detectMention(segments, raw, this.deps.connection.selfId, this.deps.config.botQQ, parsed.replyId);
        if (messageType === 'group' && this.deps.config.requireMention && !mentioned) {
            this.deps.log('debug', 'ignoring unmentioned group message in ' + groupId);
            return;
        }
        const sender = event.sender ?? {};
        const nickname = typeof sender.card === 'string' && sender.card !== ''
            ? sender.card
            : typeof sender.nickname === 'string' && sender.nickname !== ''
                ? sender.nickname
                : userId;
        const chatId = buildChatId(messageType === 'private' ? 'private' : 'group', messageType === 'private' ? userId : groupId);
        // Fire-and-forget temp cleanup on each inbound.
        void this.deps.media.cleanupExpired();
        const body = await this.buildBody(parsed.text, parsed.media, userId, messageType);
        let quote = '';
        if (parsed.replyId !== undefined) {
            quote = await this.expandQuote(parsed.replyId);
        }
        let forward = '';
        if (parsed.forwardId !== undefined) {
            forward = await this.expandForward(parsed.forwardId);
        }
        const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin';
        let final = body;
        if (quote !== '')
            final = quote + '\n' + final;
        if (forward !== '')
            final = forward + '\n' + final;
        if (messageType === 'group') {
            final = buildGroupMessagePrefix(nickname, userId, mentioned) + final;
            if (!isAdmin && this.deps.config.restrictedMemberPrefix) {
                final = RESTRICTED_PREFIX + final;
            }
        }
        final = final.trim();
        if (final === '')
            return;
        const chat = await this.ensureChat(chatId, nickname);
        chat.lastNickname = nickname;
        this.deps.log('info', 'followup from ' + chatId + ': ' + final.slice(0, 120));
        chat.agent.followup(createUserMessage({
            content: [{ type: 'text', text: final }],
            source: { kind: 'user' },
        }));
        this.startTyping(chat);
    }
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    async buildBody(text, media, userId, messageType) {
        if (media.length === 0)
            return text;
        let out = text;
        for (const ref of media) {
            const placeholder = placeholderFor(ref);
            const idx = out.indexOf(placeholder);
            const annotation = await this.resolveMediaRef(ref, userId, messageType);
            if (idx >= 0 && annotation !== '') {
                out = out.slice(0, idx) + annotation + out.slice(idx + placeholder.length);
            }
        }
        return out;
    }
    /** Resolve one media ref to a text annotation with a local path. */
    async resolveMediaRef(ref, userId, messageType) {
        const resolved = await this.deps.media.resolve(ref, async (kind, file) => {
            if (kind === 'image') {
                const data = await this.deps.connection.call('get_image', { file });
                return { url: data.url, file: data.file };
            }
            if (kind === 'voice') {
                const data = await this.deps.connection.call('get_record', { file, out_format: 'mp3' });
                return { file: data.file };
            }
            return undefined;
        });
        if (resolved === undefined)
            return '';
        switch (resolved.kind) {
            case 'image':
                return '[图片:' + resolved.path + ']';
            case 'voice': {
                if (this.deps.transcriber.enabled) {
                    try {
                        const text = await this.deps.transcriber.transcribe(resolved.path);
                        const label = transcriptLabel(text);
                        if (label !== '')
                            return '[语音]' + label;
                    }
                    catch (error) {
                        this.deps.log('warn', 'STT failed: ' + (error instanceof Error ? error.message : String(error)));
                    }
                }
                return '[语音]';
            }
            case 'video':
                return '[视频:' + resolved.path + ']';
            default:
                return '[文件:' + resolved.path + ']';
        }
    }
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    async expandQuote(messageId) {
        try {
            const data = await this.deps.connection.call('get_msg', { message_id: Number(messageId) });
            const segments = Array.isArray(data.message) ? data.message : undefined;
            const raw = typeof data.raw_message === 'string' ? data.raw_message : '';
            const text = cqUnescape(segmentText(segments, raw));
            if (text.trim() === '')
                return '';
            const name = data.sender?.nickname ?? '';
            return '[引用]' + (name !== '' ? name + ': ' : '') + text;
        }
        catch (error) {
            this.deps.log('debug', 'quote expansion failed: ' + (error instanceof Error ? error.message : String(error)));
            return '';
        }
    }
    /** Expand a combined-forward id into "name: content" lines. */
    async expandForward(forwardId) {
        try {
            const data = await this.deps.connection.call('get_forward_msg', { id: forwardId });
            const lines = [];
            for (const node of data.messages ?? []) {
                const name = node.sender?.nickname ?? String(node.sender?.user_id ?? '未知');
                const text = nodeContentText(node.content);
                if (text !== '')
                    lines.push(name + ': ' + text);
            }
            if (lines.length === 0)
                return '';
            return '[合并转发]\n' + lines.join('\n');
        }
        catch (error) {
            this.deps.log('debug', 'forward expansion failed: ' + (error instanceof Error ? error.message : String(error)));
            return '[合并转发]';
        }
    }
    // ------------------------------------------------------------ outbound
    /** Serialize work on one chat's send chain. */
    enqueue(chatId, work) {
        const existing = this.chats.get(chatId);
        const chain = (existing?.queue ?? Promise.resolve());
        const run = chain.then(work, work);
        if (existing !== undefined) {
            existing.queue = run.catch(() => undefined);
        }
        else {
            void run.catch(() => undefined);
        }
        return run;
    }
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        const ref = splitChatId(chatId);
        const params = {};
        let target;
        try {
            target = Number(ref.target);
            if (!Number.isFinite(target))
                throw new Error('bad target');
        }
        catch {
            throw new OneBotActionError('invalid chat target: ' + chatId);
        }
        if (ref.kind === 'group')
            params.group_id = target;
        else
            params.user_id = target;
        params.message = segments;
        if (options.replyTo !== undefined) {
            params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments];
        }
        const data = await this.deps.connection.call('send_msg', params);
        return data.message_id !== undefined ? String(data.message_id) : undefined;
    }
    /** Send [[qq_forward]] nodes as a merged-forward message. */
    async sendForward(chatId, nodes) {
        const ref = splitChatId(chatId);
        const target = Number(ref.target);
        if (!Number.isFinite(target))
            throw new OneBotActionError('invalid chat target: ' + chatId);
        const messages = nodes.map(node => ({
            type: 'node',
            data: {
                uin: this.deps.connection.selfId || this.deps.config.botQQ,
                name: node.name.slice(0, 24),
                content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
            },
        }));
        if (ref.kind === 'group') {
            await this.deps.connection.call('send_forward_msg', { group_id: target, messages });
        }
        else {
            await this.deps.connection.call('send_private_forward_msg', { user_id: target, messages });
        }
    }
    // ------------------------------------------------------------ session events
    onSessionEvent(session, event) {
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined)
            return;
        const chat = this.chats.get(chatId);
        if (chat === undefined || chat.sessionId !== session.id)
            return;
        if (event.type === 'assistant/message') {
            const text = event.data.message.content
                .filter(block => block.type === 'text')
                .map(block => block.text)
                .join('');
            if (text === '')
                return;
            if (this.deps.config.interimMessages) {
                this.deps.log('debug', 'interim send to ' + chatId + ': ' + text.slice(0, 80));
                this.sendToChat(chatId, text).catch(error => {
                    this.deps.log('warn', 'interim send failed: ' + (error instanceof Error ? error.message : String(error)));
                });
            }
            else {
                chat.pendingFinal = text;
            }
            return;
        }
        if (event.type === 'turn/end') {
            if (!this.deps.config.interimMessages && chat.pendingFinal !== '') {
                const final = chat.pendingFinal;
                chat.pendingFinal = '';
                this.sendToChat(chatId, final).catch(error => {
                    this.deps.log('warn', 'final send failed: ' + (error instanceof Error ? error.message : String(error)));
                });
            }
            if (event.data.reason.kind === 'error' && this.deps.config.sendErrorNotice) {
                const message = event.data.reason.error.message;
                this.sendToChat(chatId, '⚠️ 运行出错：' + message).catch(() => undefined);
            }
            this.stopTyping(chat);
            chat.busy = false;
            this.deps.log('info', 'turn/end for ' + chatId + ': ' + event.data.reason.kind);
            // Durable: flush the session so a later restart can resume it.
            void this.deps.sessions.flush(chat.agent.session).catch((error) => {
                this.deps.log('warn', 'session flush failed: ' + String(error));
            });
            void this.saveMappingDebounced();
        }
    }
    async onSessionFlush(session) {
        if (this.stopping)
            return;
        const chatId = this.bySession.get(session.id);
        if (chatId === undefined)
            return;
        await this.saveMapping();
    }
    // ------------------------------------------------------------ chat lifecycle
    /** Get (or create) the agent for a chat. */
    async ensureChat(chatId, nickname) {
        const existing = this.chats.get(chatId);
        if (existing !== undefined)
            return existing;
        const sessionId = makeSessionId(sessionIdForChat(chatId));
        const selection = this.deps.defaultModel?.();
        const agentOptions = {};
        if (selection !== undefined) {
            agentOptions.provider = selection.provider;
            agentOptions.model = selection.model;
        }
        const cwd = process.cwd();
        const selectionRef = selection !== undefined
            ? { current: selection, assembled: undefined }
            : undefined;
        const handle = await this.deps.agents.create({
            sessionId,
            meta: { cwd },
            agentOptions,
            setup: agentCtx => {
                if (selectionRef !== undefined) {
                    installModelSelection(agentCtx, selectionRef);
                }
            },
        });
        const chat = {
            chatId,
            sessionId,
            agent: handle.agent,
            dispose: () => handle.dispose(),
            queue: Promise.resolve(),
            pendingFinal: '',
            busy: false,
            typingTimer: undefined,
            lastNickname: nickname,
        };
        await handle.agent.whenIdle();
        this.chats.set(chatId, chat);
        this.bySession.set(sessionId, chatId);
        this.deps.log('info', 'agent created for ' + chatId + ' (session ' + sessionId + ')');
        void this.saveMappingDebounced();
        return chat;
    }
    /** Resume persisted chats from the mapping file (best-effort). */
    async loadMapping() {
        try {
            const { readFile } = await import('node:fs/promises');
            const content = await readFile(this.mappingPath(), 'utf8');
            const mapping = JSON.parse(content);
            for (const [chatId, sessionId] of Object.entries(mapping)) {
                if (this.stopping)
                    return;
                try {
                    const selection = this.deps.defaultModel?.();
                    const agentOptions = {};
                    const selectionRef = selection !== undefined
                        ? { current: selection, assembled: undefined }
                        : undefined;
                    if (selection !== undefined) {
                        agentOptions.provider = selection.provider;
                        agentOptions.model = selection.model;
                    }
                    const handle = await this.deps.agents.resume({
                        resumeSessionId: makeSessionId(sessionId),
                        agentOptions,
                        setup: agentCtx => {
                            if (selectionRef !== undefined) {
                                installModelSelection(agentCtx, selectionRef);
                            }
                        },
                    });
                    const chat = {
                        chatId,
                        sessionId: makeSessionId(sessionId),
                        agent: handle.agent,
                        dispose: () => handle.dispose(),
                        queue: Promise.resolve(),
                        pendingFinal: '',
                        busy: false,
                        typingTimer: undefined,
                        lastNickname: '',
                    };
                    await handle.agent.whenIdle();
                    this.chats.set(chatId, chat);
                    this.bySession.set(sessionId, chatId);
                }
                catch (error) {
                    this.deps.log('warn', 'resume failed for ' + chatId + ': ' + (error instanceof Error ? error.message : String(error)));
                }
            }
        }
        catch {
            // No mapping file yet — fresh start.
        }
    }
    mappingPath() {
        return this.deps.config.mediaDir.endsWith('/') || this.deps.config.mediaDir.endsWith('\\')
            ? this.deps.config.mediaDir + MAPPING_FILE
            : this.deps.config.mediaDir + '/' + MAPPING_FILE;
    }
    async saveMapping() {
        try {
            const { mkdir, writeFile } = await import('node:fs/promises');
            await mkdir(this.deps.config.mediaDir, { recursive: true });
            const mapping = {};
            for (const chat of this.chats.values()) {
                mapping[chat.chatId] = chat.sessionId;
            }
            await writeFile(this.mappingPath(), JSON.stringify(mapping, null, 2), 'utf8');
        }
        catch (error) {
            this.deps.log('warn', 'mapping save failed: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    saveMappingDebounced() {
        if (this.mappingSaveTimer !== undefined)
            clearTimeout(this.mappingSaveTimer);
        this.mappingSaveTimer = setTimeout(() => {
            this.mappingSaveTimer = undefined;
            void this.saveMapping();
        }, 2_000).unref();
    }
    // ------------------------------------------------------------ typing
    /** Start the NapCat typing indicator (private chats only). */
    startTyping(chat) {
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        this.stopTyping(chat);
        const pulse = () => {
            if (this.stopping)
                return;
            void this.deps.connection.call('set_input_status', {
                user_id: Number(ref.target),
                event_type: 1,
            }).catch(() => undefined);
        };
        pulse();
        chat.typingTimer = setInterval(pulse, 5_000).unref();
    }
    /** Stop the typing indicator. */
    stopTyping(chat) {
        if (chat.typingTimer !== undefined) {
            clearInterval(chat.typingTimer);
            chat.typingTimer = undefined;
        }
        const ref = splitChatId(chat.chatId);
        if (ref.kind !== 'private')
            return;
        void this.deps.connection.call('set_input_status', {
            user_id: Number(ref.target),
            event_type: 0,
        }).catch(() => undefined);
    }
}
/** The placeholder a media ref contributes to the parsed text. */
function placeholderFor(ref) {
    switch (ref.kind) {
        case 'image': return '[图片]';
        case 'voice': return '[语音]';
        case 'video': return '[视频]';
        default: return ref.name !== undefined ? '[文件:' + ref.name + ']' : '[文件]';
    }
}
/** Extract text from a forward-node content (segment array or CQ string). */
function nodeContentText(content) {
    if (Array.isArray(content)) {
        return content
            .map(seg => {
            const s = seg;
            if (s?.type === 'text')
                return String(s.data?.text ?? '');
            if (s?.type === 'face')
                return '😀';
            return '[非文本]';
        })
            .join('')
            .trim();
    }
    if (typeof content === 'string')
        return content.trim();
    return '';
}
/** Convenience for tools: file → base64 segment with the plugin's caps. */
export async function imageSegment(path, maxBytes) {
    return { type: 'image', data: { file: await fileToBase64(path, maxBytes) } };
}
export { OneBotNotConnectedError, OneBotActionError };
