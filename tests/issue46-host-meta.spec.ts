/**
 * Issue #46 回归：私聊回复不得夹带宿主内部元信息。
 *
 * 症状：QQ 用户看到的机器人回复里混入宿主内部标记，三类特征是既有
 * stripBoundaryLeakage（T9/#26 只认 user_message 标签）未覆盖的：
 * ① 独立成行/行首行尾紧邻的宿主角色标签 <user> 与 </user>（模型把消息
 *   角色边界回声了，常与 <user_message> 包裹一起出现）；
 * ② 整行以 `Time sampled while preparing turn` 开头的宿主时间采样行；
 * ③ 整行以 `Browser time zone for this request:` / `Elapsed since the
 *   preceding model-visible message:` 开头的宿主上下文行。
 *
 * 清洗哲学与 T9 一致：只识别固定前缀/受限形态、行级精确匹配；普通正文
 * 里的 `<`、XML、比较符号、行中提及这些前缀的文字不得误伤。
 * （已知取舍：与既有 user_message 处理相同，不感知代码块——独立成行的
 * `<user>` 即使在代码块里也会被删，既有测试风格即如此。）
 *
 * 0.10.x 补充（issue #46 最新评论 zwxlkss）：三类宿主元信息标签同样原样
 * 泄漏到 QQ——④ skill_content 成对块；⑤ system-reminder / system_reminder
 * 成对块（两种拼写都会出现，可嵌套、可混用）；⑥ </input> 收尾标签。清洗
 * 策略是两段式：先整块丢弃成对宿主块（循环 replace 至不动点），再剥残留
 * 散标签；</input> 只剥收尾形态，开标签与正文讨论 HTML 的场景不碰。
 * @module dsh-onebot/tests/issue46-host-meta
 */
import { describe, expect, it } from 'vitest'

import { stripBoundaryLeakage } from '../src/outbound.js'

describe('#46: 宿主角色标签 <user> / </user> 清洗', () => {
  it('独立成行的标签整行删除；与尾部 <user_message> 回显叠加时全部清干净', () => {
    const echo = '好的，我查一下。\n<user>\n<user_message qq="10001" nickname="小明">\n帮我看下今天天气\n</user_message>\n</user>'
    expect(stripBoundaryLeakage(echo)).toBe('好的，我查一下。')
    expect(stripBoundaryLeakage('回复\n<user>\n</user>')).toBe('回复')
  })

  it('行首/行尾紧邻的标签只删标签、保留同行内容', () => {
    // 行首紧邻 <user_message>（issue 报告的开头形态）
    expect(stripBoundaryLeakage('<user><user_message qq="10001" nickname="小明">你好</user_message>')).toBe('你好')
    // 行尾紧贴上一轮用户原话（issue 报告的结尾形态）
    expect(stripBoundaryLeakage('好的，你刚才说：\n帮我看下今天天气</user>\n我已收到。')).toBe('好的，你刚才说：\n帮我看下今天天气\n我已收到。')
  })

  it('句中出现的 <user> / </user>（正文提及、XML、比较符号）不误伤', () => {
    const midSentence = '比较 <user> 与 </user> 标签的用法：a < b 且 <tag>x</tag>'
    expect(stripBoundaryLeakage(midSentence)).toBe(midSentence)
    // 行中提及前缀文字同样不误伤（非行首）
    const prose = '宿主会输出形如 Time sampled while preparing turn 1: … 的行'
    expect(stripBoundaryLeakage(prose)).toBe(prose)
  })
})

describe('#46: 宿主时间采样/上下文行清洗', () => {
  it('整行以固定前缀开头的宿主行整行删除', () => {
    const reply = '好的，我查一下。\nTime sampled while preparing turn 441, step 1: 2026-11-07T22:00:15+08:00[Asia/Shanghai]\n结果如下。'
    expect(stripBoundaryLeakage(reply)).toBe('好的，我查一下。\n结果如下。')
    expect(stripBoundaryLeakage('回答。\nBrowser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.\n完。')).toBe('回答。\n完。')
    expect(stripBoundaryLeakage('回答。\nElapsed since the preceding model-visible message: 2m 13s\n完。')).toBe('回答。\n完。')
  })

  it('行中提及前缀（非行首）不误伤', () => {
    const colon = '提示：Browser time zone for this request: 是宿主前缀'
    expect(stripBoundaryLeakage(colon)).toBe(colon)
    const elapsed = '比如 Elapsed since the preceding model-visible message: 这样的句子'
    expect(stripBoundaryLeakage(elapsed)).toBe(elapsed)
  })
})

