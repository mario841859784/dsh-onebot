import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileToBase64 } from './media.js';
import { describeError } from './errors.js';
/** The routed command table. Row order = the /help line order inside each
 * group (the router matches by name, so ordering is routing-neutral). */
export const COMMANDS = [
    { name: 'new', adminOnly: true, group: '会话', help: '开启新会话（清空上下文）', handler: async (ctx, chatId) => {
            ctx.log('info', 'slash /new for ' + chatId);
            await ctx.resetChat(chatId);
        } },
    { name: 'stop', adminOnly: true, group: '操作', help: '停止当前生成', handler: (ctx, chatId) => handleStopCommand(ctx, chatId) },
    { name: 'model', adminOnly: true, group: '其他', help: '[--default] <provider> <model> 切换模型（--default 改部署默认；无参两级序号列表）', handler: (ctx, chatId, arg) => handleModelCommand(ctx, chatId, arg) },
    { name: 'workspace', adminOnly: true, group: '会话', help: '[路径|序号|list] 查看或切换工作区', handler: (ctx, chatId, arg) => handleWorkspaceCommand(ctx, chatId, arg) },
    { name: 'preset', adminOnly: true, group: '会话', help: '[id|序号] 查看/切换 agent 预设', handler: (ctx, chatId, arg) => handlePresetCommand(ctx, chatId, arg) },
    { name: 'session', adminOnly: true, group: '会话', help: '[序号] 查看/切回历史会话', handler: (ctx, chatId, arg) => handleSessionCommand(ctx, chatId, arg) },
    { name: 'status', adminOnly: true, group: '查询', help: '会话全景', handler: (ctx, chatId) => handleStatusCommand(ctx, chatId) },
    { name: 'retry', adminOnly: true, group: '操作', help: '重跑上一条', handler: (ctx, chatId) => handleRetryCommand(ctx, chatId) },
    { name: 'id', adminOnly: true, group: '查询', help: '会话标识（session/chat）', handler: (ctx, chatId) => handleIdCommand(ctx, chatId) },
    { name: 'ver', adminOnly: true, group: '查询', help: '插件版本', handler: (ctx, chatId) => handleVerCommand(ctx, chatId) },
    { name: 'ocr', adminOnly: true, group: '操作', help: '识别最近一张图片', handler: (ctx, chatId) => handleOcrCommand(ctx, chatId) },
    { name: 'mode', adminOnly: true, group: '输出', help: '[interim|instant] 出站模式（合并卡片/逐条即时）', handler: (ctx, chatId, arg) => handleModeCommand(ctx, chatId, arg) },
    { name: 'plan', adminOnly: true, group: '输出', help: '[off|内容] 宿主计划模式', handler: (ctx, chatId, arg) => handlePlanCommand(ctx, chatId, arg) },
    { name: 'permission', adminOnly: true, group: '会话', help: '[w|f|预设名|序号] 切换权限预设（w=工作区可写+需审批，f=全盘+免审批）', handler: (ctx, chatId, arg) => handlePermissionCommand(ctx, chatId, arg) },
    { name: 'goal', adminOnly: true, group: '其他', help: '[目标|clear] 目标记录', handler: (ctx, chatId, arg) => handleGoalCommand(ctx, chatId, arg) },
    { name: 'help', adminOnly: true, group: '其他', help: '本帮助', handler: async (ctx, chatId) => {
            await ctx.sendToChat(chatId, helpText());
        } },
];
/** /help group headers in card order; a row whose group is not listed here
 * renders under an appended header (first-seen table order), so a new
 * command row always shows up in the card. */
const HELP_GROUP_ORDER = ['会话', '输出', '查询', '操作', '其他'];
/** /help body: grouped multi-line card generated from the table — adding a
 * command stays a one-row change and its group header comes from the row
 * (unlisted groups append). The R1 tail line documents the unknown-command
 * behavior. Exported for the full-text snapshot gate in tests/commands.spec.ts. */
export function helpText() {
    const groups = new Map();
    for (const c of COMMANDS) {
        const key = c.group ?? '其他';
        const rows = groups.get(key);
        if (rows === undefined)
            groups.set(key, [c]);
        else
            rows.push(c);
    }
    const order = [...groups.keys()].sort((a, b) => {
        const ia = HELP_GROUP_ORDER.indexOf(a);
        const ib = HELP_GROUP_ORDER.indexOf(b);
        return (ia === -1 ? HELP_GROUP_ORDER.length : ia) - (ib === -1 ? HELP_GROUP_ORDER.length : ib);
    });
    const lines = ['可用命令（仅管理员）：'];
    for (const g of order) {
        lines.push('▍' + g);
        for (const c of groups.get(g))
            lines.push('/' + c.name + ' ' + c.help);
    }
    return lines.join('\n') + '\n\n未知命令默认拦截并提示相近命令；unknownCommand: passthrough 可改为透传给模型。';
}
/** Close command-name suggestions for an unknown /word: prefix matches first
 * (table order), then an edit-distance ≤2 fallback that only runs for inputs
 * of length ≥4 (so short real commands like /id or /ver are never shadowed);
 * at most 3 candidates are listed. */
function suggestCommands(input) {
    const names = COMMANDS.map(c => c.name);
    const suggestions = names.filter(n => n.startsWith(input));
    if (suggestions.length === 0 && input.length >= 4) {
        suggestions.push(...names.filter(n => Math.abs(n.length - input.length) <= 2 && editDistanceWithin2(input, n)));
    }
    return suggestions.slice(0, 3);
}
/** Whether the Levenshtein distance between a and b is ≤2 (single words only). */
function editDistanceWithin2(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length] <= 2;
}
/**
 * Slash-command router. Commands are admin-only (the Hermes member
 * slash-command block) and are matched on the first word; a leading
 * @mention glued to the command (QQ group at + text) is stripped first.
 * A path like /tmp/x is never a command (command words are
 * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands get closest-match
 * suggestions (prefix first, edit distance ≤2 for length ≥4 inputs only)
 * and are consumed; with no suggestion, config.unknownCommand decides —
 * 'intercept' (default) consumes with a hint, 'passthrough' returns false
 * so the message reaches the model (the old Hermes fall-through).
 * @param ctx - bridge capabilities (built by ChatBridge).
 * @param chatId - the chat the command arrived in.
 * @param text - parsed inbound text.
 * @param userId - sender QQ number.
 * @returns true when the message was consumed by a command.
 */
