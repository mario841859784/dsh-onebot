/**
 * Slash-command surface (M2-D1-PR1): the routed command table, the narrow
 * CommandContext through which handlers touch the bridge, and the router.
 * Extracted verbatim from bridge.ts — reply texts, argument parsing and
 * error behavior are byte-identical to the pre-split if-chain; /help is now
 * generated from the table (snapshot-gated in tests/commands.spec.ts).
 * @module dsh-onebot/commands
 */
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { OneBotConnection } from './connection.js';
import type { MediaRef } from './cq.js';
import type { ChatId, UserRole } from './chat.js';
import type { AgentDefaultModelLike, AgentPresetsLike, BridgeConfig, BridgeDeps, LlmCatalogPort, WorkspaceRegistryLike } from './bridge.js';
/** Narrow view of a live chat the command handlers may read or mutate —
 * the structural subset of the bridge's internal ChatAgent that the
 * pre-split handlers actually touched. */
export interface CommandChatView {
    agent: Agent;
    sessionId: SessionId;
    busy: boolean;
    lastFollowup: string | undefined;
    lastNickname: string;
    loopPending: string | null;
    loopBuffer: Array<{
        id: string;
        text: string;
        sentAt: number;
    }>;
    selectionRef: ModelSelectionRef | undefined;
}
/** The bridge capabilities the command surface may touch. Deliberately
 * narrower than BridgeDeps: handlers get the outbound send path, the
 * per-chat state they already owned pre-split, and the few services they
 * call — never the agent registry, media store, or the policy allowlists
 * (the admin gate is answered by `isAdmin`, not by exposing `policy`). */
export interface CommandContext {
    /** Full outbound pipeline send (the commands' only reply path). */
    sendToChat(chatId: ChatId, text: string): Promise<string[]>;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** Router entry gate: the admin check against the policy allowlist. */
    isAdmin(userId: string): boolean;
    /** Live chat lookup / existence probe. */
    getChat(chatId: ChatId): CommandChatView | undefined;
    hasChat(chatId: ChatId): boolean;
    /** Registry capabilities the commands legitimately trigger. */
    resetChat(chatId: ChatId): Promise<void>;
    dispatchFollowup(chatId: ChatId, text: string, role: UserRole, nickname?: string): Promise<void>;
    /** Per-chat state readers/writers (the pre-split private maps). */
    effectiveCwd(chatId: ChatId): string;
    sessionIdFromMapping(chatId: ChatId): Promise<string | undefined>;
    resolvePresetId(chatId: ChatId): Promise<string | undefined>;
    setChatWorkspacePath(chatId: ChatId, path: string): void;
    presetOverride(chatId: ChatId): string | undefined;
    setPresetOverride(chatId: ChatId, id: string): void;
    hasPresetOverride(chatId: ChatId): boolean;
    interimOverride(chatId: ChatId): boolean | undefined;
    setInterimOverride(chatId: ChatId, value: boolean): void;
    goal(chatId: ChatId): string | undefined;
    setGoal(chatId: ChatId, value: string): void;
    deleteGoal(chatId: ChatId): void;
    lastImagePath(chatId: ChatId): string | undefined;
    lastImagePath(chatId: ChatId): string | undefined;
    /** Lazy media resolution for the /ocr pending image ref (C6a). */
    resolveMediaRef(ref: MediaRef, chatId: ChatId): Promise<string>;
    /** Consume the pending pre-routing image ref (get + delete, /ocr only). */
    takePendingImageRef(chatId: ChatId): MediaRef | undefined;
    /** Services (narrow slices of the bridge deps). */
    /** Live model catalog for /model (M2-C5b port; index.ts wires it over the
     * live llm service — commands never touch Context). */
    llmCatalog: LlmCatalogPort | undefined;
    workspaceRegistry: WorkspaceRegistryLike | undefined;
    agentDefaultModel: AgentDefaultModelLike | undefined;
    agentPresets: AgentPresetsLike | undefined;
    commands: BridgeDeps['commands'];
    connection: OneBotConnection;
    dshHome: string | undefined;
    /** The only config fields the commands read. */
    config: Pick<BridgeConfig, 'interimMessages' | 'maxImageBytes'>;
}
/** One routed slash command: the table row IS the registration (D1-PR1) —
 * adding a command is exactly one row here and /help picks it up for free. */
export interface CommandDefinition {
    /** Command word after the leading slash (matched case-insensitively). */
    name: string;
    /** Admin-only flag; every current command is gated at the router entry. */
    adminOnly: boolean;
    /** /help description shown after "/name " (exact pre-split wording). */
    help: string;
    handler(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
}
/** The routed command table. Row order = /help output order (the router
 * matches by name, so ordering is routing-neutral). */
export declare const COMMANDS: CommandDefinition[];
/**
 * Slash-command router. Commands are admin-only (the Hermes member
 * slash-command block) and are matched on the first word; a leading
 * @mention glued to the command (QQ group at + text) is stripped first.
 * A path like /tmp/x is never a command (command words are
 * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands return false so the
 * message reaches the model, matching the Hermes "fall through" behavior.
 * @param ctx - bridge capabilities (built by ChatBridge).
 * @param chatId - the chat the command arrived in.
 * @param text - parsed inbound text.
 * @param userId - sender QQ number.
 * @returns true when the message was consumed by a command.
 */
export declare function tryHandleCommand(ctx: CommandContext, chatId: ChatId, text: string, userId: string): Promise<boolean>;
