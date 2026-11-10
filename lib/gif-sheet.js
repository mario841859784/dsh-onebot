/**
 * T6（PR port GIF 分帧，可选模块）：把 GIF 抽帧拼成一张纵向长图，让只看得到
 * 静帧的模型看明白动图发生了什么。移植自贡献者 gif-sheet.mjs，改动：
 *  - 依赖解析改为 createRequire(import.meta.url) 相对解析（与上游
 *    @napi-rs/canvas 的装载方式同模式）——删除贡献者版本的硬编码 Android
 *    路径兜底与环境变量覆盖；
 *  - gifuct-js 走 optionalDependencies（不进 dependencies）：未安装时加载
 *    失败，gifFramesNote 静默返回空串，绝不挡住消息本身；
 *  - 资源上限在加载解码器之前先行校验（大文件/大尺寸/多帧不再先装载依赖）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/**
 * Load an optional dependency relative to this module's own install tree.
 * Fails when the package is not installed (optionalDependencies may be
 * skipped with --omit=optional) — callers degrade silently.
 */
function loadModule(name) {
    return require(name);
}
/** T6 分帧的资源上限：分帧是加分项，超限一律拒绝——不能拿一台设备换一张动图。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_DIMENSION = 1024;
export const MAX_FRAMES = 150;
/** Decode the GIF and lay `count` evenly-picked composited frames onto one
 * vertical sheet PNG. Throws on any failure (oversize, undecodable, missing
 * optional dependency) — gifFramesNote is the silent wrapper. */
export async function gifSheet(input, output, count = 6) {
    // 资源上限先于依赖加载：超限直接拒绝，不白装一次解码器。
    const raw = readFileSync(input);
    if (raw.length > MAX_FILE_BYTES)
        throw new Error('动图 ' + Math.round(raw.length / 1048576) + 'MB，超过分帧上限');
    const gifuct = loadModule('gifuct-js');
    const canvasMod = loadModule('@napi-rs/canvas');
    const gif = gifuct.parseGIF(raw);
    const width = gif.lsd.width;
    const height = gif.lsd.height;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION)
        throw new Error('动图 ' + width + 'x' + height + '，超过分帧尺寸上限');
    if (Array.isArray(gif.frames) && gif.frames.length > MAX_FRAMES)
        throw new Error('动图 ' + gif.frames.length + ' 帧，超过分帧上限');
    const frames = gifuct.decompressFrames(gif, true);
    if (frames.length === 0)
        throw new Error('没有可解的画面');
    // 只留真正要用的那 n 张快照（每帧都存的话，帧多的动图内存是 n 倍）。
    const n = Math.max(1, Math.min(count, frames.length));
    const wanted = new Map();
    for (let i = 0; i < n; i++) {
        const at = Math.min(frames.length - 1, Math.floor(((i + 0.5) * frames.length) / n));
        wanted.set(at, i);
    }
    const slots = new Array(n);
    // 要凑出正确的画面，必须按顺序把前面的帧都叠一遍，并且遵守每帧的清除规则
    // （disposal 2 = 把这一帧占的矩形清掉，3 = 退回上一帧）。只画自己那块会花。
    const cell = canvasMod.createCanvas(width, height);
    const ctx = cell.getContext('2d');
    let previous = null;
    frames.forEach((frame, index) => {
        if (previous !== null) {
            const type = previous.disposalType;
            if (type === 2) {
                ctx.clearRect(previous.dims.left, previous.dims.top, previous.dims.width, previous.dims.height);
            }
            else if (type === 3 && previous.saved !== undefined) {
                ctx.putImageData(previous.saved, 0, 0);
            }
        }
        // 帧补丁先画到一张小画布再 drawImage 叠上去：putImageData 会连透明像素
        // 一起硬写，把底下已经画好的画面戳出黑洞。
        const patch = canvasMod.createCanvas(frame.dims.width, frame.dims.height);
        const pctx = patch.getContext('2d');
        const image = pctx.createImageData(frame.dims.width, frame.dims.height);
        image.data.set(frame.patch);
        pctx.putImageData(image, 0, 0);
        ctx.drawImage(patch, 0, 0, frame.dims.width, frame.dims.height, frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
        const slot = wanted.get(index);
        if (slot !== undefined)
            slots[slot] = ctx.getImageData(0, 0, width, height);
        if (frame.disposalType === 3)
            frame.saved = ctx.getImageData(0, 0, width, height);
        previous = frame;
    });
    const sheet = canvasMod.createCanvas(width, height * n);
    const sctx = sheet.getContext('2d');
    sctx.fillStyle = '#101010';
    sctx.fillRect(0, 0, sheet.width, sheet.height);
    for (let i = 0; i < n; i++) {
        if (slots[i] !== undefined)
            sctx.putImageData(slots[i], 0, i * height);
    }
    writeFileSync(output, sheet.toBuffer('image/png'));
    return { frames: frames.length, picked: n, width, height, output };
}
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
export async function gifFramesNote(path, enabled, sheet = gifSheet) {
    if (!enabled || typeof path !== 'string' || !/\.gif$/i.test(path))
        return '';
    try {
        const out = path.replace(/\.gif$/i, '') + '-frames.png';
        await sheet(path, out, 4);
        return '\n[动图分帧:' + out + ']';
    }
    catch {
        return '';
    }
}
// 只有自己被当成命令行跑的时候才处理参数。宿主 import 这个模块时 process.argv
// 是宿主自己的（例如 ["node","dsh","web"]），不做判断就会拿 "web" 当文件名去
// 打开，直接把插件 import 搞崩（贡献者 11.1 踩过的坑）。
const invokedDirectly = typeof process.argv[1] === 'string'
    && /gif-sheet\.(m?js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
    const [input, output, count] = process.argv.slice(2);
    if (input !== undefined) {
        const result = await gifSheet(input, output ?? input.replace(/\.gif$/i, '') + '-sheet.png', Number(count ?? 6) || 6);
        console.log('抽了 ' + result.frames + ' 帧，取了 ' + result.picked + ' 张，尺寸 ' + result.width + 'x' + result.height);
        console.log(result.output);
    }
}
