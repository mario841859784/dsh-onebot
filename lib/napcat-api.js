/**
 * qq_napcat_api 的放行规则：可配置的动作白名单（napcatApiAllow，'*' = 禁区
 * 以外全部放行）、写死在代码里的禁区（配置打不开），以及参数里本机文件路径
 * 的放行目录（napcatApiFileRoots）。
 *
 * 缺省配置（白名单 = DEFAULT_NAPCAT_API_ALLOW 原样、放行目录为空）下，工具
 * 说明文字、报错文字和放行结果都与引入本模块之前逐字节一致。
 * @module dsh-onebot/napcat-api
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveContainedPath } from './media.js';
import { cqUnescape } from './cq.js';
/** 缺省白名单（= 0.11.0 及以前写死的那份，顺序不能改：缺省说明文字按它拼）。 */
export const DEFAULT_NAPCAT_API_ALLOW = [
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
/**
 * 禁区（规范名）。比较前动作名先经 normalizeActionName：去掉首尾空白、统一
 * 小写、去掉前导的点和下划线、去掉 nc_ 前缀、去掉 go-cqhttp 约定的 _async /
 * _rate_limited 后缀（这两个后缀在多数实现里等同原动作）。所以 .send_packet、
 * nc_get_cookies、GET_COOKIES、bot_exit_async 都算禁区。
 * - 取登录凭据和密钥：get_cookies、get_credentials、get_clientkey、
 *   get_csrf_token、request_decrypt_key（及几个常见拼法）；
 * - 发原始协议包：send_packet；
 * - 让协议端退出 / 重启：bot_exit、set_restart（及旧名 set_restart_plugin）；
 * - .handle_quick_operation（按 operation 回复 / 撤回 / 踢 / 禁言 / 同意请求，
 *   一个动作绕过全部单项放行）。
 */
export const NAPCAT_API_DENY = [
    'get_cookies',
    'get_cookie',
    'get_credentials',
    'get_clientkey',
    'get_client_key',
    'get_csrf_token',
    'get_csrf',
    'request_decrypt_key',
    'send_packet',
    'bot_exit',
    'set_restart',
    'set_restart_plugin',
    'handle_quick_operation',
];
/** 只读查询当前放行规则的伪动作名（不发给协议端）。 */
export const NAPCAT_API_LIST_ACTION = 'list';
/** 把动作名归一成比较禁区用的规范名（见 NAPCAT_API_DENY 注释）。 */
export function normalizeActionName(action) {
    let name = action.trim().toLowerCase();
    for (;;) {
        const before = name;
        name = name.replace(/^[._]+/, '').replace(/^nc_/, '').replace(/(?:_async|_rate_limited)$/, '');
        if (name === before)
            return name;
    }
}
/** 动作是否落在禁区（配置怎么写都打不开）。 */
export function isDeniedAction(action) {
    return NAPCAT_API_DENY.includes(normalizeActionName(action));
}
function expandHomeDir(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/') || path.startsWith('~\\'))
        return resolve(homedir(), path.slice(2));
    return path;
}
/** 由配置算出生效规则；undefined = 缺省。 */
export function resolveNapcatApiRules(config) {
    const rawAllow = config?.allow ?? DEFAULT_NAPCAT_API_ALLOW;
    const rawRoots = config?.fileRoots ?? [];
    const trimmed = rawAllow.filter((a) => typeof a === 'string').map(a => a.trim()).filter(a => a !== '');
    const all = trimmed.includes('*');
    const allow = [...new Set(trimmed.filter(a => a !== '*'))];
    const fileRoots = rawRoots
        .filter((r) => typeof r === 'string' && r.trim() !== '')
        .map(r => resolve(expandHomeDir(r.trim())));
    const legacy = !all && fileRoots.length === 0
        && rawAllow.length === DEFAULT_NAPCAT_API_ALLOW.length
        && rawAllow.every((a, i) => a === DEFAULT_NAPCAT_API_ALLOW[i]);
    return { legacy, all, allow, fileRoots };
}
let rules = resolveNapcatApiRules(undefined);
/** 安装 qq_napcat_api 的放行规则（apply() 在注册工具之前调用一次；undefined = 缺省）。 */
export function configureNapcatApi(config) {
    rules = resolveNapcatApiRules(config);
    return rules;
}
/** 当前生效规则（只读快照）。 */
export function napcatApiRules() {
    return { ...rules, allow: [...rules.allow], fileRoots: [...rules.fileRoots] };
}
const LEGACY_TOOL_DESCRIPTION = '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。';
const DENY_SUMMARY = '禁区（配置也打不开）：取登录凭据和密钥（get_cookies、get_credentials、get_clientkey、get_csrf_token、request_decrypt_key）、发原始协议包（send_packet）、让协议端退出或重启（bot_exit、set_restart）、.handle_quick_operation';
/** 工具说明（缺省时与以前逐字节一致）。 */
export function napcatToolDescription(r = rules) {
    if (r.legacy)
        return LEGACY_TOOL_DESCRIPTION;
    const head = r.all
        ? '调用 OneBot 11 / NapCat 扩展 API：除禁区外的 OneBot 11 / NapCat 扩展动作都可以调用。'
        : '调用白名单内的 OneBot 11 / NapCat 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。';
    const files = r.fileRoots.length > 0
        ? '参数里的本机文件（绝对路径或 file:// 地址）必须在放行目录内，否则整次调用被拒绝。'
        : '';
    return head + DENY_SUMMARY + '。' + files + 'action 填 "' + NAPCAT_API_LIST_ACTION + '" 可查看当前放行规则（不调用协议端）。';
}
/** action 参数说明（缺省时与以前逐字节一致）。 */
export function napcatActionDescription(r = rules) {
    if (r.legacy)
        return '白名单 action：' + DEFAULT_NAPCAT_API_ALLOW.join(' / ');
    const list = '；"' + NAPCAT_API_LIST_ACTION + '" = 查看当前放行规则';
    if (r.all)
        return '除禁区外的 OneBot 11 / NapCat 扩展动作名' + list;
    return '白名单 action：' + r.allow.join(' / ') + list;
}
/** list 伪动作的返回值。 */
export function napcatApiListing(r = rules) {
    return {
        allow: r.all ? '*' : [...r.allow],
        deny: [...NAPCAT_API_DENY],
        denyMatching: '比较前去掉首尾空白、统一小写、去掉前导的点和下划线、nc_ 前缀和 _async / _rate_limited 后缀',
        fileRoots: [...r.fileRoots],
        fileCheck: r.fileRoots.length > 0
            ? '参数里的本机文件（绝对路径、file:// 地址、CQ 码里的这两种、./ 或 ../ 开头的相对路径）必须在 fileRoots 内且存在'
            : '未配置放行目录，不检查参数里的本机文件路径',
    };
}
/**
 * 放行判定：返回 undefined = 放行；否则返回给模型的报错文字。缺省配置走与
 * 以前完全相同的判定和报错。
 */
export function checkNapcatAction(action, r = rules) {
    if (r.legacy) {
        if (typeof action !== 'string' || !DEFAULT_NAPCAT_API_ALLOW.includes(action)) {
            return 'qq_napcat_api: action 不在白名单内（' + DEFAULT_NAPCAT_API_ALLOW.join(', ') + '）';
        }
        return undefined;
    }
    if (typeof action !== 'string' || action.trim() === '') {
        return 'qq_napcat_api: action 必填（"' + NAPCAT_API_LIST_ACTION + '" 可查看当前放行规则）';
    }
    if (isDeniedAction(action)) {
        return 'qq_napcat_api: action「' + action.slice(0, 64) + '」在禁区内，配置也不能放行。' + DENY_SUMMARY;
    }
    if (r.all)
        return undefined;
    if (!r.allow.includes(action)) {
        return 'qq_napcat_api: action 不在白名单内（' + r.allow.join(', ') + '）；"' + NAPCAT_API_LIST_ACTION + '" 可查看当前放行规则';
    }
    return undefined;
}
/** 值是 QQ 群文件系统里的目录（如 "/"、"/abc"），不是本机路径，不检查。 */
const GROUP_FS_KEYS = new Set(['folder', 'folder_id', 'parent_id', 'parent_directory', 'target_directory', 'current_parent_directory']);
/** 值是消息正文：只看其中 CQ 码的参数，正文本身（如「/help」）不当路径。 */
const TEXT_KEYS = new Set(['text', 'content', 'message', 'raw_message']);
const MAX_DEPTH = 32;
const MAX_STRINGS = 4096;
/**
 * 一个字符串是否「像本机文件」：file: 开头、盘符绝对路径（C:\ / C:/）、
 * POSIX 绝对路径（/ 开头）、UNC / 设备路径（\\ 或 // 开头、\??\ 开头）、
 * ./ 或 ../ 开头的相对路径（相对的是协议端的工作目录，没法核，一律当本机
 * 文件处理）。http(s)://、base64:// 等其他 scheme 不算。
 */
export function looksLikeLocalPath(value) {
    const v = value.trim();
    if (v === '')
        return false;
    if (/^file:/i.test(v))
        return true;
    if (/^[a-z][a-z0-9+.-]+:\/\//i.test(v))
        return false; // http(s):// 等远程地址
    if (/^base64:\/\//i.test(v))
        return false;
    if (/^[a-z]:[\\/]/i.test(v))
        return true;
    if (v.startsWith('/') || v.startsWith('\\'))
        return true;
    if (v === '.' || v === '..' || /^\.\.?[\\/]/.test(v))
        return true;
    return false;
}
/** 从 CQ 码串里取出各参数值（反转义后）。 */
function cqParamValues(text) {
    const values = [];
    for (const m of text.matchAll(/\[CQ:[^\],]*((?:,[^\]]*)?)\]/gi)) {
        for (const pair of m[1].split(',')) {
            const eq = pair.indexOf('=');
            if (eq > 0)
                values.push(cqUnescape(pair.slice(eq + 1)));
        }
    }
    return values;
}
/**
 * 递归收集 params 里像本机文件的字符串（含数组、嵌套对象、CQ 码里的参数）。
 * 层数或字符串个数超限时抛错（参数太大，没法逐个核）。
 */
export function collectLocalPathCandidates(params) {
    const out = [];
    let seen = 0;
    const visit = (value, where, key, depth) => {
        if (depth > MAX_DEPTH)
            throw new Error('qq_napcat_api: params 嵌套太深，无法核对本机文件路径');
        if (typeof value === 'string') {
            seen += 1;
            if (seen > MAX_STRINGS)
                throw new Error('qq_napcat_api: params 里的字符串太多，无法核对本机文件路径');
            if (/\[CQ:/i.test(value)) {
                for (const inner of cqParamValues(value)) {
                    if (looksLikeLocalPath(inner))
                        out.push({ where: where + '（CQ 码）', value: inner });
                }
            }
            if (TEXT_KEYS.has(key) || GROUP_FS_KEYS.has(key))
                return;
            if (looksLikeLocalPath(value))
                out.push({ where, value });
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) => visit(item, where + '[' + index + ']', key, depth + 1));
            return;
        }
        if (typeof value === 'object' && value !== null) {
            for (const [k, v] of Object.entries(value)) {
                visit(v, where + '.' + k, k.toLowerCase(), depth + 1);
            }
        }
    };
    visit(params, 'params', '', 0);
    return out;
}
/**
 * 把一个像本机文件的值换成要核对的本机路径（可能不止一种读法：file:// 地址
 * 按 URL 规范解一次，再按「去掉 file:// 前缀、百分号解码」的常见协议端读法解
 * 一次，两种都要过）。返回 undefined = 形状本身就不可接受。
 */
