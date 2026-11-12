import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.js'
import {
  ALL_KEYS, NOTICE_KEYS, PENDING_SCHEMA_KEYS, SCHEMA_DEFAULTS, SETTINGS_GROUPS, validatePatch,
} from '../src/settings-remote.js'

/** T5（PR port 配置默认值翻转 + SCHEMA_DEFAULTS 键表）：
 *  1) 默认值翻转（10 处里保留的 8 处）——schema 解析默认值与 SCHEMA_DEFAULTS 逐字一致；
 *  2) 键表完整性——SCHEMA_DEFAULTS 每键在 schema 有定义（PENDING 豁免）、
 *     无孤儿键（每组键都有类型通道，notices 单独通道）。 */

/** 用户裁定①（含安全面项，风险已提示仍拍板）：10 处默认值按贡献者值翻转。
 *  其中 injectEnabled/injectDryRun 已改回默认关 + 干跑（注入通道仅调试用，
 *  断言见 tests/inject.spec.ts），这里只列其余 8 处。 */
const T5_FLIPPED: ReadonlyArray<readonly [string, unknown]> = [
  ['mode', 'forward'],
  ['allowPrivateHosts', true],
  ['inboxRedact', true],
  ['newMessagePolicy', 'steer'],
  ['interimRecall', false],
  ['sendErrorNotice', false],
  ['textImageThreshold', 350],
  ['cardFooter', 'OneBot'],
]

describe('T5 默认值翻转（schema 与 SCHEMA_DEFAULTS 两处一致）', () => {
  const resolved = Config({}) as Record<string, unknown>
  for (const [key, expected] of T5_FLIPPED) {
    it(`${key} 默认翻转为 ${JSON.stringify(expected)}`, () => {
      expect(SCHEMA_DEFAULTS[key]).toEqual(expected)
      expect(resolved[key]).toEqual(expected)
      expect(resolved[key]).toEqual(SCHEMA_DEFAULTS[key])
    })
  }
})

describe('T5 键表完整性（SCHEMA_DEFAULTS 与 schema 无孤儿键）', () => {
  const resolved = Config({}) as Record<string, unknown>
  const groupKeys = Object.values(SETTINGS_GROUPS).flat()

  it('七组结构（T8/T11/T24 增键 + 0.10.0 重排方案 A + #59 memberTools + #58 旁观）：connection 6 / permissions 16 / behavior 12+2 / bystander 5 / session 5+5 / media 16+1 / diagnostics 7', () => {
    expect(Object.keys(SETTINGS_GROUPS)).toEqual(['connection', 'permissions', 'behavior', 'bystander', 'session', 'media', 'diagnostics'])
    expect(SETTINGS_GROUPS.connection).toHaveLength(6) // 0.10.0 重排：连接=通道配置（-8 键）
    expect(SETTINGS_GROUPS.permissions).toHaveLength(16) // #59：+memberTools
    expect(SETTINGS_GROUPS.behavior).toHaveLength(14) // T24：+titleSyncEnabled；0.10.0：+ignoreSelf/sidebarEntryEnabled
    expect(SETTINGS_GROUPS.bystander).toHaveLength(5) // #58：旁观五键
    expect(SETTINGS_GROUPS.behavior).toEqual(expect.arrayContaining(['inboxQueueEnabled', 'inboxQueueDelayMs', 'titleSyncEnabled']))
    expect(SETTINGS_GROUPS.session).toHaveLength(10) // 0.10.0：5→10（+工作区×2/强制会话/提示词文件×2）
    expect(SETTINGS_GROUPS.media).toHaveLength(17) // T6：+gifFramesEnabled；0.10.0：+allowPrivateHosts
    expect(SETTINGS_GROUPS.media).toContain('gifFramesEnabled')
    expect(SETTINGS_GROUPS.diagnostics).toHaveLength(7)
  })

  it('SCHEMA_DEFAULTS 键集 == ALL_KEYS 键集（不多不少）', () => {
    expect(Object.keys(SCHEMA_DEFAULTS).sort()).toEqual([...ALL_KEYS].sort())
  })

  it('每组键都在 ALL_KEYS 内（无组外孤儿键）', () => {
    for (const key of groupKeys) expect(ALL_KEYS).toContain(key)
  })

  it('除 PENDING 豁免键外，SCHEMA_DEFAULTS 每键在 schema 有定义且默认值一致', () => {
    for (const key of ALL_KEYS) {
      if (PENDING_SCHEMA_KEYS.includes(key)) continue
      if (key === 'memberTools') continue // #59：宿主配置嵌套在 permissions 下，扁平 resolved 无此键（下方单独断言）
      expect(Object.hasOwn(resolved, key)).toBe(true)
      expect(resolved[key]).toEqual(SCHEMA_DEFAULTS[key])
    }
    // #59：memberTools 是「面板扁平键 ↔ 宿主嵌套对象」特例（notices 先例）——
    // schema 定义在 permissions.memberTools，默认值与面板 SCHEMA_DEFAULTS 一致。
    expect((resolved.permissions as Record<string, unknown>).memberTools).toEqual(SCHEMA_DEFAULTS.memberTools)
  })

  it('PENDING 键已进表但 schema 尚未定义（T7 落地后豁免名单应清空；faceStyle 已随 T6 转正）', () => {
    expect(PENDING_SCHEMA_KEYS.sort()).toEqual(['firstMessageAsUser', 'forceSessionId', 'newSessionGreeting', 'textImageEnabled'])
    for (const key of PENDING_SCHEMA_KEYS) {
      expect(ALL_KEYS).toContain(key)
      expect(Object.hasOwn(resolved, key)).toBe(false)
    }
  })

  it('notices 默认值与 schema 一致（我们无贡献者的 newSession 键）', () => {
    expect(NOTICE_KEYS).toEqual(['steerAccepted', 'queue', 'answerAccepted', 'deferredTimeout', 'rateLimited'])
    expect(resolved.notices).toEqual(SCHEMA_DEFAULTS.notices)
  })
})