export async function tryHandleCommand(ctx, chatId, text, userId) {
    const normalized = text.replace(/^@\d+\s*/, '');
    const first = (normalized.split(/\s+/, 1)[0] ?? '').trim();
    if (!/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(first))
        return false;
    if (!ctx.isAdmin(userId)) {
        await ctx.sendToChat(chatId, '该命令仅管理员可用。');
        return true;
    }
    const name = first.slice(1).toLowerCase();
    ctx.log('debug', 'slash /' + name + ' for ' + chatId);
    const command = COMMANDS.find(c => c.name === name);
    if (command === undefined) {
        const suggestions = suggestCommands(name);
        if (suggestions.length > 0) {
            const names = suggestions.map(s => '/' + s);
            const label = names.length === 1 ? names[0] : names[0] + '（' + names.slice(1).join('、') + '）';
            await ctx.sendToChat(chatId, '未知命令 /' + name + '，你是想用 ' + label + '吗？');
            return true;
        }
        if ((ctx.config.unknownCommand ?? 'intercept') !== 'passthrough') {
            await ctx.sendToChat(chatId, '未知命令 /' + name + '。发 /help 查看命令列表；要让模型处理请去掉开头的 / 重发。');
            return true;
        }
        return false;
    }
    await command.handler(ctx, chatId, normalized.slice(first.length).trim());
    return true;
}
/** /stop: cancel the running generation and drop deferred loop state. */
async function handleStopCommand(ctx, chatId) {
    const chat = ctx.getChat(chatId);
    if (chat !== undefined && chat.agent.status === 'running') {
        chat.agent.cancel({ kind: 'user' });
        // Drop the deferred loop state so the cancelled turn settles silently
        // instead of flushing its partial text as a final.
        chat.loopPending = null;
        chat.loopBuffer = [];
        await ctx.sendToChat(chatId, '⏹ 已停止生成。');
    }
    else {
        await ctx.sendToChat(chatId, '当前没有正在进行的生成。');
    }
}
/** R2: TTL of a pending serial-number selection — judged lazily at the next
 * same-kind numeric reply (no timers): a snapshot older than 5 minutes is
 * expired and treated as stateless. */
const PENDING_SELECTION_TTL_MS = 5 * 60 * 1000;
/**
 * R2 serial-number resolution. When `arg` is a pure number AND the chat holds
 * a pending selection snapshot of the same kind, the argument is read as a
 * 1-based index into that snapshot:
 *  - in-range hit     → clears the snapshot and returns the item (the handler
 *    re-runs its original switch path with `payload`);
 *  - expired snapshot → replies 「序号选择已过期…」, clears it, returns null (stop);
 *  - out of range     → replies 「序号越界…」, KEEPS the snapshot (the user can
 *    retry a correct index without re-listing), returns null (stop).
 * Anything else — a non-numeric argument, or no same-kind snapshot at all —
 * returns undefined so the handler's original semantics run unchanged.
 * Snapshots of other kinds are never touched here (single shared slot,
 * refreshed only by a bare /workspace|/model|/preset).
 */
async function resolveNumericSelection(ctx, chatId, kind, arg, command) {
    if (!/^\d+$/.test(arg.trim()))
        return undefined;
    const pending = ctx.pendingSelection(chatId);
    if (pending === undefined || pending.kind !== kind)
        return undefined;
    if (Date.now() - pending.createdAt > PENDING_SELECTION_TTL_MS) {
        ctx.setPendingSelection(chatId, undefined);
        await ctx.sendToChat(chatId, `❌ 序号选择已过期，请重新执行 ${command} 查看。`);
        return null;
    }
    const item = pending.items[Number(arg.trim()) - 1];
    if (item === undefined) {
        await ctx.sendToChat(chatId, `❌ 序号越界，请回复 ${command} 重新查看列表。`);
        return null;
    }
    ctx.setPendingSelection(chatId, undefined);
    return { payload: item.payload, phase: pending.phase, provider: pending.provider };
}
/** /model: show the current model (+ discoverable providers), or switch.
 * A bare switch retargets ONLY this chat's selection ref (M2-C5a: it no
 * longer rewrites the deployment default — that is the explicit --default
 * form's job). */