function pathReadings(value) {
    const v = value.trim();
    if (/^file:/i.test(v)) {
        let viaUrl;
        try {
            viaUrl = fileURLToPath(new URL(v));
        }
        catch {
            return undefined;
        }
        let raw;
        try {
            raw = decodeURIComponent(v.replace(/^file:/i, '').replace(/^\/\/\/(?=[a-z]:)/i, '').replace(/^\/\//, ''));
        }
        catch {
            return undefined;
        }
        return [viaUrl, raw];
    }
    return [v];
}
/** 单个本机路径的形状检查（UNC / 设备路径 / NTFS 流 / 相对路径 / NUL 一律拒）。 */
function acceptableShape(path) {
    if (path.includes('\0'))
        return false;
    if (/^[\\/]{2}/.test(path) || path.startsWith('\\??\\'))
        return false; // \\server\share、\\?\、\\.\、//server
    const isDrive = /^[a-z]:[\\/]/i.test(path);
    const isPosixAbs = path.startsWith('/') || (process.platform === 'win32' && path.startsWith('\\'));
    if (!isDrive && !isPosixAbs)
        return false; // 相对路径：相对的是协议端的工作目录，核不了
    const rest = isDrive ? path.slice(2) : path;
    if (rest.includes(':'))
        return false; // C:\foo:stream 这类 NTFS 备用数据流
    return true;
}
/**
 * 核对 params 里的本机文件都落在放行目录内（resolve + realpath，按路径分隔符
 * 边界比较，复用 media.ts 的 resolveContainedPath）。放行目录为空时不检查。
 * 返回 undefined = 通过；否则返回给模型的报错文字。
 */
export async function checkNapcatParamPaths(params, r = rules) {
    if (r.fileRoots.length === 0)
        return undefined;
    let candidates;
    try {
        candidates = collectLocalPathCandidates(params);
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    for (const candidate of candidates) {
        const shown = JSON.stringify(candidate.value.slice(0, 256));
        const readings = pathReadings(candidate.value);
        let ok = readings !== undefined;
        if (readings !== undefined) {
            for (const reading of readings) {
                if (!acceptableShape(reading) || (await resolveContainedPath(r.fileRoots, resolve(reading))) === null) {
                    ok = false;
                    break;
                }
            }
        }
        if (!ok) {
            return 'qq_napcat_api: ' + candidate.where + ' 的本机文件 ' + shown
                + ' 不在放行目录（napcatApiFileRoots）内、不存在，或是不接受的写法（网络共享 / 设备路径 / NTFS 流 / 相对路径）；只能用放行目录里已存在文件的绝对路径';
        }
    }
    return undefined;
}
