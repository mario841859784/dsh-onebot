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
/** 把一个 notices 配置值解析为实际文案；返回 null 表示不发。
 * undefined/true → 默认文案；false/空串 → null；非空 string → 原样使用。 */
export function resolveNoticeText(value, defaultText) {
    if (value === undefined || value === true)
        return defaultText;
    if (value === false)
        return null;
    return value === '' ? null : value;
}