async function handleModelCommand(ctx, chatId, arg) {
    const chat = ctx.getChat(chatId);
    const current = chat?.selectionRef?.current
        ?? safeDefaultModel(ctx);
    if (arg === '') {
        const cur = current !== undefined ? current.provider + '/' + current.model : '（未设置）';
        let out = '当前模型：' + cur;
        const providerIds = [];
        try {
            const providers = ctx.llmCatalog?.listProviders() ?? [];
            for (const p of providers.slice(0, 6)) {
                providerIds.push(p.id);
                try {
                    const models = (await ctx.llmCatalog?.listModels(p.id)) ?? [];
                    out += '\n' + p.id + ': ' + models.slice(0, 10).map(m => m.id).join(', ');
                }
                catch (error) {
                    out += '\n' + p.id + ': （列表不可用）';
                    ctx.log('warn', 'listModels failed for ' + p.id + ': ' + String(error));
                }
            }
        }
        catch (error) {
            out += '\n（模型列表不可用）';
            ctx.log('warn', 'listProviders failed: ' + String(error));
        }
        if (providerIds.length > 0) {
            // R2: level-1 snapshot — provider ids only, capped like the display above.
            out += '\n可选来源：\n' + providerIds.map((id, i) => `${i + 1}. ${id}`).join('\n');
            out += '\n回复 /model <序号> 查看该来源的模型。';
            ctx.setPendingSelection(chatId, {
                kind: 'model',
                phase: 'providers',
                items: providerIds.map(id => ({ label: id, payload: id })),
                createdAt: Date.now(),
            });
        }
        await ctx.sendToChat(chatId, out);
        return;
    }
    // R2: a pure-numeric argument is a serial-number pick against the snapshot
    // the bare form rendered — without a live one, the original semantics below
    // run unchanged (and /model --default keeps working: it is not numeric).
    const picked = await resolveNumericSelection(ctx, chatId, 'model', arg, '/model');
    if (picked === null)
        return;
    if (picked !== undefined) {
        if (picked.phase === 'providers') {
            // Level-1 hit: render that provider's numbered model list.
            await sendModelPickList(ctx, chatId, picked.payload);
            return;
        }
        if (picked.phase === 'models' && picked.provider !== undefined) {
            // Level-2 hit: re-enter the ORIGINAL switch path below with
            // '<provider> <model>' (precheck, reply texts and scoping untouched).
            arg = picked.provider + ' ' + picked.payload;
        }
    }
    const first = arg.split(/\s+/, 1)[0] ?? '';
    const toDefault = first === '--default';
    const rest = toDefault ? arg.slice(first.length).trim() : arg;
    const m = /^(\S+)[\s/]+(\S+)$/.exec(rest);
    if (m === null) {
        await ctx.sendToChat(chatId, '❌ 参数不完整或无法识别。\n用法：/model <provider> <model> 切换当前会话；/model --default <provider> <model> 修改部署默认');
        return;
    }
    const provider = m[1];
    const model = m[2];
    try {
        const models = (await ctx.llmCatalog?.listModels(provider)) ?? [];
        if (models.length > 0 && !models.some(x => x.id === model)) {
            await ctx.sendToChat(chatId, `❌ ${provider} 下没有模型 ${model}。可用：` + models.slice(0, 10).map(x => x.id).join(', ') + '\n用法：/model <provider> <model> 切换；/model 查看序号列表');
            return;
        }
    }
    catch (error) {
        ctx.log('debug', 'model switch precheck failed for ' + provider + ': ' + String(error));
    }
    const next = { provider, model };
    if (toDefault) {
        // Explicit --default: rewrite the deployment-wide default only (M2-C5a).
        if (ctx.agentDefaultModel !== undefined) {
            try {
                await ctx.agentDefaultModel.saveSelection(next);
            }
            catch (error) {
                ctx.log('warn', 'saveSelection failed: ' + String(error));
            }
        }
        await ctx.sendToChat(chatId, `✅ 已修改部署默认模型：${provider}/${model}（下一步生效）`);
        return;
    }
    // Bare switch: retarget only this chat's selection ref — never the global
    // default (M2-C5a; the old silent saveSelection here was a scope leak).
    if (chat?.selectionRef !== undefined) {
        chat.selectionRef.current = next;
    }
    await ctx.sendToChat(chatId, `✅ 已切换当前会话模型：${provider}/${model}（下一步生效）`);
}
/** R2 level-2 model list for one provider: renders the numbered models and
 * snapshots them (phase 'models') so the next `/model <序号>` hits the
 * original per-chat switch path with '<provider> <model>'. */
