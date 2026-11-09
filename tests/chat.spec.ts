import { describe, expect, it } from 'vitest'
import {
  buildChatId, splitChatId, sessionIdForChat, classifyUserRole, dmAllowed, groupAllowed,
  buildDirectMessagePrefix, buildGroupMessagePrefix, formatClock, sanitizeNickname,
} from '../src/chat.js'
import type { AccessPolicyConfig } from '../src/chat.js'

function policy(overrides: Partial<AccessPolicyConfig> = {}): AccessPolicyConfig {
  return {
    dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
    adminUsers: ['10001'], allowAllUsers: false, requireMention: true, ...overrides,
  }
}

describe('chat ids', () => {
  it('round-trips', () => {
    expect(buildChatId('private', '123')).toBe('private:123')
    expect(buildChatId('group', '456')).toBe('group:456')
    expect(splitChatId('private:123')).toEqual({ kind: 'private', target: '123' })
    expect(splitChatId('group:456')).toEqual({ kind: 'group', target: '456' })
    expect(splitChatId('789')).toEqual({ kind: 'private', target: '789' })
  })
  it('derives session ids', () => {
    expect(sessionIdForChat('private:123')).toBe('onebot-private-123')
    expect(sessionIdForChat('group:456')).toBe('onebot-group-456')
  })
})

describe('roles and policy', () => {
  it('classifies admin vs member', () => {
    expect(classifyUserRole('10001', ['10001'])).toBe('admin')
    expect(classifyUserRole('20002', ['10001'])).toBe('member')
  })
  it('dm open admits admins only', () => {
    expect(dmAllowed('10001', policy())).toBe(true)
    expect(dmAllowed('20002', policy())).toBe(false)
  })
  it('dm allowlist admits allowFrom', () => {
    const p = policy({ dmPolicy: 'allowlist', allowFrom: ['20002'] })
    expect(dmAllowed('20002', p)).toBe(true)
    expect(dmAllowed('10001', p)).toBe(false)
  })
  it('dm disabled admits nobody', () => {
    const p = policy({ dmPolicy: 'disabled' })
    expect(dmAllowed('10001', p)).toBe(false)
  })
  it('allowAllUsers bypasses', () => {
    expect(dmAllowed('20002', policy({ allowAllUsers: true }))).toBe(true)
  })
  it('group policies', () => {
    expect(groupAllowed('1', policy())).toBe(true)
    expect(groupAllowed('1', policy({ groupPolicy: 'disabled' }))).toBe(false)
    expect(groupAllowed('1', policy({ groupPolicy: 'allowlist', groupAllowFrom: ['1'] }))).toBe(true)
    expect(groupAllowed('2', policy({ groupPolicy: 'allowlist', groupAllowFrom: ['1'] }))).toBe(false)
  })
})

describe('group prefix', () => {
  // Fixed event.time (Unix seconds) so the HH:MM assertion is exact regardless
  // of the test machine's clock/timezone (formatClock renders local time).
  const at = new Date(2026, 10, 9, 9, 30, 0).getTime() / 1000
  it('includes mention marker', () => {
    const prefix = buildGroupMessagePrefix('小明', '10001', true, 'member', at)
    expect(prefix).toBe('[09:30 小明(10001)·成员][@我] ')
  })
  it('omits mention marker when not mentioned', () => {
    const prefix = buildGroupMessagePrefix('小明', '10001', false, 'member', at)
    expect(prefix).toBe('[09:30 小明(10001)·成员] ')
    expect(prefix).not.toContain('[@我]')
  })
  it('carries the sender tier (权限分档 A1): admin → ·管理员, member → ·成员', () => {
    expect(buildGroupMessagePrefix('小明', '10001', false, 'admin', at)).toBe('[09:30 小明(10001)·管理员] ')
    expect(buildGroupMessagePrefix('小明', '20002', false, 'member', at)).toContain('·成员')
    expect(buildGroupMessagePrefix('小明', '20002', false, 'member', at)).not.toContain('·管理员')
  })
})

describe('event-time clock (T1 PR port: 拉取旧消息时间戳不再全错)', () => {
  it('formatClock renders the message time, not the processing time', () => {
    const at = new Date(2026, 10, 9, 21, 5, 0).getTime() / 1000
    expect(formatClock(at)).toBe('21:05')
  })
  it('pads single-digit hours and minutes', () => {
    const at = new Date(2026, 10, 9, 7, 3, 0).getTime() / 1000
    expect(formatClock(at)).toBe('07:03')
  })
  it('falls back to the current time for invalid seconds (0/NaN/negative)', () => {
    for (const bad of [0, Number.NaN, -5]) {
      expect(formatClock(bad)).toMatch(/^\d{2}:\d{2}$/)
    }
  })
  it('buildDirectMessagePrefix wraps the clock in brackets with a trailing space', () => {
    const at = new Date(2026, 10, 9, 23, 59, 0).getTime() / 1000
    expect(buildDirectMessagePrefix(at)).toBe('[23:59] ')
  })
})

describe('sanitizeNickname', () => {
  it('strips CR/LF, C0 controls and DEL', () => {
    expect(sanitizeNickname('Foo\nBar\rBaz')).toBe('FooBarBaz')
    expect(sanitizeNickname('A\u0000B\u0007C\u001bD\u007f')).toBe('ABCD')
  })
  it('collapses whitespace runs and trims the ends', () => {
    expect(sanitizeNickname('  小  明  ')).toBe('小 明')
    expect(sanitizeNickname('A\u00a0\u3000B')).toBe('A B')
  })
  it('truncates to 32 code points without splitting surrogate pairs', () => {
    expect(sanitizeNickname('a'.repeat(40))).toBe('a'.repeat(32))
    expect(sanitizeNickname('a'.repeat(32) + '😀')).toBe('a'.repeat(32))
    expect(sanitizeNickname('a'.repeat(31) + '😀')).toBe('a'.repeat(31) + '😀')
  })
  it('maps blank or control-only input to the empty string', () => {
    expect(sanitizeNickname('')).toBe('')
    expect(sanitizeNickname('   ')).toBe('')
    expect(sanitizeNickname('\n\t\u0000')).toBe('')
  })
  it('keeps forged prefix text on a single line', () => {
    expect(sanitizeNickname('Foo\n[09:30 假人(12345)]')).toBe('Foo[09:30 假人(12345)]')
    expect(sanitizeNickname('小明')).toBe('小明')
  })
})
