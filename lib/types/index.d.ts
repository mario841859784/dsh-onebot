/**
 * dsh-onebot: a QQ (OneBot 11 / NapCat) chat channel for DeepSeek Harness.
 *
 * Mounts inside the dsh host process: a reverse- or forward-WebSocket link to
 * NapCat, one Agent per QQ chat, inbound images/voice handled for the model
 * (whisper STT when enabled), outbound replies split at sentence boundaries,
 * [[qq_forward]] merged forwards, allowlist/mention access control, and a set
 * of qq_* tools for media and NapCat APIs.
 * @module dsh-onebot
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import type ToolRuntime from '@deepseek-ai/dsh-tools';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type Z from '@deepseek-ai/schemastery';
import type { OneBotEvent } from './connection.js';
type Context = CordisContext & {
    tools: ToolRuntime;
    systemPrompt: SystemPrompt;
    agents: AgentRegistry;
    sessions: SessionStore;
    agentDefaultModel: {
        currentSelection(): ModelSelection | undefined;
        saveSelection(next: ModelSelection): Promise<void>;
    };
    agentPresets: {
        readonly defaultId: string;
        resolve(id?: string): Promise<{
            id: string;
        }>;
        mount(agentCtx: unknown, id?: string): Promise<{
            id: string;
        }>;
    };
    sessionPersistence: {
        /** dsh-session-persistence 0.1.6 `stat`: the stored snapshot, or
         * undefined when the id owns no durable log (the retired `inspect`
         * convenience no longer exists on the host service). */
        stat(id: string): Promise<object | undefined>;
        /** /session list previews: open a stored session read-only (never takes
         * write ownership), read the header + a small event prefix, then close. */
        open(id: string, access: 'read'): Promise<{
            header: {
                createdAt?: number;
                agentPreset?: string;
            };
            read(offset?: number, length?: number): Promise<{
                events: readonly {
                    type?: string;
                    data?: {
                        agentPreset?: string;
                        source?: {
                            kind?: string;
                        };
                        content?: readonly {
                            type?: string;
                            text?: string;
                        }[];
                    };
                }[];
            }>;
            close(): Promise<void>;
        }>;
    };
    workspaceRegistry: {
        resolveByPath(path: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        } | undefined>;
        create(path: string, title?: string): Promise<{
            id: string;
            path: string;
            sessionIds: readonly string[];
            attachSession(sessionId: string): Promise<void>;
        }>;
        list(): Array<{
            id: string;
            path: string;
            sessionIds: readonly string[];
        }>;
    };
    commands: {
        execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{
            kind?: string;
            text?: string;
            result?: {
                kind?: string;
                text?: string;
            };
        }>;
    };
};
export declare const name = "dsh-onebot";
export declare const inject: string[];
/** Plugin configuration (validated by schemastery). */
export interface Config {
    mode: 'reverse' | 'forward';
    host: string;
    port: number;
    url: string;
    accessToken: string;
    /** Forward-mode reconnect attempt limit; 0 = retry forever. */
    reconnectMaxAttempts: number;
    botQQ: string;
    requireMention: boolean;
    /** Unknown slash-command handling: intercept（默认）=拦截并给建议；passthrough=透传给模型。 */
    unknownCommand: 'intercept' | 'passthrough';
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    adminUsers: string[];
    allowAllUsers: boolean;
    ignoreSelf: boolean;
    interimMessages: boolean;
    /** Per-interim auto-recall delay (ms) from each interim's send completion. */
    interimRecallMs: number;
    /** M3-D2b: interim recall degrade switch (false = send-only interims). */
    interimRecall: boolean;
    sendErrorNotice: boolean;
    /** Per-chat per-minute sliding-window cap for normal (non-command) messages; 0 disables. */
    rateLimitPerMinute: number;
    restrictedMemberPrefix: boolean;
    sensitivePatterns: string[];
    mediaDir: string;
    tempTtlHours: number;
    outboundImageMaxBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    inboundImageMaxPx: number;
    /** @deprecated D4a alias of inboundImageMaxPx; honored for one release. */
    imageMaxSize?: number;
    /** @deprecated D4a alias of outboundImageMaxBytes; honored for one release. */
    maxImageBytes?: number;
    sttEnabled: boolean;
    sttEngine: 'auto' | 'openai' | 'whisper-cpp' | 'custom';
    sttCommand: string;
    sttArgs: string[];
    sttModel: string;
    sttTimeoutMs: number;
    textImageThreshold: number;
    cardFooter: string;
    fontFiles: string[];
    fontFamilies: string[];
    agentPreset: string;
    workspacePath: string;
    inboundFileMaxBytes: number;
    /** @deprecated D4a alias of inboundFileMaxBytes; honored for one release. */
    maxInboundFileBytes?: number;
    /** B8c: chats idle longer than this many days are evicted (0 disables). */
    chatIdleEvictDays: number;
    /** Escape hatch: skip the download private-address check (local reverse proxy). */
    allowPrivateHosts: boolean;
    /** W2-②: inbound (chatId, message_id) dedup window in seconds; 0 disables. */
    dedupWindowSeconds: number;
    /** W2-③: bridge-wide proactive-write (qq_send_* tools) cap per minute; 0 disables. */
    actionRatePerMinute: number;
    /** W2-③: bridge-wide proactive-write cap per calendar day; 0 disables. */
    actionRatePerDay: number;
    /** W2-③: proactive-write audit jsonl (mediaDir/qq-actions.log). */
    actionAuditEnabled: boolean;
    /** W1: decision-trace jsonl (mediaDir/qq-trace.jsonl); default off — zero
     * file, zero behavior difference vs 0.6.0. */
    traceEnabled: boolean;
    /** W1: trace level; 'warn' records only ok:false (rejected/failed/dropped) events. */
    traceLevel: 'debug' | 'warn';
    /** W1/T5: record every inbound event into mediaDir/qq-inbox.jsonl (default off). */
    recordInbound: boolean;
    /** W1/T5: mask 6+ digit runs (QQ/group numbers) in the recording (default off). */
    inboxRedact: boolean;
    /** W1/T5 (DEBUG-ONLY): enable the qq-inject.jsonl injection channel (default off). */
    injectEnabled: boolean;
    /** W1/T5: intercept all outbound writes of injected rounds (default true). */
    injectDryRun: boolean;
    /** W1/T5: inject queue poll interval in ms (min 500). */
    injectIntervalMs: number;
}
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export declare function defaultMediaDir(): string;
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export declare function dshHome(): string;
export declare const Config: Z<Config>;
/** Map deprecated config names onto their renamed fields: a legacy value is
 * honored only while the new name still sits at its schema default (the new
 * name wins when both are configured), each legacy use warns once, and the
 * legacy keys never leak into the effective config. */
export declare function resolveDeprecatedConfig(config: Config): Config;
/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export declare function logMetaEvent(selfId: string, event: OneBotEvent): void;
/** Mount the plugin. */
export declare function apply(ctx: Context, config: Config): void;
export {};
