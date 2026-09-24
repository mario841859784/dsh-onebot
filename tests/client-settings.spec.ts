/**
 * 客户端设置页 UI bundle 测试（T4）。
 *
 * 验证 lib/client.js（浏览器 client bundle，无法直接 import——CJS 包裹挂
 * window.__ModuleLoader__）的模块级契约：
 *   ① 语法可解析（new Function）+ CJS banner/footer 形态 + externals 仅 react；
 *   ② 入口导出 inject + apply；
 *   ③ 三组 19 键：分组/键集/默认值与宿主侧 src/settings-remote.js（T3）导出常量
 *      逐字一致（descriptor 契约核对，防两侧漂移）；
 *   ④ Typert descriptor 与 T3 服务方法面逐字对齐：getSettings() /
 *      updateSettings(patch, expectedRevision)，全 positional，namespace
 *      onebotSettings，result codec 可解析 host 形态快照（含脱敏 accessToken）；
 *   ⑤ 渲染函数模块级可测：renderGroup 纯函数产出三组 19 键控件，accessToken
 *      密码型输入且不明文回显（脱敏约定：host 快照 accessToken 恒 ''）；
 *   ⑥ 保存语义：computePatch 产出 19 键子集 patch；secretDraft '' = 不修改、
 *      clearSecret = accessToken ''（清空）；数字非法键不进 patch。
 *
 * 契约唯一来源：docs/settings-page-design.md（T1 定案）§3/§3.1/§4/§5。
 * @module dsh-onebot/tests/client-settings
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  ALL_KEYS,
  NAMESPACE,
  REMOTE_EFFECT,
  SCHEMA_DEFAULTS,
  SECRET_KEYS,
  SETTINGS_GROUPS,
} from '../src/settings-remote.js'

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 极简 React 替身：createElement 产出可遍历的元素树（渲染函数模块级可测）。 */
type StubElement = { type: unknown; props: Record<string, unknown>; children: unknown[] }
const stubReact = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true) }
  },
}
function walk(node: unknown): StubElement[] {
  if (node === null || typeof node !== 'object') return []
  const out: StubElement[] = []
  const element = node as StubElement
  if (element.type !== undefined && typeof element.props === 'object' && element.props !== null) out.push(element)
  for (const child of element.children ?? []) out.push(...walk(child))
  return out
}

/** CJS 包裹装载：模拟 window.__ModuleLoader__.load + require('react') 外部表。 */
function loadClientModule(): Record<string, unknown> {
  const factories: Record<string, (request: (spec: string) => unknown) => unknown> = {}
  const globalWithWindow = globalThis as unknown as { window?: { __ModuleLoader__: unknown } }
  globalWithWindow.window = { __ModuleLoader__: { load: (entry: { id: string; factory: (request: (spec: string) => unknown) => unknown }) => { factories[entry.id] = entry.factory } } }
  // 求值 bundle 源码：new Function 体在调用时经全局 window 找到 ModuleLoader 桩完成注册。
  new Function(CLIENT_SOURCE)()
  const factory = factories['dsh-onebot']
  if (factory === undefined) throw new Error('lib/client.js 未注册 dsh-onebot 模块')
  return factory((spec: string) => {
    if (spec !== 'react') throw new Error(`unexpected external require: ${spec}`)
    return stubReact
  }) as Record<string, unknown>
}

const client = loadClientModule()
const descriptors = client.ONEBOT_SETTINGS_DESCRIPTORS as Array<Record<string, unknown>>
const groups = client.GROUPS as Array<{ id: string; title: string; fields: Array<{ key: string; label: string; type: string; options?: string[]; optionLabels?: Record<string, string>; hint?: string }> }>
const allFields = client.ALL_FIELDS as Array<{ key: string; type: string }>

