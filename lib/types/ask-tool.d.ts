/**
 * Timed ask_user_question tool for the QQ channel (T2-B1): a self-contained
 * re-implementation of the host @deepseek-ai/dsh-tool-ask-user timed variant
 * (that package is not resolvable from this plugin's node_modules). Registered
 * per agent scope from installChannelScope, so only QQ sessions expose it; the
 * scoped registration shadows any global host registration. When a deployment
 * preset already mounted the host tool into the same scope, the duplicate
 * registration error is tolerated (debug log, no disposer).
 * @module dsh-onebot/ask-tool
 */
import type { Context } from '@deepseek-ai/cordis';
/** Default foreground wait (task板 T2-B1): 300s before the tool returns pending. */
export declare const ASK_USER_TIMEOUT_SECONDS = 300;
/** One question option as accepted from the model (schema case, snake_case). */
export interface AskQuestionOptionInput {
    label: string;
    description?: string;
}
/** One question as accepted from the model (schema case, snake_case). */
export interface AskQuestionInput {
    id: string;
    question: string;
    header?: string;
    options?: AskQuestionOptionInput[];
    multi_select?: boolean;
}
/** camelCase projection sent to the host userQuestions service. */
export interface AskQuestionRequest {
    id: string;
    question: string;
    header?: string;
    options?: AskQuestionOptionInput[];
    multiSelect?: boolean;
}
/** One per-question answer entry as returned/accepted by the host service. */
export interface AskUserAnswer {
    id: string;
    selected: string[];
    custom?: string;
}
/** The slice of the host userQuestions service the timed tool calls. */
export interface AskUserQuestionsPort {
    askTimed(request: {
        questions: AskQuestionRequest[];
        agent?: unknown;
        signal?: AbortSignal;
    }, callId: string, timeoutMs: number): Promise<{
        pending: true;
        callId: string;
    } | {
        answers: AskUserAnswer[];
    }>;
}
/** The slice of the host userQuestions service the inbound answer path calls (T2-B3). */
export interface UserQuestionAnswerPort {
    /** Resolves true when the batch was accepted into a continued-state question. */
    answer(agent: unknown, callId: string, payload: {
        answers: AskUserAnswer[];
    }): Promise<boolean>;
}
/** The full host userQuestions surface the bridge uses (B1 tool + B3 answer). */
export type UserQuestionsPort = AskUserQuestionsPort & UserQuestionAnswerPort;
/**
 * Resolve the host userQuestions service from a context without declaring it
 * in the plugin's inject list (dsh-base always registers it, but a missing
 * service must degrade to "no ask tool", never block plugin load).
 *
 * Goes through ctx.get: without inject, cordis throws on the property read from
 * any child fiber (the plugin itself, an agent scope) even though a sibling
 * plugin provides the service. Plain-object test fakes have no get.
 * @param ctx - cordis context (host or agent scope).
 * @returns the service, or undefined when unavailable.
 */
export declare function resolveUserQuestions(ctx: Context): UserQuestionsPort | undefined;
/** Validate a per-call timeout: positive integer up to the host bound.
 *
 * 有意偏离（deliberate deviation）：宿主 dsh-tool-ask-user 的 timed 变体接受
 * -1 表示无限前台等待；本复刻不接受——QQ 桥接的结算主路径依赖「前台等待
 * 超时 → 转 pending → 用户后续回复经 inbound 拦截由 answer() 结算」。若
 * 无限等待，问题将永停 open 态而无法从 QQ 侧结算，故非正数一律拒绝。
 *
 * 宿主升级同步点：本文件是宿主 dsh-tool-ask-user 协议的内联复刻（宿主包
 * 不可解析所致，见评审 R4）；升级宿主时须将本函数与宿主 timed ask 的
 * timeout 语义逐形状重对照，确认偏离仍成立或恢复宿主语义。
 */
export declare function validateTimeout(timeout: unknown): number;
/** Validate that question ids are unique within the call (host parity). */
export declare function validateQuestionIds(questions: readonly AskQuestionInput[]): void;
export interface AskUserToolOptions {
    /** Foreground wait seconds; defaults to ASK_USER_TIMEOUT_SECONDS. */
    timeoutSeconds?: number;
    /** Registration outcome logger (duplicate-mount tolerance is silent at info level). */
    log?: (level: 'debug' | 'info' | 'warn', message: string) => void;
}
/**
 * Register the timed ask_user_question tool on an agent-scope context.
 * @param ctx - the agent scope context (installChannelScope's argument).
 * @param options - timeout and logger.
 * @returns the tool disposer, or undefined when the host service is absent or
 *   the tool is already registered in this scope (e.g. preset-mounted).
 */
export declare function registerAskUserTool(ctx: Context, options?: AskUserToolOptions): (() => void) | undefined;
