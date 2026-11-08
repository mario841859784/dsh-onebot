import { describe, expect, it } from 'vitest'
import { buildPlatformPrompt } from '../src/prompt.js'

describe('buildPlatformPrompt', () => {
  it('encourages ask_user_question and keeps only the exit_plan_mode ban (T2-B1)', () => {
    const text = buildPlatformPrompt(false)
    // ask_user_question is now bridged to QQ cards — the model is encouraged to call it.
    expect(text).toContain('ask_user_question')
    expect(text).toContain('调用 ask_user_question')
    expect(text).toContain('选项卡')
    // exit_plan_mode stays banned (its card is Web-only and would block the turn).
    expect(text).toContain('禁止调用 exit_plan_mode')
    expect(text).not.toContain('禁止调用 ask_user_question')
    expect(text).toContain('/plan off')
    // T1: /plan off 仅在用户询问退出时作为回答提及，不主动输出计划模式引导语。
    expect(text).toContain('仅在用户处于计划模式且询问如何退出时')
    expect(text).not.toContain('提示「审阅后发 /plan off')
    // M3-D5: the user_message boundary declaration is part of the platform section.
    expect(text).toContain('<user_message')
  })

  it('keeps the restricted-member prefix note only when enabled', () => {
    expect(buildPlatformPrompt(false)).not.toContain('来自受限用户')
    expect(buildPlatformPrompt(true)).toContain('来自受限用户')
  })

  it('declares the tiered group prefix and the member-tier chat-only rule (权限分档 A1)', () => {
    const text = buildPlatformPrompt(false)
    expect(text).toContain('[HH:MM 昵称(QQ)·档位]')
    expect(text).toContain('·成员')
    expect(text).toContain('·管理员')
    // 成员档位指引：仅聊天，不执行写操作/工具调用（不受 restrictedMembers 开关影响）。
    expect(text).toContain('仅与其聊天问答')
    expect(text).toContain('qq_* 等工具调用会被插件直接拒绝')
  })
})
