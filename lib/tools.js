/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fileToBase64, isUrl } from './media.js';
import { splitChatId } from './chat.js';
import { parseMessage, cqUnescape } from './cq.js';
/** OneBot actions a model may invoke through qq_napcat_api. */
const NAPCAT_API_WHITELIST = [
    'get_group_member_list',
    'get_group_member_info',
    'get_stranger_info',
    'get_forward_msg',
    'get_record',
    'get_file',
    'upload_group_file',
    'upload_private_file',
    'get_group_root_files',
    'get_group_files_by_folder',
    'get_group_file_url',
    'get_private_file_url',
    'ocr_image',
    'get_ai_characters',
    'send_group_ai_record',
];
/** Output projection shared by the send tools (unconstrained JSON value). */
function sendOutput() {
    return {
        schema: { type: 'json' },
        render: (_args, value) => {
            const v = value;
            return [{ type: 'text', text: v.messageId != null ? '已发送（message_id=' + v.messageId + '）' : '已发送' }];
        },
    };
}
/** Resolve the target chat for a tool call. */
function resolveChat(bridge, exec, chatIdArg) {
    if (typeof chatIdArg === 'string' && chatIdArg !== '')
        return chatIdArg;
    const sessionId = exec.agent?.session.id;
    if (sessionId !== undefined) {
        const chatId = bridge.chatForSession(String(sessionId));
        if (chatId !== undefined)
            return chatId;
    }
    throw new Error('无法确定目标会话：请传 chat_id（格式 private:<qq> 或 group:<群号>）');
}
/**
 * Outbound media fence roots for the calling session's current turn
 * (M1-A3b): the plugin media dir always, plus the chat workspace on admin
 * turns. An unknown caller session degrades to mediaDir-only inside the
 * bridge — fail-closed.
 */
async function mediaRoots(bridge, exec) {
    const gate = await bridge.mediaSendRoots(exec.agent?.session.id);
    return gate.roots;
}
/**
 * Read one local media file behind the outbound fence, translating the
 * fence refusal (which reaches the model verbatim) into an actionable
 * hint; size-cap and OS errors keep their original message.
 */
async function fencedMediaFile(path, maxBytes, allowedRoots) {
    try {
        return await fileToBase64(path, maxBytes, allowedRoots);
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('path not allowed or does not exist')) {
            throw new Error('本地路径不在允许的媒体目录内（管理员回合可另读会话工作区），或文件不存在：' + path);
        }
        throw error;
    }
}
/** 发送间隔上限（毫秒），与 index.ts 中 zod 的 max 对齐。 */
export const SEGMENTS_INTERVAL_MAX_MS = 3000;
let sendSegmentsConfig = { enabled: true, intervalMs: 0 };
/** 把任意数值截断进 0–3000 毫秒窗口（使用侧 clamp；页面值由 zod 校验）。 */
export function clampSegmentsInterval(ms) {
    if (!Number.isFinite(ms))
        return 0;
    return Math.min(SEGMENTS_INTERVAL_MAX_MS, Math.max(0, ms));
}
/**
 * 安装 qq_send_segments 的插件页开关（index.ts apply() 在任何 agent scope
 * 注册工具之前调用一次）。undefined = 恢复默认（启用、间隔 0）。
 */
export function configureSendSegments(config) {
    sendSegmentsConfig = {
        enabled: config?.enabled ?? true,
        intervalMs: clampSegmentsInterval(config?.intervalMs ?? 0),
    };
}
/** 间隔等待；0 完全不排定时器（默认路径零行为差异，也便于假时钟断言）。 */
function wait(ms) {
    return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}
/**
 * 权限分档 A2（硬防线）：成员档位回合（非管理员）默认禁用全部 qq_* 工具。
 * 判定在 bridge.memberToolsAllowed：发言人角色复用 M1-A2 的 turn-level 语义
 * （dispatchFollowup 把 role 压入 pendingTurnRoles，turn/start 冻结到
 * activeTurnRole，未知状态 fail-closed member）；无 QQ 会话映射的调用方
 * （Web 等其他通道）不受限；permissions.memberTools === 'all' 时整体放行
 * （fail-open 只发生在显式配置下）。
 */
