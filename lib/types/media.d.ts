/**
 * Media handling: inbound download/resolution (url / base64:// / file:// /
 * hash via get_image), 6h temp-file cleanup, and outbound base64 encoding.
 * Ported from the Hermes OneBotAdapter media half.
 * @module dsh-onebot/media
 */
/** Size limits (bytes), matching the Hermes adapter's constants. */
export declare const IMAGE_MAX_BYTES: number;
export declare const VOICE_MAX_BYTES: number;
export declare const MEDIA_MAX_BYTES: number;
/** One resolved media file. */
export interface ResolvedMedia {
    /** Absolute local path. */
    path: string;
    /** Mime-ish kind for the caller. */
    kind: 'image' | 'voice' | 'video' | 'file';
}
/**
 * Media storage: a scratch directory under the plugin's media root.
 * Downloads land here with a TTL; cleanup runs on each inbound message.
 */
export declare class MediaStore {
    readonly dir: string;
    private readonly ttlHours;
    private readonly imageMaxSize;
    /**
     * @param dir - absolute scratch directory (created on demand).
     * @param ttlHours - files older than this are deleted on cleanup.
     * @param imageMaxSize - inbound-image long-edge cap in px; images larger
     *   than this are downscaled right after download (`<=0` disables).
     */
    constructor(dir: string, ttlHours: number, imageMaxSize?: number);
    /** Ensure the scratch directory exists. */
    ensure(): Promise<void>;
    /** A fresh scratch file path with the given extension. */
    freshPath(ext: string): string;
    /**
     * Delete scratch files older than the TTL. Called on every inbound message;
     * failures are logged and contained.
     */
    cleanupExpired(): Promise<void>;
    /**
     * Resolve one media reference (from cq.ts MediaRef) to a local file.
     * @param ref - the media reference.
     * @param resolveHash - callback for hash-only refs (calls get_image etc.);
     *   returns { url, file } or undefined when unresolvable.
     * @returns the resolved file, or undefined when the ref cannot be fetched.
     */
    resolve(ref: {
        kind: 'image' | 'voice' | 'video' | 'file';
        url?: string;
        file?: string;
    }, resolveHash: (kind: 'image' | 'voice' | 'video' | 'file', file: string) => Promise<{
        url?: string;
        file?: string;
    } | undefined>): Promise<ResolvedMedia | undefined>;
    private resolveInner;
    /**
     * Download a URL into the scratch dir.
     * @param url - remote URL.
     * @param ext - file extension for the target.
     * @param maxBytes - optional size cap (download aborted beyond it).
     * @returns the local path.
     */
    downloadUrl(url: string, ext: string, maxBytes?: number): Promise<string>;
}
/** Guess a file extension for a URL. */
export declare function extForUrl(url: string, kind: 'image' | 'voice' | 'video' | 'file'): string;
/** Default extension per media kind. */
export declare function extForKind(kind: 'image' | 'voice' | 'video' | 'file'): string;
/**
 * Read a local file as a base64 data URI for OneBot media segments.
 * @param path - absolute file path.
 * @param maxBytes - size cap; exceeding it throws.
 * @returns "base64://<data>".
 */
export declare function fileToBase64(path: string, maxBytes: number): Promise<string>;
/** Whether a string looks like a remote URL. */
export declare function isUrl(value: string): boolean;