async function sendModelPickList(ctx, chatId, provider) {
    let models;
    try {
        models = (await ctx.llmCatalog?.listModels(provider)) ?? [];
    }
    catch (error) {
        ctx.log('warn', 'listModels failed for ' + provider + ': ' + String(error));
        await ctx.sendToChat(chatId, `❌ 无法列出 ${provider} 的模型，请重新执行 /model 查看。`);
        return;
    }
    const shown = models.slice(0, 10);
    if (shown.length === 0) {
        await ctx.sendToChat(chatId, `（${provider} 下没有可用模型，请重新执行 /model 查看。）`);
        return;
    }
    ctx.setPendingSelection(chatId, {
        kind: 'model',
        phase: 'models',
        provider,
        items: shown.map(m => ({ label: m.id, payload: m.id })),
        createdAt: Date.now(),
    });
    await ctx.sendToChat(chatId, `模型列表（${provider}）：\n` + shown.map((m, i) => `${i + 1}. ${m.id}`).join('\n') + '\n回复 /model <序号> 切换当前会话模型。');
}
/** /workspace: show current cwd, list workspaces, or switch directory. */
async function handleWorkspaceCommand(ctx, chatId, arg) {
    if (arg === '') {
        const cwd = ctx.effectiveCwd(chatId);
        let suffix = '';
        try {
            const ws = await ctx.workspaceRegistry?.resolveByPath(cwd);
            suffix = ws !== undefined ? `（工作区 ${ws.id}，${ws.sessionIds.length} 个会话）` : '（无 workspace 记录）';
        }
        catch (error) {
            ctx.log('debug', 'resolveByPath failed: ' + String(error));
        }
        let out = `当前工作目录：${cwd} ${suffix}\n用法：/workspace <目录路径> 切换；/workspace list 列出全部`;
        // R2: snapshot the numbered list — a following `/workspace <序号>` switches
        // without re-typing the path (payload = the exact path; lazy 5-min TTL).
        try {
            const list = ctx.workspaceRegistry?.list() ?? [];
            if (list.length > 0) {
                let cwdReal = cwd;
                try {
                    cwdReal = await realpath(cwd);
                }
                catch {
                    // marker comparison falls back to the raw cwd
                }
                out += '\n工作区列表：\n' + list.map((w, i) => `${i + 1}. ${w.path}（${w.sessionIds.length} 会话）${w.path === cwd || w.path === cwdReal ? ' ← 当前' : ''}`).join('\n');
                out += '\n回复 /workspace <序号> 切换。';
                ctx.setPendingSelection(chatId, {
                    kind: 'workspace',
                    items: list.map(w => ({ label: w.path, payload: w.path })),
                    createdAt: Date.now(),
                });
            }
        }
        catch (error) {
            ctx.log('debug', 'workspace list failed: ' + String(error));
        }
        await ctx.sendToChat(chatId, out);
        return;
    }
    if (arg === 'list') {
        try {
            const list = ctx.workspaceRegistry?.list() ?? [];
            if (list.length === 0) {
                await ctx.sendToChat(chatId, '（没有任何 workspace 记录）');
                return;
            }
            await ctx.sendToChat(chatId, list.map(w => `${w.id}  ${w.path}（${w.sessionIds.length} 会话）`).join('\n'));
        }
        catch (error) {
            ctx.log('debug', 'workspace list failed: ' + String(error));
            await ctx.sendToChat(chatId, '❌ 无法列出工作区。\n发 /workspace 查看当前工作目录。');
        }
        return;
    }
    // R2: a pure-numeric argument is a serial-number pick against the snapshot
    // above — without a live one it keeps the original path semantics below.
    const picked = await resolveNumericSelection(ctx, chatId, 'workspace', arg, '/workspace');
    if (picked === null)
        return;
    if (picked !== undefined)
        arg = picked.payload;
    try {
        const path = await realpath(arg);
        const s = await stat(path);
        if (!s.isDirectory()) {
            await ctx.sendToChat(chatId, `❌ 不是目录：${arg}\n发 /workspace 查看编号列表，或发 /workspace list 查看全部。`);
            return;
        }
        const hadChat = ctx.hasChat(chatId);
        ctx.setChatWorkspacePath(chatId, path);
        if (hadChat) {
            // Retire the current agent: its session cwd is frozen at creation, so
            // the next message re-creates the session under the new directory.
            await ctx.resetChat(chatId);
        }
        await ctx.sendToChat(chatId, `✅ 工作区已切换：${path}\n下一条消息将使用新工作区（新会话）。`);
        ctx.log('info', 'workspace switch for ' + chatId + ' -> ' + path);
    }
    catch (error) {
        ctx.log('debug', 'workspace switch failed: ' + String(error));
        await ctx.sendToChat(chatId, `❌ 目录无效或不可访问：${arg}\n发 /workspace 查看编号列表，或发 /workspace list 查看全部。`);
    }
}
/** /id: show the chat/session identity (admin debug aid). */
async function handleIdCommand(ctx, chatId) {
    const sessionId = ctx.getChat(chatId)?.sessionId ?? await ctx.sessionIdFromMapping(chatId);
    await ctx.sendToChat(chatId, 'chat    : ' + chatId + '\n' +
        'session : ' + (sessionId ?? '（未建立会话，下一条消息创建）') + '\n' +
        'cwd     : ' + ctx.effectiveCwd(chatId));
}
/** /ver: plugin version + git commit (each read once and cached). */
async function handleVerCommand(ctx, chatId) {
    const commit = gitCommit();
    await ctx.sendToChat(chatId, 'dsh-onebot v' + (packageVersion() ?? '?') + (commit !== undefined ? ' (' + commit + ')' : ''));
}
/** /status: one-shot snapshot of the chat session state. */
async function handleStatusCommand(ctx, chatId) {
    const chat = ctx.getChat(chatId);
    const sessionId = chat?.sessionId ?? await ctx.sessionIdFromMapping(chatId);
    const override = ctx.presetOverride(chatId);
    let preset;
    if (override !== undefined) {
        preset = override + '（/preset 覆盖）';
    }
    else {
        const resolved = await ctx.resolvePresetId(chatId);
        preset = (resolved ?? undefined) !== undefined ? (resolved ?? '') + '（默认/配置）' : '（未记录）';
    }
    const current = chat?.selectionRef?.current ?? safeDefaultModel(ctx);
    const model = current !== undefined ? current.provider + '/' + current.model : '（未设置）';
    const cwd = ctx.effectiveCwd(chatId);
    let wsSuffix = '';
    try {
        const ws = await ctx.workspaceRegistry?.resolveByPath(cwd);
        wsSuffix = ws !== undefined ? `（工作区 ${ws.id}，${ws.sessionIds.length} 个会话）` : '（无 workspace 记录）';
    }
    catch (error) {
        ctx.log('debug', 'resolveByPath failed: ' + String(error));
    }
    const interim = ctx.interimOverride(chatId);
    const modeLabel = interim !== undefined
        ? (interim ? 'interim（合并卡片）' : 'instant（逐条即时）') + '（/mode 覆盖）'
        : (ctx.config.interimMessages ? 'interim（合并卡片）' : 'instant（逐条即时）') + '（全局配置）';
    const agentState = chat !== undefined
        ? 'busy=' + chat.busy + ' loopBuffer=' + chat.loopBuffer.length
        : '（未建立会话）';
    const switchableCount = ctx.switchableSessions(chatId).length;
    await ctx.sendToChat(chatId, 'chat    : ' + chatId + '\n' +
        'session : ' + (sessionId ?? '（未建立会话）') + '\n' +
        'preset  : ' + preset + '\n' +
        'model   : ' + model + '\n' +
        'cwd     : ' + cwd + ' ' + wsSuffix + '\n' +
        '出站     : ' + modeLabel + '\n' +
        'agent   : ' + agentState + '\n' +
        '可切回   : ' + switchableCount + ' 条历史会话（/session 查看列表）');
}
/** /mode: per-chat outbound-mode override (interim vs instant). */
async function handleModeCommand(ctx, chatId, arg) {
    const v = arg.trim().toLowerCase();
    if (v === '' || v === 'status' || v === 'view') {
        const interim = ctx.interimOverride(chatId);
        const eff = interim ?? ctx.config.interimMessages;
        const suffix = interim !== undefined ? '（/mode 覆盖）' : '（全局配置）';
        await ctx.sendToChat(chatId, `当前出站模式：${eff ? 'interim（合并卡片）' : 'instant（逐条即时）'}${suffix}\n用法：/mode interim|instant 切换；/mode 查看`);
        return;
    }
    if (v === 'interim' || v === 'on' || v === 'merge') {
        ctx.setInterimOverride(chatId, true);
        await ctx.sendToChat(chatId, '✅ 出站模式已切换为 interim（合并卡片）。下一条回复生效。');
        return;
    }
    if (v === 'instant' || v === 'off' || v === 'direct') {
        ctx.setInterimOverride(chatId, false);
        await ctx.sendToChat(chatId, '✅ 出站模式已切换为 instant（逐条即时）。下一条回复生效。');
        return;
    }
    const eff = ctx.interimOverride(chatId) ?? ctx.config.interimMessages;
    await ctx.sendToChat(chatId, `❌ 无法识别的出站模式：${arg.trim()}\n当前生效：${eff ? 'interim（合并卡片）' : 'instant（逐条即时）'}\n用法：/mode interim|instant 切换；/mode 查看当前`);
}
/** /retry: re-feed the last user message into the agent. */
async function handleRetryCommand(ctx, chatId) {
    const chat = ctx.getChat(chatId);
    if (chat === undefined) {
        await ctx.sendToChat(chatId, '没有可重试的上一条消息。\n先发送一条消息，之后才能 /retry。');
        return;
    }
    if (chat.busy) {
        await ctx.sendToChat(chatId, '当前正在生成，请稍后再重试。');
        return;
    }
    const text = chat.lastFollowup;
    if (text === undefined || text === '') {
        await ctx.sendToChat(chatId, '没有可重试的上一条消息。\n先发送一条消息，之后才能 /retry。');
        return;
    }
    // Start a fresh reply cycle exactly like a new inbound turn.
    chat.loopBuffer = [];
    chat.loopPending = null;
    ctx.log('info', 'retry for ' + chatId);
    // /retry is admin-gated in tryHandleCommand, so the retried turn's role is
    // the admin who issued the command (M1-A2).
    await ctx.dispatchFollowup(chatId, text, 'admin', chat.lastNickname);
}
/** /ocr: OCR the most recent inbound image via NapCat's ocr_image. */
async function handleOcrCommand(ctx, chatId) {
    // C6a: the command routed before media parsing — resolve the registered
    // pending image ref now (downloads on first use, records the last-image
    // path exactly like the normal path).
    const pending = ctx.takePendingImageRef(chatId);
    if (pending !== undefined) {
        await ctx.resolveMediaRef(pending, chatId);
    }
    const path = ctx.lastImagePath(chatId);
    if (path === undefined || path === '') {
        await ctx.sendToChat(chatId, '请先在对话里发一张图片，再 /ocr。');
        return;
    }
    let b64;
    try {
        b64 = await fileToBase64(path, ctx.config.maxImageBytes);
    }
    catch (error) {
        ctx.log('warn', 'ocr image read failed: ' + String(error));
        await ctx.sendToChat(chatId, `❌ 读取图片失败：${describeError(error)}\n请重新发送图片后再 /ocr。`);
        return;
    }
    let lines;
    try {
        const data = await ctx.connection.call('ocr_image', { image: 'base64://' + b64 });
        const texts = Array.isArray(data.texts) ? data.texts.map(t => t.text ?? '').filter(t => t !== '') : [];
        lines = texts.join('\n');
    }
    catch (error) {
        ctx.log('warn', 'ocr_image failed: ' + String(error));
        await ctx.sendToChat(chatId, `❌ OCR 失败：${describeError(error)}\n请稍后重试，或重新发送图片后再 /ocr。`);
        return;
    }
    if (lines.trim() === '') {
        await ctx.sendToChat(chatId, 'OCR 未识别到文本。');
        return;
    }
    await ctx.sendToChat(chatId, 'OCR 结果：\n' + lines);
}
/** /preset: show available agent presets and the current one, or switch. */
async function handlePresetCommand(ctx, chatId, arg) {
    const listed = await listPresets(ctx);
    if (arg.trim() === '') {
        const current = ctx.presetOverride(chatId)
            ?? await ctx.resolvePresetId(chatId)
            ?? ctx.agentPresets?.defaultId;
        let out = '当前预设：' + (current ?? '（未记录）') + (ctx.hasPresetOverride(chatId) ? '（/preset 覆盖）' : '');
        if (listed.length > 0) {
            out += '\n可用预设：\n' + listed.map((s, i) => `${i + 1}. ${s}`).join('\n');
            // R2: snapshot — payload is the preset id (listPresets renders `id（name）`;
            // ids are directory names, so the first fullwidth paren splits them off).
            ctx.setPendingSelection(chatId, {
                kind: 'preset',
                items: listed.map(s => ({ label: s, payload: s.split('（')[0] })),
                createdAt: Date.now(),
            });
        }
        out += '\n用法：/preset <id> 切换（重建会话）；/preset 查看';
        if (listed.length > 0)
            out += '\n回复 /preset <序号> 切换。';
        await ctx.sendToChat(chatId, out);
        return;
    }
    // R2: a pure-numeric argument is a serial-number pick against the snapshot
    // above — without a live one it keeps the original <id> semantics below.
    const picked = await resolveNumericSelection(ctx, chatId, 'preset', arg, '/preset');
    if (picked === null)
        return;
    if (picked !== undefined)
        arg = picked.payload;
    const id = arg.trim();
    if (ctx.agentPresets === undefined) {
        await ctx.sendToChat(chatId, '❌ 当前宿主未提供 agentPresets 服务。');
        return;
    }
    let resolvedId;
    try {
        const preset = await ctx.agentPresets.resolve(id);
        resolvedId = preset.id;
    }
    catch (error) {
        ctx.log('debug', 'preset resolve failed: ' + String(error));
        await ctx.sendToChat(chatId, '❌ 预设不存在：' + id + (listed.length > 0 ? '\n可用：' + listed.join(', ') : '\n（未枚举到可用预设列表）') + '\n用法：/preset <id|序号> 切换（重建会话）；发 /preset 查看当前与可用列表。');
        return;
    }
    ctx.setPresetOverride(chatId, resolvedId);
    if (ctx.hasChat(chatId)) {
        await ctx.resetChat(chatId);
    }
    ctx.log('info', 'preset switch for ' + chatId + ' -> ' + resolvedId);
    await ctx.sendToChat(chatId, `✅ 预设已切换：${resolvedId}\n下一条消息将重建会话并按新预设运行。`);
}
/** /session: list this chat's switchable retired sessions (the ones /new,
 * /workspace and /preset retired with intact history), or switch the chat back
 * to one by serial number. The numbered list is snapshotted (R2, kind
 * 'session') so a following `/session <序号>` picks without re-listing. */
