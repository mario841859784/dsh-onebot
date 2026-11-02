/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-onebot/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatBridge } from './bridge.js';
import type { OneBotConnection } from './connection.js';
/**
 * T14 (#6 补充): qq_send_segments 插件页开关与发送间隔。配置在插件挂载时由
 * index.ts 经 configureSendSegments 注入（模块级单例：dsh-onebot 是单实例
 * 插件，registerTools 的调用点在 bridge.ts 且不在本任务 scope 内）；缺省
 * 保持 0.9.x 行为（启用、无间隔）。
 */
export interface SendSegmentsConfig {
    enabled: boolean;
    /** 相邻两段发送之间的延时（毫秒）；0 = 不等待。 */
    intervalMs: number;
}
/** 发送间隔上限（毫秒），与 index.ts 中 zod 的 max 对齐。 */
export declare const SEGMENTS_INTERVAL_MAX_MS = 3000;
/** 把任意数值截断进 0–3000 毫秒窗口（使用侧 clamp；页面值由 zod 校验）。 */
export declare function clampSegmentsInterval(ms: number): number;
/**
 * 安装 qq_send_segments 的插件页开关（index.ts apply() 在任何 agent scope
 * 注册工具之前调用一次）。undefined = 恢复默认（启用、间隔 0）。
 */
export declare function configureSendSegments(config: SendSegmentsConfig | undefined): void;
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export declare function registerTools(ctx: Context, bridge: ChatBridge, connection: OneBotConnection, limits: {
    maxImageBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
}): () => void;
