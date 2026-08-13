/**
 * Voice transcription: ffmpeg → 16 kHz mono WAV, then a whisper engine
 * (openai-whisper CLI, whisper.cpp whisper-cli, or a custom command) produces
 * the transcript. All subprocess work is queued, bounded by a timeout, and
 * contained: a transcription failure must never break the message pipeline
 * (the caller falls back to the [语音] placeholder).
 * @module dsh-onebot/stt
 */
/** STT configuration (subset of the plugin Config). */
export interface SttConfig {
    enabled: boolean;
    engine: 'auto' | 'openai' | 'whisper-cpp' | 'custom';
    /** Program path/name for the custom engine. */
    command: string;
    /** argv template for the custom engine; {file} and {out} are substituted. */
    args: string[];
    /** whisper model id (openai: small/base/medium...; whisper.cpp: ggml name). */
    model: string;
    /** Per-transcription timeout in ms. */
    timeoutMs: number;
}
/**
 * Voice transcription service. One instance per plugin; calls are serialized
 * through a queue so concurrent voice messages cannot stack CPU-bound
 * whisper processes.
 */
export declare class Transcriber {
    private readonly config;
    private queue;
    private ffmpegChecked;
    constructor(config: SttConfig);
    /** Whether transcription is enabled by config. */
    get enabled(): boolean;
    /**
     * Transcribe a voice file. The input is converted to 16 kHz mono WAV with
     * ffmpeg, then handed to the selected engine.
     * @param filePath - absolute path of the downloaded voice file.
     * @returns the transcript text (trimmed), or '' when the file is silent.
     * @throws when transcription is impossible (missing tools, timeout...).
     */
    transcribe(filePath: string): Promise<string>;
    private transcribeNow;
    private resolveEngine;
    private runEngine;
}
/** Convenience: transcription result for the bridge. */
export declare function transcriptLabel(text: string): string;
