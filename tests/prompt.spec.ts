import { describe, expect, it } from 'vitest'
import { buildPlatformPrompt } from '../src/prompt.js'

describe('buildPlatformPrompt', () => {
  it('forbids host Web-interaction tools so QQ turns never block on the Web card', () => {
    const text = buildPlatformPrompt(false)
    expect(text).toContain('ask_user_question')
    expect(text).toContain('exit_plan_mode')
    expect(text).toContain('直接在回复中用纯文本提问并等待用户回复')
  })

  it('keeps the restricted-member prefix note only when enabled', () => {
    expect(buildPlatformPrompt(false)).not.toContain('受限用户')
    expect(buildPlatformPrompt(true)).toContain('受限用户')
  })
})
