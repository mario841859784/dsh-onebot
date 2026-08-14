/**
 * The chat↔agent bridge: one Agent per QQ chat, inbound message pipeline
 * (policy → parse → media → STT → quote/forward expansion → followup),
 * outbound delivery driven by session events (assistant/message, turn/end),
 * typing indicator, per-chat send ordering, and chat→session mapping
 * persistence for restart resume. Ported from the Hermes OneBotAdapter
 * gateway-interaction half onto the dsh headless-runner agent pattern.
 * @module dsh-onebot/bridge
 */
import type { AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { SessionStore } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { OneBotConnection, OneBotEvent } from './connection.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import type { MediaStore } from './media.js';
import type { Transcriber } from './stt.js';
import type { ChatId } from './chat.js';
import type { AccessPolicyConfig } from './chat.js';
/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
    type: string;
    data: Record<string, unknown>;
}
/** Options for an explicit outbound send (from tools). */
export interface SendOptions {
    replyTo?: string;
}
/** Resolved runtime configuration for the bridge. */
export interface BridgeConfig {
    botQQ: string;
    ignoreSelf: boolean;
    splitLength: number;
    requireMention: boolean;
    interimMessages: boolean;
    sendErrorNotice: boolean;
    restrictedMemberPrefix: boolean;
    sensitivePatterns: readonly string[];
    mediaDir: string;
    maxImageBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    textImageThreshold: number;
    cardFooter: string;
    fontFiles: readonly string[];
    fontFamilies: readonly string[];
    agentPreset: string;
    workspacePath: string;
}
/** Agent-preset service (dsh-agent-presets): joins agents to a preset composition. */
export interface AgentPresetsLike {
    mount(agentCtx: unknown, id?: string): Promise<{
        id: string;
    }>;
}
/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceRegistryLike {
    resolveByPath(path: string): Promise<{
        attachSession(sessionId: string): Promise<void>;
    } | undefined>;
    create(path: string, title?: string): Promise<{
        attachSession(sessionId: string): Promise<void>;
    }>;
}
/** Services the bridge needs (subset of the plugin Context). */
export interface BridgeDeps {
    ctx: Context;
    connection: OneBotConnection;
    media: MediaStore;
    transcriber: Transcriber;
    agents: AgentRegistry;
    sessions: SessionStore;
    agentPresets: AgentPresetsLike;
    workspaceRegistry: WorkspaceRegistryLike;
    defaultModel: (() => ModelSelection | undefined) | undefined;
    config: BridgeConfig;
    policy: AccessPolicyConfig;
    /** Log line callback (level, message). */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}
/**
 * Bridge between OneBot events and dsh agents. Create via the constructor and
 * call start() from the plugin's effect; call stop() on disposal.
 */
export declare class ChatBridge {
    private readonly deps;
    private readonly chats;
    private readonly bySession;
    private stopping;
    private mappingSaveTimer;
    /** Resolves once the on-disk chat mapping has been loaded. */
    private mappingLoaded;
    /** Session ids whose persisted logs are unusable; creates must avoid them. */
    private readonly brokenSessions;
    constructor(deps: BridgeDeps);
    /** Start listening: wire connection handlers and the session event feed. */
    start(): void;
    /** Stop everything: dispose agents, save mapping, cancel timers. */
    stop(): Promise<void>;
    /** Map an agent session id back to its chat (for model tools). */
    chatForSession(sessionId: string): ChatId | undefined;
    /** Whether the connection is usable for sends. */
    get connected(): boolean;
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
    /**
     * Send raw OneBot segments (used by the media tools).
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined>;
    /**
     * Wait for the loader's complete application (model selection, settings,
     * persistence) before reading the default model — the same gate the
     * headless runner uses, so the pinned selection is never a half-loaded
     * default.
     */
    private ready;
    /**
     * Inbound OneBot message event → agent turn. All policy and media work is
     * contained: a failure here logs and drops the message, never the host.
     */
    handleInbound(event: OneBotEvent): Promise<void>;
    private processInbound;
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    private buildBody;
    /** Resolve one media ref to a text annotation with a local path. */
    private resolveMediaRef;
    /** Expand a quoted (reply) message into [引用] text via get_msg. */
    private expandQuote;
    /** Expand a combined-forward id into "name: content" lines. */
    private expandForward;
    /** Serialize work on one chat's send chain. */
    private enqueue;
    /** Send one message to a chat and return its message id. */
    private sendMsg;
    /** Send [[qq_forward]] nodes as a merged-forward message. */
    sendForward(chatId: ChatId, nodes: Array<{
        name: string;
        content: string;
    }>): Promise<void>;
    private onSessionEvent;
    private onSessionFlush;
    /** Get (or create) the agent for a chat. */
    private ensureChat;
    /** Resume persisted chats from the mapping file (best-effort). */
    private loadMapping;
    private mappingPath;
    private saveMapping;
    private saveMappingDebounced;
    /**
     * Recover from a session-log collision: the live session cannot append to
     * the mismatched on-disk log, so dispose the agent and rebuild the chat on
     * a fresh session id. The user is asked to resend.
     */
    private healSessionCollision;
    /**
     * Effective workspace directory for QQ chat sessions: the configured
     * workspacePath, falling back to the host process cwd.
     */
    private effectiveCwd;
    /**
     * Join the QQ agent to the configured agent preset (the deployment default
     * when unset) so its tools/prompt sections/skill catalog resolve against the
     * preset composition instead of the empty global layer. Best-effort: a
     * broken preset falls back to the previous behavior rather than failing the
     * chat.
     */
    private joinPreset;
    /**
     * Attach a chat session to the workspace owning its header cwd (creating the
     * workspace when the directory is unowned), so QQ sessions group under a
     * workspace in the GUI instead of "Ungrouped". Best-effort: failure only
     * logs.
     */
    private attachToWorkspace;
    /** Start the NapCat typing indicator (private chats only). */
    private startTyping;
    /** Stop the typing indicator. */
    private stopTyping;
}
/** Convenience for tools: file → base64 segment with the plugin's caps. */
export declare function imageSegment(path: string, maxBytes: number): Promise<OutboundSegment>;
export { OneBotNotConnectedError, OneBotActionError };