describe('T5 validatePatch 新键通道与 notices 白名单', () => {
  it('notices 增量子集通过并原样保留', () => {
    expect(validatePatch({ notices: { queue: false } })).toEqual({ notices: { queue: false } })
    expect(validatePatch({ notices: { steerAccepted: true, rateLimited: '静音' } }))
      .toEqual({ notices: { steerAccepted: true, rateLimited: '静音' } })
  })

  it('notices 未知子键/非法值整单拒绝', () => {
    expect(() => validatePatch({ notices: { newSession: true } })).toThrow(/未知 notice 键/)
    expect(() => validatePatch({ notices: { queue: 1 } })).toThrow(/必须是布尔值或字符串/)
    expect(() => validatePatch({ notices: [true] })).toThrow(/notices 必须是对象/)
  })

  it('新键走既有类型通道（枚举/数字范围/布尔/字符串/字符串数组）', () => {
    expect(validatePatch({ faceStyle: 'emoji', logLevel: 'debug', sttEngine: 'whisper-cpp' }))
      .toEqual({ faceStyle: 'emoji', logLevel: 'debug', sttEngine: 'whisper-cpp' })
    expect(validatePatch({ textImageThreshold: 0, maxFileBytes: 4294967296, chatIdleEvictDays: 30 }))
      .toEqual({ textImageThreshold: 0, maxFileBytes: 4294967296, chatIdleEvictDays: 30 })
    expect(validatePatch({ forceSessionId: 'abc', cardFooter: 'X' }))
      .toEqual({ forceSessionId: 'abc', cardFooter: 'X' })
    expect(validatePatch({ wakeNamesAdmin: ['a'], sttArgs: ['--x'] }))
      .toEqual({ wakeNamesAdmin: ['a'], sttArgs: ['--x'] })
    expect(validatePatch({ allowPrivateHosts: false, memoryFilesEnabled: true }))
      .toEqual({ allowPrivateHosts: false, memoryFilesEnabled: true })
  })

  it('新键越界/类型不符拒绝', () => {
    expect(() => validatePatch({ textImageThreshold: -1 })).toThrow(/≥0/)
    expect(() => validatePatch({ maxFileBytes: 0 })).toThrow(/1–4294967296/)
    expect(() => validatePatch({ faceStyle: 'gif' })).toThrow(/faceStyle 必须是/)
    expect(() => validatePatch({ logLevel: 'verbose' })).toThrow(/logLevel 必须是/)
  })
})
