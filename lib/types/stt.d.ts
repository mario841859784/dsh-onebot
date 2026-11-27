/**
 * Voice transcription: SILK v3 (magic-number detected) or ffmpeg → WAV, then
 * a whisper engine (openai-whisper CLI, whisper.cpp whisper-cli, or a custom
 * command) produces the transcript. All subprocess work is queued, bounded by
 * a timeout, and
 * contained: a transcription failure must never break the message pipeline
 * (the caller falls back to the [语音] placeholder).
 * @module dsh-onebot/stt
 */
/** STT configuration (subset of the plugin Config). */
export interface SttConfig {
    enabled: boolean;
    engine: 'auto' | 'openai' | 'whisper-cpp' | 'custom' | 'dsh';
    /** Program path/name for the custom engine. */
    command: string;
    /** argv template for the custom engine; {file} and {out} are substituted. */
    args: string[];
    /** whisper model id (openai: small/base/medium...; whisper.cpp: ggml name). */
    model: string;
    /** Per-transcription timeout in ms. */
    timeoutMs: number;
    /**
     * DSH 原生引擎专用：按名容错读取宿主 `speechToText` 服务（实验性语音转写
     * 插件提供）。每次调用实时读取，服务未启用/未注册时返回 undefined——
     * 不加入 cordis inject 列表（inject 是硬依赖，该服务是可选实验服务）。
     */
    getSpeechToText?: () => SpeechToTextLike | undefined;
}
/**
 * 宿主实验性语音转写服务（cordis 服务名 `speechToText`）的最小结构类型：
 * 只声明本插件用到的成员，字段/返回值用最小结构类型描述，刻意 **不 import
 * 宿主包**（`@deepseek-ai/dsh-experimental-speech-to-text`），避免把可选
 * 实验服务变成编译期硬依赖。
 */
export interface SpeechToTextLike {
    resolve(request: {
        readonly audio: Uint8Array;
        readonly providerId?: string;
        readonly language?: string;
    }): unknown;
    transcribe(spec: unknown, signal: AbortSignal): Promise<{
        readonly text: string;
    }>;
    listProviders(): readonly unknown[];
    snapshot(): {
        readonly providers: readonly {
            readonly id: string;
            readonly preparation?: {
                readonly phase: string;
            };
        }[];
        readonly selection: {
            readonly providerId: string;
            readonly language: string;
        };
    };
    prepare(providerId?: string): unknown;
}
/**
 * 判断文件头是不是 SILK v3。
 *
 * QQ 语音落地时扩展名常被写成 `.mp3`，内容其实是协议端 `get_record`
 * 兜底返回的原始 SILK——ffmpeg 按 mp3 解必然失败（表现为一直只有
 * `[语音]`）。协议端有的会把帧类型字节一起落盘，所以头部允许
 * 0x02 / 0x03 前缀。
 * @param head - 文件前若干字节（>= 10 字节即可）。
 */
export declare function isSilkData(head: Uint8Array): boolean;
/** 把 16-bit 单声道 PCM 包成最小 WAV（44 字节头），引擎侧都认这个。 */
export declare function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Buffer;
/**
 * SILK → 16 kHz 单声道 WAV 之外的「引擎输入」准备。
 *
 * 命中 SILK 魔数时用 `silk-wasm`（纯 wasm，无 native 依赖）解码成 PCM，
 * 再包成 WAV 交给引擎；解码失败就返回 false，让调用方回落到原来的
 * ffmpeg 路径——宁可多试一次，也不要因为解码器不认识某种 SILK 变体
 * 就把整条语音丢掉。
 * @returns true 表示 `outPath` 已写好可用的 WAV。
 */
export declare function writeSilkWav(bytes: Uint8Array, outPath: string): Promise<boolean>;
/**
 * Detect a command on PATH by scanning each dir for an executable match
 * (A8: no shell involved, so the configured name is never shell-interpreted;
 * builtins/aliases stop being visible — callers only need real binaries).
 */
export declare function findCommand(name: string): Promise<string | undefined>;
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
     * Transcribe a voice file. SILK v3 input is decoded to PCM/WAV directly;
     * everything else is converted to 16 kHz mono WAV with ffmpeg; the WAV is
     * then handed to the selected engine.
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