describe('T4 客户端 bundle — 装载契约（CJS 包裹 / externals / 入口导出）', () => {
  it('语法可解析：new Function 直接解析 lib/client.js 全文', () => {
    expect(() => new Function(CLIENT_SOURCE)).not.toThrow()
  })

  it('CJS 包裹形态：banner window.__ModuleLoader__.load({id, factory:(require)=>{ + footer return module.exports', () => {
    expect(CLIENT_SOURCE).toContain('window.__ModuleLoader__.load({')
    expect(CLIENT_SOURCE).toContain('id: "dsh-onebot",')
    expect(CLIENT_SOURCE).toContain('factory: (require) => {')
    expect(CLIENT_SOURCE.trimEnd().endsWith('return module.exports;\n\t}\n});')).toBe(true)
  })

  it('externals 仅 react：文件内全部 require 调用都指向 react', () => {
    const requireCalls = CLIENT_SOURCE.match(/require\s*\(/g) ?? []
    const reactCalls = CLIENT_SOURCE.match(/require\s*\(\s*["']react["']\s*\)/g) ?? []
    expect(reactCalls.length).toBe(requireCalls.length)
    expect(requireCalls.length).toBeGreaterThan(0)
  })

  it('入口导出 inject（宿主客户端服务名数组）+ apply(ctx)', () => {
    expect(client.inject).toEqual(['slots', 'locale', 'remote'])
    expect(typeof client.apply).toBe('function')
    expect(typeof client.OnebotSettingsPanel).toBe('function')
  })

  it('除 react 外无运行时依赖：源码不引用 node: / @deepseek-ai 模块', () => {
    expect(CLIENT_SOURCE).not.toMatch(/require\s*\(\s*["'](node:|@deepseek-ai\/|schemastery)/)
    expect(CLIENT_SOURCE).not.toMatch(/\bimport\s/)
  })
})

describe('T4 客户端 bundle — descriptor 契约核对（与 T3 src/settings-remote.js 逐字对齐）', () => {
  it('namespace/service = onebotSettings，与宿主 NAMESPACE 常量一致', () => {
    expect(client.ONEBOT_SETTINGS_REMOTE).toEqual({ package: 'dsh-onebot', descriptors })
    for (const descriptor of descriptors) {
      expect(descriptor.namespace).toBe(NAMESPACE)
      expect(descriptor.service).toBe(NAMESPACE)
      expect(descriptor.method).toBeTypeOf('string')
      expect(descriptor.id).toBe(`dsh-onebot#${NAMESPACE}/${String(descriptor.method)}`)
    }
  })

  it('方法集逐字对齐：getSettings() 0 参；updateSettings(patch, expectedRevision) 全 positional', () => {
    expect(descriptors.map((descriptor) => descriptor.method)).toEqual(['getSettings', 'updateSettings'])
    const getSettings = descriptors[0] as { parameters: Array<unknown>; result: { schema: { parse(value: unknown): unknown } } }
    expect(getSettings.parameters).toEqual([])
    const updateSettings = descriptors[1] as { parameters: Array<{ name: string }>; result: { schema: { parse(value: unknown): unknown } } }
    expect(updateSettings.parameters.map((parameter) => parameter.name)).toEqual(['patch', 'expectedRevision'])
  })

  it('result codec 可解析宿主形态快照（T1 §3：19 键 config + secrets 脱敏标记 + groups + effect=restart）', () => {
    const getSettings = descriptors[0] as { result: { schema: { parse(value: unknown): unknown } } }
    const config: Record<string, unknown> = { ...SCHEMA_DEFAULTS }
    config.accessToken = '' // 宿主 buildSnapshot 脱敏约定：快照 accessToken 恒 ''
    const snapshot = {
      revision: 3,
      entryActive: true,
      config,
      secrets: SECRET_KEYS.map((key) => ({ path: [key], set: typeof SCHEMA_DEFAULTS[key] === 'string' && (SCHEMA_DEFAULTS[key] as string).length > 0 })),
      groups: SETTINGS_GROUPS,
      effect: REMOTE_EFFECT,
    }
    const parsed = getSettings.result.schema.parse(snapshot) as typeof snapshot
    expect(parsed.config.accessToken).toBe('')
    expect(parsed.effect).toBe(REMOTE_EFFECT)
  })

  it('result codec 拒绝缺键/多 effect 快照（严格 codec，防宿主契约漂移静默通过）', () => {
    const getSettings = descriptors[0] as { result: { schema: { parse(value: unknown): unknown } } }
    const config: Record<string, unknown> = { ...SCHEMA_DEFAULTS }
    delete config.port
    expect(() => getSettings.result.schema.parse({ revision: 0, entryActive: true, config, secrets: [], groups: SETTINGS_GROUPS, effect: 'restart' })).toThrow()
    expect(() => getSettings.result.schema.parse({ revision: 0, entryActive: true, config: SCHEMA_DEFAULTS, secrets: [], groups: SETTINGS_GROUPS, effect: 'none' })).toThrow()
  })

  it('updateSettings patch codec 接受 19 键任意子集、拒绝非法枚举值', () => {
    const updateSettings = descriptors[1] as { parameters: Array<{ codec: { schema: { parse(value: unknown): unknown } } }> }
    const patchCodec = updateSettings.parameters[0].codec.schema
    expect(patchCodec.parse({ port: 1234 })).toEqual({ port: 1234 })
    expect(patchCodec.parse({ adminUsers: ['10000'], unknownCommand: 'passthrough' })).toEqual({ adminUsers: ['10000'], unknownCommand: 'passthrough' })
    expect(() => patchCodec.parse({ mode: 'invalid' })).toThrow()
  })
})

describe('T4 客户端 bundle — 三组 19 键（分组/键集/默认值 = T1 §4 表 = T3 常量）', () => {
  it('分组与键序逐字对齐 host SETTINGS_GROUPS', () => {
    expect(client.GROUP_KEYS).toEqual(SETTINGS_GROUPS)
    expect(groups.map((group) => group.id)).toEqual(['connection', 'permissions', 'behavior'])
    expect(allFields.map((field) => field.key).sort()).toEqual([...ALL_KEYS].sort())
    expect(allFields).toHaveLength(19)
  })

  it('默认值逐字对齐 host SCHEMA_DEFAULTS（重置按钮唯一来源）', () => {
    expect(client.DEFAULTS).toEqual(SCHEMA_DEFAULTS)
  })

  it('字段类型与 host 默认值形态一致；枚举字段选项覆盖默认值', () => {
    const defaults = client.DEFAULTS as Record<string, unknown>
    for (const field of allFields) {
      const fallback = SCHEMA_DEFAULTS[field.key]
      if (field.type === 'boolean') expect(typeof fallback).toBe('boolean')
      else if (field.type === 'number') expect(typeof fallback).toBe('number')
      else if (field.type === 'enum') expect(field.options ?? []).toContain(fallback)
      else if (field.type === 'stringArray') expect(Array.isArray(fallback)).toBe(true)
      else expect(field.type === 'string' || field.type === 'secret').toBe(true)
    }
    // 枚举键集与宿主 validatePatch 接受的枚举值一致（T1 §4 表）
    const enumField = (key: string) => groups.flatMap((group) => group.fields).find((field) => field.key === key)
    expect(enumField('mode')?.options).toEqual(['reverse', 'forward'])
    expect(enumField('dmPolicy')?.options).toEqual(['open', 'allowlist', 'disabled'])
    expect(enumField('groupPolicy')?.options).toEqual(['open', 'allowlist', 'disabled'])
    expect(enumField('unknownCommand')?.options).toEqual(['intercept', 'passthrough'])
  })

  it('分组标题与字段 label 为中文（T4 要求）', () => {
    expect(groups.map((group) => group.title)).toEqual(['连接', '权限', '行为'])
    for (const field of allFields) expect(field.label).toMatch(/\p{Script=Han}/u)
  })

  it('accessToken 是唯一 secret 字段（脱敏约定：密码型输入 + 不明文回显）', () => {
    const secretFields = allFields.filter((field) => field.type === 'secret')
    expect(secretFields.map((field) => field.key)).toEqual([...SECRET_KEYS])
  })
})

describe('T4 客户端 bundle — 渲染函数模块级可测（renderGroup 纯函数）', () => {
  const draft = client.draftFromSnapshot as (snapshot: { config: Record<string, unknown> }) => Record<string, unknown>

  function renderAll(draftValues: Record<string, unknown>, opts: { secretSet?: boolean; clearSecret?: boolean } = {}) {
    return groups.map((group) => (client.renderGroup as Function)(stubReact, group, {
      draft: draftValues,
      secretSet: opts.secretSet === true,
      clearSecret: opts.clearSecret === true,
      onChange: () => {},
      onSecretChange: () => {},
      onClearSecretChange: () => {},
    }))
  }

  it('三组各产出标题与逐字段控件行（19 行 obx-field）', () => {
    const sections = renderAll(draft({ config: SCHEMA_DEFAULTS }))
    expect(sections.map((section) => (section.props as Record<string, unknown>)['data-group'])).toEqual(['connection', 'permissions', 'behavior'])
    const titles = sections.map((section) => ((section.children[0] as StubElement).children[0] as string))
    expect(titles).toEqual(['连接', '权限', '行为'])
    const fieldRows = sections.flatMap((section) => walk(section).filter((element) => element.type === 'div' && element.props.className === 'obx-field'))
    expect(fieldRows).toHaveLength(19)
  })

  it('控件类型齐备：4 枚举下拉 + 3 多行文本 + 5 布尔勾选 + 4 文本框 + 1 密码框（secret 另含清除勾选）', () => {
    const elements = renderAll(draft({ config: SCHEMA_DEFAULTS })).flatMap((section) => walk(section))
    const inputs = elements.filter((element) => element.type === 'input') as Array<StubElement & { props: Record<string, unknown> }>
    const selects = elements.filter((element) => element.type === 'select')
    const textareas = elements.filter((element) => element.type === 'textarea')
    expect(selects).toHaveLength(4)
    expect(textareas).toHaveLength(3)
    expect(inputs.filter((input) => input.props.type === 'checkbox')).toHaveLength(5 + 1) // 5 布尔 + secret 清除勾选
    expect(inputs.filter((input) => input.props.type === 'text')).toHaveLength(6) // host/port/url/botQQ + interimRecallMs/rateLimitPerMinute（number 以文本框渲染）
    expect(inputs.filter((input) => input.props.type === 'password')).toHaveLength(1)
  })

  it('accessToken 密码型输入且不明文回显：value 恒空、树内不含明文', () => {
    const snapshot = { config: { ...SCHEMA_DEFAULTS, accessToken: 'super-secret-token' } }
    const redactedDraft = draft(snapshot)
    expect(redactedDraft.accessToken).toBe('') // draftFromSnapshot 脱敏：明文绝不进入草稿
    const elements = renderAll(redactedDraft, { secretSet: true }).flatMap((section) => walk(section))
    const passwordInputs = elements.filter((element) => element.type === 'input' && (element.props as Record<string, unknown>).type === 'password') as Array<StubElement & { props: Record<string, unknown> }>
    expect(passwordInputs).toHaveLength(1)
    expect(passwordInputs[0].props['aria-label']).toBe('访问令牌（AccessToken）')
    expect(passwordInputs[0].props.value).toBe('')
    expect(JSON.stringify(elements)).not.toContain('super-secret-token')
    // 已配置状态以脱敏徽标展示，不泄露明文
    expect(JSON.stringify(elements)).toContain('已配置（脱敏，不回显）')
  })

  it('快照 secrets 标记（set=false）渲染「未配置」徽标；清除勾选走独立通道', () => {
    const elements = renderAll(draft({ config: SCHEMA_DEFAULTS }), { secretSet: false, clearSecret: true }).flatMap((section) => walk(section))
    expect(JSON.stringify(elements)).toContain('未配置')
    expect(JSON.stringify(elements)).toContain('清除已保存的 AccessToken')
  })
})

describe('T4 客户端 bundle — 保存语义（updateSettings(patch, expectedRevision) 入参构造）', () => {
  const draft = client.draftFromSnapshot as (snapshot: { config: Record<string, unknown> }) => Record<string, unknown>
  const compute = client.computePatch as (
    draftValues: Record<string, unknown>,
    config: Record<string, unknown>,
    opts?: { secretDraft?: string; clearSecret?: boolean },
  ) => { patch: Record<string, unknown>; invalidKeys: string[] }

  it('仅下发与生效值有差异的键（19 键任意子集）', () => {
    const values = draft({ config: SCHEMA_DEFAULTS })
    values.port = '9999'
    values.mode = 'forward'
    values.groupAllowFrom = '111\n222'
    const { patch, invalidKeys } = compute(values, SCHEMA_DEFAULTS)
    expect(invalidKeys).toEqual([])
    expect(patch).toEqual({ port: 9999, mode: 'forward', groupAllowFrom: ['111', '222'] })
  })

  it('无差异时 patch 为空对象（no-op 短路，host 不递增 revision）', () => {
    const values = draft({ config: SCHEMA_DEFAULTS })
    const { patch } = compute(values, SCHEMA_DEFAULTS, { secretDraft: '', clearSecret: false })
    expect(patch).toEqual({})
  })

  it('accessToken 三态：留空 = 不修改（缺省）；输入 = 明文写入；勾选清除 = 下发空串', () => {
    const values = draft({ config: SCHEMA_DEFAULTS })
    expect(compute(values, SCHEMA_DEFAULTS, { secretDraft: '', clearSecret: false }).patch.accessToken).toBeUndefined()
    expect(compute(values, SCHEMA_DEFAULTS, { secretDraft: 'new-token', clearSecret: false }).patch.accessToken).toBe('new-token')
    expect(compute(values, SCHEMA_DEFAULTS, { secretDraft: '', clearSecret: true }).patch.accessToken).toBe('')
  })

  it('数字字段非法输入不进 patch 且单独报告（host validatePatch 二次校验兜底）', () => {
    const values = draft({ config: SCHEMA_DEFAULTS })
    values.interimRecallMs = 'abc'
    values.rateLimitPerMinute = '45'
    const { patch, invalidKeys } = compute(values, SCHEMA_DEFAULTS)
    expect(invalidKeys).toEqual(['interimRecallMs'])
    expect(patch).toEqual({ rateLimitPerMinute: 45 })
    expect(patch.interimRecallMs).toBeUndefined()
  })

  it('stringArray 文本按行解析：trim、去空行，与宿主字符串数组契约一致', () => {
    const values = draft({ config: SCHEMA_DEFAULTS })
    values.adminUsers = ' 10000 \n\n 20000 \n'
    const { patch } = compute(values, SCHEMA_DEFAULTS)
    expect(patch.adminUsers).toEqual(['10000', '20000'])
  })
})
