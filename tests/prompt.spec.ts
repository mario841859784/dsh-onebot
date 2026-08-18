import { describe, expect, it } from 'vitest'
import { buildPlatformPrompt } from '../src/prompt.js'

describe('buildPlatformPrompt', () => {
  it('forbids host Web-interaction tools and routes plan-mode exit via /plan off on QQ', () => {
    const text = buildPlatformPrompt(false)
    expect(text).toContain('ask_user_question')
    expect(text).toContain('exit_plan_mode')
    expect(text).toContain('纯文本提问并等待用户回复')
    // Host plan mode must be exit-able from QQ without the Web review card.
    expect(text).toContain('/plan off')
  })

  it('keeps the restricted-member prefix note only when enabled', () => {
    expect(buildPlatformPrompt(false)).not.toContain('受限用户')
    expect(buildPlatformPrompt(true)).toContain('受限用户')
  })
})
