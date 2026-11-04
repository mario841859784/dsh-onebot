/**
 * T1 (#27): notices 配置值 → 实际发送文案的统一解析。
 *
 * 语义定稿（issue #27，对五个键统一生效）：
 * - `false` = 不发；
 * - `true` / 缺省 = 默认文案（各发送点既有常量，0.9.x 行为不变）；
 * - 非空 `string` = 自定义文案；
 * - 空串 `""` = 不发。
 *
 * 纯函数、无依赖，便于单测与各发送点复用。
 * @module dsh-onebot/notices
 */
/** 单个 notice 键的取值：boolean 开关或自定义文案 string。 */
export type NoticeSetting = boolean | string;
/** notices 配置集合（bridge 的 BridgeConfig.notices 形状；全部可选）。 */
export interface NoticeTexts {
    /** steer 受理回执（自动回执 + /steer 命令确认）。 */
    steerAccepted?: NoticeSetting;
    /** 消息排队提示（每个运行回合至多一条）。 */
    queue?: NoticeSetting;
    /** 问题回答回执。 */
    answerAccepted?: NoticeSetting;
    /** 等待模型回复超时提示。 */
    deferredTimeout?: NoticeSetting;
    /** 消息太频繁频控提示（每窗口至多一条）。 */
    rateLimited?: NoticeSetting;
}
/** 把一个 notices 配置值解析为实际文案；返回 null 表示不发。
 * undefined/true → 默认文案；false/空串 → null；非空 string → 原样使用。 */
export declare function resolveNoticeText(value: NoticeSetting | undefined, defaultText: string): string | null;