async function handleSessionCommand(ctx, chatId, arg) {
    if (arg.trim() === '') {
        const list = ctx.switchableSessions(chatId);
        const current = ctx.getChat(chatId)?.sessionId ?? await ctx.sessionIdFromMapping(chatId);
        if (list.length === 0) {
            await ctx.sendToChat(chatId, '当前 session：' + (current ?? '（未建立会话）') + '\n（该会话没有可切回的历史会话）\n用法：/session <序号> 切回；/new、/workspace、/preset 切换下来的旧会话会进入列表。');
            return;
        }
        let out = '当前 session：' + (current ?? '（未建立会话）') + '\n可切回历史会话：\n' + list.map((e, i) => `${i + 1}. ${e.id}（${formatRetiredAt(e.retiredAt)} 退休）`).join('\n');
        out += '\n回复 /session <序号> 切回（当前会话会进入列表，可来回切换）。';
        ctx.setPendingSelection(chatId, {
            kind: 'session',
            items: list.map(e => ({ label: e.id, payload: e.id })),
            createdAt: Date.now(),
        });
        await ctx.sendToChat(chatId, out);
        return;
    }
    // A busy chat must not be switched mid-generation (the outbound pipeline and
    // the interim state belong to the live agent; the switch disposes it).
    const chat = ctx.getChat(chatId);
    if (/^\d+$/.test(arg.trim()) && chat !== undefined && chat.busy) {
        await ctx.sendToChat(chatId, '当前正在生成回复，请先 /stop 再切换会话。');
        return;
    }
    const picked = await resolveNumericSelection(ctx, chatId, 'session', arg, '/session');
    if (picked === null)
        return;
    if (picked === undefined) {
        await ctx.sendToChat(chatId, '用法：/session 查看可切回会话；/session <序号> 切回。');
        return;
    }
    const outcome = await ctx.switchSession(chatId, picked.payload);
    if (outcome.ok) {
        await ctx.sendToChat(chatId, `✅ 已切回历史会话：${outcome.sessionId}\n（原会话已进入可切回列表，发 /session 查看；下一条消息继续该会话的历史上下文。）`);
        return;
    }
    if (outcome.reason === 'busy') {
        await ctx.sendToChat(chatId, '当前正在生成回复，请先 /stop 再切换会话。');
        return;
    }
    if (outcome.reason === 'not-switchable') {
        await ctx.sendToChat(chatId, '❌ 该序号对应的会话不在当前会话的可切回列表中。发 /session 重新查看。');
        return;
    }
    if (outcome.reason === 'broken') {
        await ctx.sendToChat(chatId, '❌ 该历史会话已损坏，无法切回。\n发 /session 查看其他可切回会话。');
        return;
    }
    await ctx.sendToChat(chatId, '❌ 切回历史会话失败：' + outcome.message + '\n已回退：下一条消息将开启全新会话，原会话仍保留在 /session 列表中。');
}
/** Render a retired-at timestamp as YYYY-MM-DD HH:mm (local time). */
function formatRetiredAt(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
/** Unwrap the host command execution outcome: dsh ≥0.1.5-rc.1 settles as
 * the `{ commandId, result: { kind, text } }` wrapper while older hosts
 * returned the flat `{ kind, text }` (and safely ignore the extra
 * attachments argument). undefined stays undefined — an admission miss
 * (unknown command name) under both host versions. */
function unwrapCommandResult(executed) {
    if (executed === undefined)
        return undefined;
    return 'result' in executed ? executed.result : executed;
}
/** /plan: forward to the HOST plan command so QQ enters/leaves host plan
 * mode (the host `/plan off` path exits directly, no Web review card). The
 * plugin no longer runs its own prefix plan mode — that duplicated the host
 * semantic and shadowed the host `/plan off` exit. */
async function handlePlanCommand(ctx, chatId, arg) {
    const chat = ctx.getChat(chatId);
    if (chat === undefined) {
        await ctx.sendToChat(chatId, '请先发一条消息建立会话，再 /plan。');
        return;
    }
    const commands = ctx.commands;
    if (commands === undefined) {
        await ctx.sendToChat(chatId, '❌ 宿主未提供 commands 服务，无法切换计划模式。');
        return;
    }
    const line = arg.trim() === '' ? '/plan' : '/plan ' + arg.trim();
    try {
        // The host command runtime requires the attachments array (it reads
        // `.length` unconditionally) and a signal (it reads `signal.aborted`
        // unconditionally) — pass an empty array and a fresh never-aborted one;
        // QQ user-initiated /plan must not be interruptible by our own
        // cancellation.
        const result = unwrapCommandResult(await commands.execute(chat.agent, line, [], new AbortController().signal));
        const text = result?.text !== undefined && result.text !== '' ? result.text : (arg.trim().toLowerCase() === 'off' ? '已退出计划模式。' : '已进入计划模式。');
        const hint = arg.trim().toLowerCase() === 'off' ? '' : '\n（QQ 退出计划模式：发 /plan off）';
        await ctx.sendToChat(chatId, text + hint);
        ctx.log('info', 'host plan command for ' + chatId + ': ' + line);
    }
    catch (error) {
        ctx.log('warn', 'host plan command failed: ' + String(error));
        await ctx.sendToChat(chatId, '❌ 计划模式切换失败：' + describeError(error) + '\n可稍后重试；发 /plan 查看当前计划模式状态。');
    }
}
/** QQ-side short aliases for /permission, resolved BEFORE forwarding: the
 * two default host presets get terse names. Full preset names pass through
 * untouched — the host owns the presets table (a deployment may override it
 * via cordis.patch.yml), and its unknown-name error reply lists the
 * available presets, which the plugin relays verbatim. */
const PERMISSION_PRESET_ALIASES = {
    w: 'workspace-write',
    ws: 'workspace-write',
    write: 'workspace-write',
    工作区: 'workspace-write',
    f: 'danger-full-access',
    full: 'danger-full-access',
    danger: 'danger-full-access',
    全权: 'danger-full-access',
};
/** QQ shortcut hint: the bare-form parse-failure fallback and the ❌-relay
 * tail (the host lists its own presets; these are the QQ-side shortcuts). */
const PERMISSION_USAGE_HINT = '（QQ 快捷用法：/permission w 切工作区可写+需审批、/permission f 切全盘+免审批；也支持完整预设名或序号）';
/** /permission: show the current host permission preset (the bare form
 * renders the parsed Chinese menu: current + numbered available list + usage
 * line; on host-reply format drift it falls back to the verbatim relay + QQ
 * hint) or switch it (sandbox mode + approval policy, effective immediately
 * in the session). Same host-forwarding pattern as /plan. A pure number
 * indexes the available list the bare form parses, resolved live per
 * invocation — deliberately NO pending-selection snapshot: with two presets
 * a stored snapshot could only ever disagree with the host reply, so the
 * bare pre-flight is the single source of truth. */
async function handlePermissionCommand(ctx, chatId, arg) {
    const chat = ctx.getChat(chatId);
    if (chat === undefined) {
        await ctx.sendToChat(chatId, '请先发一条消息建立会话，再 /permission。');
        return;
    }
    const commands = ctx.commands;
    if (commands === undefined) {
        await ctx.sendToChat(chatId, '❌ 宿主未提供 commands 服务，无法切换权限预设。');
        return;
    }
    // One host /permission execution: returns the settled reply (null when a
    // failure was already reported to the chat). Same forwarding constraints
    // as /plan — the host runtime reads submittedAttachments.length and
    // signal.aborted unconditionally, so pass an empty array and a fresh
    // never-aborted signal; a QQ-initiated switch must not be interruptible
    // by our own cancellation.
    const executeHost = async (line) => {
        try {
            const live = ctx.getChat(chatId);
            if (live === undefined)
                return null;
            const result = unwrapCommandResult(await commands.execute(live.agent, line, [], new AbortController().signal));
            if (result === undefined) {
                // Host admission miss: /permission is only registered when the
                // permission-presets plugin is composed on the host side.
                await ctx.sendToChat(chatId, '❌ 宿主未注册 /permission 命令（未挂载权限预设插件）。');
                return null;
            }
            return { ok: result.kind !== 'error', text: result.text ?? '' };
        }
        catch (error) {
            ctx.log('warn', 'host permission command failed: ' + String(error));
            await ctx.sendToChat(chatId, '❌ 权限预设切换失败：' + describeError(error) + '\n可稍后重试；发 /permission 查看当前权限。');
            return null;
        }
    };
    const relayMarked = async (result, preset) => {
        // Success: the host's own reply is too terse ('preset X') — render the
        // switch confirmation with the Chinese meaning label (deployment-custom
        // preset names fall back to a fixed label). ❌ relays keep the host text
        // verbatim and append the QQ usage hint so the failure is actionable
        // without a second round-trip.
        if (result.ok) {
            await ctx.sendToChat(chatId, '✅ 已切换权限预设：' + preset + '（' + (PERMISSION_PRESET_LABELS[preset] ?? '部署自定义') + '）');
            return;
        }
        await ctx.sendToChat(chatId, '❌ ' + result.text + '\n' + PERMISSION_USAGE_HINT);
    };
    const trimmed = arg.trim();
    if (trimmed === '') {
        // Bare form: render the parsed host reply as a Chinese menu — current
        // preset line, numbered available list (「← 当前」 marker + meaning label
        // per preset) and the usage line. When the reply does not match the
        // expected host shape, renderPermissionMenu falls back to the previous
        // behavior (verbatim relay + QQ shortcut hint) instead of crashing.
        const bare = await executeHost('/permission');
        if (bare !== null)
            await ctx.sendToChat(chatId, renderPermissionMenu(bare.text));
        return;
    }
    if (/^\d+$/.test(trimmed)) {
        // Pure number: index into the bare form's available list (live pre-flight).
        const bare = await executeHost('/permission');
        if (bare === null)
            return;
        const available = parseAvailablePresets(bare.text);
        const preset = available[Number(trimmed) - 1];
        if (preset === undefined) {
            // Out-of-range index or unparsable list: fall back to the usage hint,
            // relaying whatever the host replied so the real list stays visible.
            const reply = '❌ 序号 ' + trimmed + ' 无法解释为可用预设。' + (bare.text !== '' ? '\n' + bare.text : '') + '\n' + PERMISSION_USAGE_HINT;
            await ctx.sendToChat(chatId, reply);
            return;
        }
        const switched = await executeHost('/permission ' + preset);
        if (switched !== null)
            await relayMarked(switched, preset);
        return;
    }
    // Alias first (QQ-side, case-insensitive); anything else is forwarded
    // verbatim as a full preset name — unknown names come back as the host's
    // error reply (with the available list), relayed with the ❌ mark.
    const preset = PERMISSION_PRESET_ALIASES[trimmed.toLowerCase()] ?? trimmed;
    const switched = await executeHost('/permission ' + preset);
    if (switched !== null)
        await relayMarked(switched, preset);
}
/** Parse the 「(available: A, B)」 list out of a host permission reply (both
 * the bare listing and the unknown-preset error carry it). Returns [] when
 * the reply does not match the host's reply shape. */
function parseAvailablePresets(text) {
    const m = /\(available: ([^)]*)\)/.exec(text);
    if (m === null)
        return [];
    return m[1].split(',').map(s => s.trim()).filter(s => s !== '');
}
const PERMISSION_PRESET_LABELS = {
    'workspace-write': '工作区可写+需审批',
    'danger-full-access': '全盘+免审批',
};
/** The usage line that closes the bare-form menu. */
const PERMISSION_USAGE = '用法：/permission <序号|w|f|完整名> 切换，立即生效';
/** Parse the 「current preset X」 marker out of a host permission reply
 * (undefined when the reply does not match the host's reply shape). */
