/**
 * qq_napcat_api 的放行规则：可配置的动作白名单（napcatApiAllow，'*' = 禁区
 * 以外全部放行）、写死在代码里的禁区（配置打不开），以及参数里本机文件路径
 * 的放行目录（napcatApiFileRoots）。
 *
 * 缺省配置（白名单 = DEFAULT_NAPCAT_API_ALLOW 原样、放行目录为空）下，工具
 * 说明文字、报错文字和放行结果都与引入本模块之前逐字节一致。
 * @module dsh-onebot/napcat-api
 */
/** 缺省白名单（= 0.11.0 及以前写死的那份，顺序不能改：缺省说明文字按它拼）。 */
export declare const DEFAULT_NAPCAT_API_ALLOW: readonly string[];
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
export declare const NAPCAT_API_DENY: readonly string[];
/** 只读查询当前放行规则的伪动作名（不发给协议端）。 */
export declare const NAPCAT_API_LIST_ACTION = "list";
/** 把动作名归一成比较禁区用的规范名（见 NAPCAT_API_DENY 注释）。 */
export declare function normalizeActionName(action: string): string;
/** 动作是否落在禁区（配置怎么写都打不开）。 */
export declare function isDeniedAction(action: string): boolean;
/** qq_napcat_api 的插件页配置（index.ts apply() 注入）。 */
export interface NapcatApiConfig {
    /** 放行的动作名；含 '*' = 禁区以外全部放行。 */
    allow: readonly string[];
    /** 参数里的本机文件必须落在这些目录内；空 = 不检查（缺省，与以前一致）。 */
    fileRoots: readonly string[];
}
/** 生效中的规则（模块级单例，同 tools.ts 的 sendSegmentsConfig）。 */
export interface NapcatApiRules {
    /** true = 缺省配置：说明文字、报错与以前逐字节一致，不提供 list。 */
    legacy: boolean;
    /** true = allow 里有 '*'。 */
    all: boolean;
    /** 显式放行的动作（去空白、去重；不含 '*'）。 */
    allow: string[];
    /** 放行目录（~/ 已展开、已 resolve）。 */
    fileRoots: string[];
}
/** 由配置算出生效规则；undefined = 缺省。 */
export declare function resolveNapcatApiRules(config: Partial<NapcatApiConfig> | undefined): NapcatApiRules;
/** 安装 qq_napcat_api 的放行规则（apply() 在注册工具之前调用一次；undefined = 缺省）。 */
export declare function configureNapcatApi(config: Partial<NapcatApiConfig> | undefined): NapcatApiRules;
/** 当前生效规则（只读快照）。 */
export declare function napcatApiRules(): NapcatApiRules;
/** 工具说明（缺省时与以前逐字节一致）。 */
export declare function napcatToolDescription(r?: NapcatApiRules): string;
/** action 参数说明（缺省时与以前逐字节一致）。 */
export declare function napcatActionDescription(r?: NapcatApiRules): string;
/** list 伪动作的返回值。 */
export declare function napcatApiListing(r?: NapcatApiRules): Record<string, unknown>;
/**
 * 放行判定：返回 undefined = 放行；否则返回给模型的报错文字。缺省配置走与
 * 以前完全相同的判定和报错。
 */
export declare function checkNapcatAction(action: unknown, r?: NapcatApiRules): string | undefined;
/** 一处像本机文件的参数值。 */
export interface LocalPathCandidate {
    /** 参数位置，如 params.message[0].data.file。 */
    where: string;
    value: string;
}
/**
 * 一个字符串是否「像本机文件」：file: 开头、盘符开头（C:\ / C:/，也含 C:foo
 * 这类盘符相对路径——acceptableShape 会把非绝对路径整体拒绝，fail closed）、
 * POSIX 绝对路径（/ 开头）、UNC / 设备路径（\\ 或 // 开头、\??\ 开头）、
 * ./ 或 ../ 开头的相对路径（相对的是协议端的工作目录，没法核，一律当本机
 * 文件处理）。http(s)://、base64:// 等其他 scheme 不算。
 */
export declare function looksLikeLocalPath(value: string): boolean;
/**
 * 递归收集 params 里像本机文件的字符串（含数组、嵌套对象、CQ 码里的参数）。
 * 层数或字符串个数超限时抛错（参数太大，没法逐个核）。
 */
export declare function collectLocalPathCandidates(params: unknown): LocalPathCandidate[];
/**
 * 核对 params 里的本机文件都落在放行目录内（resolve + realpath，按路径分隔符
 * 边界比较，复用 media.ts 的 resolveContainedPath）。放行目录为空时不检查。
 * 返回 undefined = 通过；否则返回给模型的报错文字。
 */
export declare function checkNapcatParamPaths(params: unknown, r?: NapcatApiRules): Promise<string | undefined>;