describe('#46: issue 原始症状组合', () => {
  it('回复正文 + 三类泄漏同时出现，全部清洗且正文完好', () => {
    const leaked = [
      '在的，有什么事？',
      'Time sampled while preparing turn 441, step 1: 2026-11-07T22:00:15+08:00[Asia/Shanghai]',
      '<user>',
      '<user_message qq="10001" nickname="小明">',
      '帮我看下今天天气',
      '</user_message>',
      '</user>',
      'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.',
      'Elapsed since the preceding model-visible message: 2m 13s',
    ].join('\n')
    expect(stripBoundaryLeakage(leaked)).toBe('在的，有什么事？')
  })

  it('无泄漏特征的正文原样返回（含 <user_message> 之外的尖括号内容）', () => {
    const clean = '普通回复：a < b，<xml>data</xml>'
    expect(stripBoundaryLeakage(clean)).toBe(clean)
  })
})

describe('#46 补充: skill_content / system-reminder / </input> 清洗', () => {
  it('issue 真实泄漏样本：成对/嵌套宿主块、散标签、</input> 全清，仅留正文行', () => {
    // 0.10.0 真机泄漏原文（zwxlkss 评论，chat_id onebot-private-2310053791）：
    // 无 user_message 包裹，走 stripBoundaryLeakage 早退路径，宿主块清洗
    // 必须赶在早退判断之前生效。
    const leaked = [
      '[09:24] 我一晚上醒好几次',
      '</input>',
      '[09:24] 一晚醒好几次',
      '<skill_content name="diagnose-windows-sandbox-acl">',
      '</skill_content>',
      '</system-reminder>',
      '<skill_content name="diagnose-windows-sandbox-acl">',
      '</skill_content>',
      '<system-reminder>',
      'A skill is not currently loaded. Reusable prompt is here:',
      '<system_reminder>',
      'A skill is not currently loaded. This is a system-reminder</system_reminder>',
      '</system-reminder>',
      '[09:24] 嗯嗯',
      '[09:24] 睡，还这样',
    ].join('\n')
    expect(stripBoundaryLeakage(leaked)).toBe(
      '[09:24] 我一晚上醒好几次\n\n[09:24] 一晚醒好几次\n\n[09:24] 嗯嗯\n[09:24] 睡，还这样',
    )
  })

  it('成对宿主块整块丢弃：拼写混用的嵌套块外层连同内层一起消失', () => {
    // 外层 system-reminder 连同内层 system_reminder 一起整块丢弃（真实样本
    // 的嵌套形态）：\1 反向引用只认同名闭标签，内层混拼标签不截断外层懒惰
    // 匹配，块内脚手架行随之清掉。
    expect(
      stripBoundaryLeakage('前文\n<system-reminder>x\n<system_reminder>y</system_reminder>\nz</system-reminder>\n后文'),
    ).toBe('前文\n\n后文')
    // skill_content 成对块整块丢弃（含块内内容）。
    expect(stripBoundaryLeakage('前文\n<skill_content name="foo">技能正文\n</skill_content>\n后文')).toBe('前文\n\n后文')
  })

  it('同拼写嵌套：外层懒惰匹配止于内层闭标签，孤儿闭标签由散标签兜底剥掉', () => {
    expect(stripBoundaryLeakage('前文\n<system-reminder><system-reminder></system-reminder></system-reminder>\n后文')).toBe(
      '前文\n\n后文',
    )
  })

  it('散标签兜底：不成对的孤儿标签剥掉、夹着的正文保留', () => {
    expect(stripBoundaryLeakage('前文\n<skill_content name="x">孤立的标签正文\n后文')).toBe('前文\n孤立的标签正文\n后文')
    expect(stripBoundaryLeakage('前文\n</system_reminder>\n后文')).toBe('前文\n\n后文')
  })

  it('</input> 只剥收尾形态；开标签与正文讨论不碰', () => {
    expect(stripBoundaryLeakage('前文\n</input>\n后文')).toBe('前文\n\n后文')
    expect(stripBoundaryLeakage('<input type="text"> in prose')).toBe('<input type="text"> in prose')
  })

  it('误伤反例：比较符号、正文里的 <br>、中文尖括号场景原样保留', () => {
    const cases = [
      'if a < b and c > d, 3<4',
      '正文里 <br> 留着',
      '中文尖括号〈system-reminder〉与〈skill_content〉不误伤',
      '普通中文句子，没有任何标记。',
    ]
    for (const clean of cases) expect(stripBoundaryLeakage(clean)).toBe(clean)
  })

  it('宿主标签清洗与 user_message 清洗叠加：两路都生效', () => {
    const mixed = '<user_message qq="10001" nickname="小明">你好</user_message>\n</input>\n<skill_content name="x">\n</skill_content>'
    expect(stripBoundaryLeakage(mixed)).toBe('你好')
  })
})