function parseCurrentPreset(text) {
    return /current preset ([^\s(]+)/.exec(text)?.[1];
}
/** /permission bare form: the host reply parsed into a Chinese menu —
 * current preset line, numbered available list (「← 当前」 marker, meaning
 * label per preset, 「部署自定义」 for names outside the default two, never a
 * guess) and the usage line. Any parse failure (host reply format drift)
 * falls back to the previous behavior — verbatim relay + QQ shortcut hint —
 * and never throws. */
function renderPermissionMenu(hostText) {
    const available = parseAvailablePresets(hostText);
    const current = parseCurrentPreset(hostText);
    if (available.length === 0 || current === undefined) {
        return hostText + '\n' + PERMISSION_USAGE_HINT;
    }
    const labelOf = (preset) => PERMISSION_PRESET_LABELS[preset] ?? '部署自定义';
    return [
        '当前权限：' + current + '（' + labelOf(current) + '）',
        '可用预设：',
        ...available.map((p, i) => (i + 1) + '. ' + p + '（' + labelOf(p) + '）' + (p === current ? ' ← 当前' : '')),
        PERMISSION_USAGE,
    ].join('\n');
}
/** /goal: per-chat objective — recorded and reminded on each turn. */
async function handleGoalCommand(ctx, chatId, arg) {
    const v = arg.trim();
    if (v === '') {
        const goal = ctx.goal(chatId);
        await ctx.sendToChat(chatId, '当前目标：' + (goal !== undefined && goal !== '' ? '\n' + goal : '（未设置）') + '\n用法：/goal <目标> 设置/更新；/goal clear 清除');
        return;
    }
    if (v.toLowerCase() === 'clear' || v === '删除' || v === '移除') {
        ctx.deleteGoal(chatId);
        await ctx.sendToChat(chatId, '✅ 目标已清除。');
        return;
    }
    ctx.setGoal(chatId, v);
    await ctx.sendToChat(chatId, '✅ 目标已记录（每轮自动附带提醒）：\n' + v);
}
/** Current default model selection, best-effort (absent services return undefined). */
function safeDefaultModel(ctx) {
    try {
        return ctx.agentDefaultModel?.currentSelection();
    }
    catch (error) {
        ctx.log('debug', 'currentSelection failed: ' + String(error));
        return undefined;
    }
}
/** Enumerate the on-disk agent presets (<dsh-home>/.agent-presets/*). */
async function listPresets(ctx) {
    const home = ctx.dshHome;
    if (home === undefined || home === '')
        return [];
    const root = join(home, '.agent-presets');
    try {
        const entries = await readdir(root, { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            let label = entry.name;
            try {
                const text = await readFile(join(root, entry.name, 'preset.yml'), 'utf8');
                const m = /^name\s*:\s*(.+?)\s*$/m.exec(text);
                if (m !== null && m[1].trim() !== '')
                    label = m[1].trim();
            }
            catch {
                // no preset.yml — fall back to the directory id
            }
            out.push(entry.name + (label !== entry.name ? '（' + label + '）' : ''));
        }
        return out.sort();
    }
    catch (error) {
        ctx.log('debug', 'preset enumeration failed: ' + String(error));
        return [];
    }
}
/** Plugin version from package.json, read once (per process). */
let cachedPluginVersion;
function packageVersion() {
    if (cachedPluginVersion === undefined) {
        try {
            const pkg = JSON.parse(readFileSync(join(dirname(__dirname), 'package.json'), 'utf8'));
            cachedPluginVersion = typeof pkg.version === 'string' ? pkg.version : undefined;
        }
        catch {
            cachedPluginVersion = undefined;
        }
    }
    return cachedPluginVersion;
}
/** Git short commit of the plugin repo, read once (best-effort, per process). */
let cachedGitCommit;
function gitCommit() {
    if (cachedGitCommit === undefined) {
        try {
            const root = dirname(__dirname);
            const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
            cachedGitCommit = commit !== '' ? commit : undefined;
        }
        catch {
            cachedGitCommit = undefined;
        }
    }
    return cachedGitCommit;
}
