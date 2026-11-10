/** T6 分帧的资源上限：分帧是加分项，超限一律拒绝——不能拿一台设备换一张动图。 */
export declare const MAX_FILE_BYTES: number;
export declare const MAX_DIMENSION = 1024;
export declare const MAX_FRAMES = 150;
/** Decode the GIF and lay `count` evenly-picked composited frames onto one
 * vertical sheet PNG. Throws on any failure (oversize, undecodable, missing
 * optional dependency) — gifFramesNote is the silent wrapper. */
export declare function gifSheet(input: string, output: string, count?: number): Promise<{
    frames: number;
    picked: number;
    width: number;
    height: number;
    output: string;
}>;
/**
 * 本地加（T6，移植自贡献者 inbound.js gifFramesNote）：收到 gif 就在旁边拼一张
 * 四格分帧图（连拍那样）。默认（gifFramesEnabled=false）完全不动作——不装
 * optionalDependencies 也不开开关时行为与上游逐字节等价；开启后拼不出来
 * （依赖缺失/文件异常/超限）一律静默返回空串，绝不报错、绝不挡住消息。
 *
 * @param path 已落地的媒体文件路径（仅处理 .gif）。
 * @param enabled gifFramesEnabled 配置。
 * @param sheet 分帧实现（测试注入点；生产用 gifSheet）。
 */
export declare function gifFramesNote(path: string, enabled: boolean, sheet?: (input: string, output: string, count?: number) => Promise<unknown>): Promise<string>;