function toolAllowed(bridge, exec) {
    return bridge.memberToolsAllowed(exec?.agent?.session?.id);
}
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them. Every tool's execute is wrapped with the
 * 权限分档 A2 member-tier gate BEFORE any validation/read/send happens.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export function registerTools(ctx, bridge, connection, limits) {
    const disposers = [];
    const register = (tool) => {
        const execute = tool.execute;
        const gated = {
            ...tool,
            execute: async (args, exec) => {
                if (!toolAllowed(bridge, exec)) {
                    throw new Error('当前发言人为成员档位，无工具权限：qq_* 工具仅管理员回合可用');
                }
                return execute(args, exec);
            },
        };
        disposers.push(ctx.tools.register(gated));
    };
    register(defineTool({
        name: 'qq_send_image',
        description: '向 QQ 会话发送一张或多张图片（本地文件路径或 http(s) URL，最多 9 张）。用于回复用户时附带截图/生成图等。',
        parameters: {
            sources: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '图片来源：本地绝对路径或 http(s) URL，最多 9 个',
            },
            chat_id: {
                type: 'string',
                description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
            },
            caption: {
                type: 'string',
                description: '图片说明文字（可选，作为图片前的文本发送）',
            },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const sources = Array.isArray(a.sources) ? a.sources.filter((s) => typeof s === 'string') : [];
            if (sources.length === 0)
                throw new Error('qq_send_image: sources 不能为空');
            if (sources.length > 9)
                throw new Error('qq_send_image: 一次最多 9 张图片');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const segments = [];
            if (typeof a.caption === 'string' && a.caption !== '') {
                segments.push({ type: 'text', data: { text: a.caption } });
            }
            for (const source of sources) {
                if (isUrl(source)) {
                    segments.push({ type: 'image', data: { url: source } });
                }
                else {
                    segments.push({ type: 'image', data: { file: await fencedMediaFile(source, limits.maxImageBytes, allowedRoots) } });
                }
            }
            const messageId = await bridge.sendSegments(chatId, segments);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_voice',
        description: '向 QQ 会话发送一条语音消息（本地音频文件路径，mp3/wav/silk 等；NapCat 负责转码）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地音频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_voice: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'record', data: { file: await fencedMediaFile(a.path, limits.maxVoiceBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_video',
        description: '向 QQ 会话发送一条视频消息（本地视频文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地视频文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_video: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'video', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots) } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_file',
        description: '向 QQ 会话发送一个文件（本地文件绝对路径）。',
        parameters: {
            path: { type: 'string', required: true, description: '本地文件绝对路径' },
            name: { type: 'string', description: '文件名（默认取路径文件名）' },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.path !== 'string' || a.path === '')
                throw new Error('qq_send_file: path 必填');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            const allowedRoots = await mediaRoots(bridge, exec);
            const name = typeof a.name === 'string' && a.name !== '' ? a.name : a.path.split('/').pop() ?? 'file';
            const messageId = await bridge.sendSegments(chatId, [
                { type: 'file', data: { file: await fencedMediaFile(a.path, limits.maxFileBytes, allowedRoots), name } },
            ]);
            return { sent: true, messageId: messageId ?? null };
        },
    }));
    register(defineTool({
        name: 'qq_send_forward',
        description: '以「合并转发」形式向 QQ 会话发送多条消息（每条含发送者名和内容，适合代码+说明、分步报告等）。',
        parameters: {
            messages: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '显示名（≤24 字）' },
                        content: { type: 'string', description: '消息内容（≤500 字，必填）' },
                    },
                    additionalProperties: true,
                },
                required: true,
                description: '合并转发的消息节点列表',
            },
            chat_id: { type: 'string', description: '目标会话；省略时默认当前会话' },
        },
        output: sendOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (!Array.isArray(a.messages) || a.messages.length === 0)
                throw new Error('qq_send_forward: messages 不能为空');
            const nodes = a.messages.map(m => {
                const node = m;
                return {
                    name: typeof node.name === 'string' && node.name !== '' ? node.name : '助手',
                    content: typeof node.content === 'string' ? node.content : '',
                };
            });
            if (nodes.some(n => n.content === ''))
                throw new Error('qq_send_forward: 每条消息都需要 content');
            const chatId = resolveChat(bridge, exec, a.chat_id);
            await bridge.sendForward(chatId, nodes);
            return { sent: true, messageId: null };
        },
    }));
    // T14: 插件页开关——enabled=false 时该工具不注册（模型不可见即不可用）。
    if (sendSegmentsConfig.enabled)
        register(defineTool({
            name: 'qq_send_segments',
            description: '向 QQ 会话按顺序发送多条独立的纯文本气泡（每段一条单独消息）。仅在你明确需要分条呈现时使用——不会自动分段，需自行拆好每段文字；相邻两段的发送间隔由插件配置 segments.intervalMs 控制（可用本工具的 intervalMs 参数临时覆盖）。普通回复请直接输出文本即可。',
            parameters: {
                segments: {
                    type: 'array',
                    items: { type: 'string' },
                    required: true,
                    description: '文本段列表：按顺序逐条发送为独立气泡；最多 9 段，每段 ≤500 字且不能为空',
                },
                intervalMs: {
                    type: 'number',
                    description: '可选：覆盖全局的相邻段发送间隔（毫秒，0–3000，超界按边界截断）；省略时用插件页配置 segments.intervalMs（默认 0 = 不等待）',
                },
                chat_id: { type: 'string', description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话' },
            },
            output: {
                schema: { type: 'json' },
                render: (_args, value) => {
                    const v = value;
                    return [{ type: 'text', text: '已发送 ' + (v.count ?? 0) + ' 条分段消息' }];
                },
            },
            isConcurrencySafe: () => true,
            execute: async (args, exec) => {
                const a = args;
                const texts = Array.isArray(a.segments) ? a.segments.filter((s) => typeof s === 'string' && s.trim() !== '') : [];
                if (texts.length === 0)
                    throw new Error('qq_send_segments: segments 不能为空（需为非空文本段数组）');
                if (texts.length > 9)
                    throw new Error('qq_send_segments: 一次最多 9 段');
                if (texts.some(t => t.length > 500))
                    throw new Error('qq_send_segments: 每段最多 500 字');
                const intervalMs = typeof a.intervalMs === 'number' && Number.isFinite(a.intervalMs)
                    ? clampSegmentsInterval(a.intervalMs)
                    : sendSegmentsConfig.intervalMs;
                const chatId = resolveChat(bridge, exec, a.chat_id);
                const messageIds = [];
                for (let i = 0; i < texts.length; i++) {
                    if (i > 0)
                        await wait(intervalMs);
                    const id = await bridge.sendSegments(chatId, [{ type: 'text', data: { text: texts[i] } }]);
                    messageIds.push(id ?? null);
                }
                return { sent: true, count: messageIds.length, messageIds };
            },
        }));
    register(defineTool({
        name: 'qq_napcat_api',
        description: '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。',
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: '白名单 action：' + NAPCAT_API_WHITELIST.join(' / '),
            },
            params: {
                type: 'object',
                additionalProperties: true,
                description: 'action 参数（JSON 对象）',
            },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            if (typeof a.action !== 'string' || !NAPCAT_API_WHITELIST.includes(a.action)) {
                throw new Error('qq_napcat_api: action 不在白名单内（' + NAPCAT_API_WHITELIST.join(', ') + '）');
            }
            const params = typeof a.params === 'object' && a.params !== null ? a.params : {};
            return await connection.call(a.action, params);
        },
    }));
    register(defineTool({
        name: 'qq_group_history',
        description: '拉取群聊最近消息历史（供总结群内上下文、查看用户之前的发言）。仅群聊可用。',
        parameters: {
            chat_id: { type: 'string', description: '目标群会话 group:<群号>；省略时默认当前会话（须为群聊）' },
            count: { type: 'number', description: '拉取条数（≤50，默认 20）' },
            message_seq: { type: 'number', description: '翻页锚点：从这条消息 id 往前取（可选；作为 message_id 参数发给协议端）' },
        },
        output: {
            schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
            },
            render: (_args, value) => {
                const list = Array.isArray(value) ? value : [];
                return [{ type: 'text', text: list.length + ' 条历史消息' }];
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const a = args;
            const chatId = resolveChat(bridge, exec, a.chat_id);
            if (splitChatId(chatId).kind !== 'group')
                throw new Error('qq_group_history: 仅支持群聊');
            const groupId = Number(splitChatId(chatId).target);
            const count = Math.min(Math.max(typeof a.count === 'number' ? Math.floor(a.count) : 20, 1), 50);
            const params = { group_id: groupId, count };
            // OneBot 锚点参数名是 message_id（NapCat 旧称 message_seq 协议端不识别，
            // SnowLuma 的 get_group_msg_history 只认 message_id）；工具入参名保持
            // message_seq 不变以兼容既有调用方。
            if (typeof a.message_seq === 'number')
                params.message_id = a.message_seq;
            const data = await connection.call('get_group_msg_history', params);
            const messages = Array.isArray(data.messages) ? data.messages : [];
            return messages.map(m => {
                const msg = m;
                const sender = (msg.sender ?? {});
                const message = msg.message;
                const segments = Array.isArray(message) ? message : undefined;
                const raw = typeof msg.raw_message === 'string' ? msg.raw_message : '';
                const parsed = parseMessage(segments, raw);
                return {
                    message_id: msg.message_id != null ? String(msg.message_id) : null,
                    time: msg.time != null ? String(msg.time) : null,
                    user_id: sender.user_id != null ? String(sender.user_id) : msg.user_id != null ? String(msg.user_id) : null,
                    nickname: typeof sender.card === 'string' && sender.card !== '' ? sender.card
                        : typeof sender.nickname === 'string' && sender.nickname !== '' ? sender.nickname
                            : String(sender.user_id ?? ''),
                    text: cqUnescape(parsed.text),
                };
            });
        },
    }));
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
