/**
 * Guarded file editing for channel agents (borrowed approach from the IRMIA
 * DevKit's safe_edit — AstrBot plugin, AGPL-3.0; we reimplemented the concept
 * independently in TypeScript, no code copied). Flow per edit:
 *   root allowlist → read → backup → match → replace → syntax check → rollback.
 * Structure and error vocabulary mirror the plugin's tool conventions.
 * @module dsh-onebot/safe-edit
 */
/** Hard cap for guard-railed edits (source files; far below the LLM window). */
export declare const SAFE_EDIT_MAX_SIZE: number;
/** Detect and strip `NNNN│ ` / `NNNN: ` line-number prefixes a model may have
 * copied from read output; returns the stripped text (or original). */
export declare function stripLineNumberPrefixes(text: string): string;
/** Path guard: must live under the configured editable root. Returns an error
 * message, or null when the path is acceptable. */
export declare function checkPathAllowed(root: string, filepath: string): string | null;
/** Aider-style whitespace-tolerant retry: find the old block by stripped lines
 * and realign old/new indentation (preserving inner indentation via a delta). */
export declare function alignWhitespace(content: string, old: string, newText: string): {
    old: string;
    newText: string;
} | null;
/** Best-effort syntax check for JS-family files; others are skipped. */
export declare function syntaxCheckFile(filepath: string, runCheck?: (file: string) => Promise<string>): Promise<{
    ok: boolean;
    skipped: boolean;
    errors: unknown[];
}>;
/** Accepted edit modes. */
export type SafeEditMode = 'replace' | 'insert_at_line' | 'delete_lines';
export interface SafeEditRequest {
    filepath: string;
    old?: string;
    new?: string;
    occurrence?: number;
    replaceAll?: boolean;
    mode?: SafeEditMode;
    line?: number;
    startLine?: number;
    endLine?: number;
}
export interface SafeEditOptions {
    root: string;
    backupDir: string;
    syntaxCheck?: (file: string) => Promise<{
        ok: boolean;
        skipped: boolean;
        errors: unknown[];
    }>;
}
export interface SafeEditOutcome {
    ok: boolean;
    file?: string;
    error?: string;
    proposal?: string;
    evidence?: unknown;
    options?: unknown;
    backup?: string;
    backupDeleted?: boolean;
    rolledBack?: boolean;
    matches?: unknown;
    occurrenceCount?: number;
    syntaxOk?: boolean | null;
    lineNumbersStripped?: boolean;
    whitespaceAligned?: boolean;
}
/**
 * One guarded edit: validate path, backup, match (exact → line-number-prefix
 * strip → whitespace-align), replace, syntax-check, auto-rollback on failure.
 */
export declare function safeEdit(request: SafeEditRequest, options: SafeEditOptions): Promise<SafeEditOutcome>;
/** Restore a file from a backup; the pre-restore state is itself backed up. */
export declare function safeRollback(filepath: string, backupDir: string, root: string, backupName?: string): Promise<{
    ok: boolean;
    error?: string;
    file?: string;
    restoredFrom?: string;
    currentStateBackup?: string;
}>;
/** List backups for a file (all when filepath omitted). */
export declare function listBackups(backupDir: string, filepath?: string): Promise<{
    ok: boolean;
    backups: Array<{
        name: string;
        size: number;
        time: string;
    }>;
    total: number;
}>;
