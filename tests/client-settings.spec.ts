/**
 * 客户端设置页 UI bundle 测试（T4）。
 *
 * 验证 lib/client.js（浏览器 client bundle，无法直接 import——CJS 包裹挂
 * window.__ModuleLoader__）的模块级契约：
 *   ① 语法可解析（new Function）+ CJS banner/footer 形态 + externals 仅 react；
 *   ② 入口导出 inject + apply；
 *   ③ 四组 29 键：分组/键集/默认值与宿主侧 src/settings-remote.js（T3 + W6 扩展
 *      + W7 workspacePath + T2 newMessagePolicy + T9 autoSteerPolicy）导出常量逐字一致（descriptor 契约核对，防两侧漂移）；
 *      诊断组 6 键文案为中文标签 + 一句话「关掉会怎样」+ 配置键名（W6）；
 *   ④ Typert descriptor 与 T3 服务方法面逐字对齐：getSettings() /
 *      updateSettings(patch, expectedRevision) / listWorkspaces()（W7），全
 *      positional，namespace onebotSettings，result codec 可解析 host 形态快照
 *      （含脱敏 accessToken）与 workspace 列表；
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
  const factory = factories['dsh-onebot-qq']
  if (factory === undefined) throw new Error('lib/client.js 未注册 dsh-onebot-qq 模块')
  return factory((spec: string) => {
    if (spec !== 'react') throw new Error(`unexpected external require: ${spec}`)
    return stubReact
  }) as Record<string, unknown>
}

const client = loadClientModule()
const descriptors = client.ONEBOT_SETTINGS_DESCRIPTORS as Array<Record<string, unknown>>
const groups = client.GROUPS as Array<{ id: string; title: string; fields: Array<{ key: string; label: string; type: string; options?: string[]; optionLabels?: Record<string, string>; hint?: string }> }>
const allFields = client.ALL_FIELDS as Array<{ key: string; type: string }>
/** 模块级共享草稿构造器（W6 新增 describe 复用；既有 describe 内的同名局部声明遮蔽之）。 */
const draft = client.draftFromSnapshot as (snapshot: { config: Record<string, unknown> }) => Record<string, unknown>

describe('T4 客户端 bundle — 装载契约（CJS 包裹 / externals / 入口导出）', () => {
  it('语法可解析：new Function 直接解析 lib/client.js 全文', () => {
    expect(() => new Function(CLIENT_SOURCE)).not.toThrow()
  })

  it('CJS 包裹形态：banner window.__ModuleLoader__.load({id, factory:(require)=>{ + footer return module.exports', () => {
    expect(CLIENT_SOURCE).toContain('window.__ModuleLoader__.load({')
    expect(CLIENT_SOURCE).toContain('id: "dsh-onebot-qq",')
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
    expect(client.ONEBOT_SETTINGS_REMOTE).toEqual({ package: 'dsh-onebot-qq', descriptors })
    for (const descriptor of descriptors) {
      expect(descriptor.namespace).toBe(NAMESPACE)
      expect(descriptor.service).toBe(NAMESPACE)
      expect(descriptor.method).toBeTypeOf('string')
      expect(descriptor.id).toBe(`dsh-onebot-qq#${NAMESPACE}/${String(descriptor.method)}`)
    }
  })

  it('方法集逐字对齐：getSettings() 0 参；updateSettings(patch, expectedRevision)；listWorkspaces() 0 参（W7），全 positional', () => {
    expect(descriptors.map((descriptor) => descriptor.method)).toEqual(['getSettings', 'updateSettings', 'listWorkspaces'])
    const getSettings = descriptors[0] as { parameters: Array<unknown>; result: { schema: { parse(value: unknown): unknown } } }
    expect(getSettings.parameters).toEqual([])
    const updateSettings = descriptors[1] as { parameters: Array<{ name: string }>; result: { schema: { parse(value: unknown): unknown } } }
    expect(updateSettings.parameters.map((parameter) => parameter.name)).toEqual(['patch', 'expectedRevision'])
    const listWorkspaces = descriptors[2] as { parameters: Array<unknown>; result: { typeSymbol: string; schema: { parse(value: unknown): unknown } } }
    expect(listWorkspaces.parameters).toEqual([])
    expect(listWorkspaces.result.typeSymbol).toBe('WorkspaceListResult')
    // W7：listWorkspaces result codec 可解析 host 形态（available + workspaces 摘要）。
    expect(listWorkspaces.result.schema.parse({ available: true, workspaces: [{ id: 'ws-1', path: '/tmp/ws', sessionCount: 2 }] })).toEqual({
      available: true,
      workspaces: [{ id: 'ws-1', path: '/tmp/ws', sessionCount: 2 }],
    })
    // registry 缺席降级形态同样可解析。
    expect(listWorkspaces.result.schema.parse({ available: false, workspaces: [] })).toEqual({ available: false, workspaces: [] })
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
    expect(parsed.config.workspacePath).toBe('') // W7：26 键含 workspacePath，默认 ''
    expect(parsed.effect).toBe(REMOTE_EFFECT)
  })

  it('result codec 拒绝缺键/多 effect 快照（严格 codec，防宿主契约漂移静默通过）', () => {
    const getSettings = descriptors[0] as { result: { schema: { parse(value: unknown): unknown } } }
    const config: Record<string, unknown> = { ...SCHEMA_DEFAULTS }
    delete config.port
    expect(() => getSettings.result.schema.parse({ revision: 0, entryActive: true, config, secrets: [], groups: SETTINGS_GROUPS, effect: 'restart' })).toThrow()
    expect(() => getSettings.result.schema.parse({ revision: 0, entryActive: true, config: SCHEMA_DEFAULTS, secrets: [], groups: SETTINGS_GROUPS, effect: 'none' })).toThrow()
  })

  it('updateSettings patch codec 接受 29 键任意子集、拒绝非法枚举值', () => {
    const updateSettings = descriptors[1] as { parameters: Array<{ codec: { schema: { parse(value: unknown): unknown } } }> }
    const patchCodec = updateSettings.parameters[0].codec.schema
    expect(patchCodec.parse({ port: 1234 })).toEqual({ port: 1234 })
    expect(patchCodec.parse({ adminUsers: ['10000'], unknownCommand: 'passthrough' })).toEqual({ adminUsers: ['10000'], unknownCommand: 'passthrough' })
    expect(patchCodec.parse({ workspacePath: '/tmp/ws' })).toEqual({ workspacePath: '/tmp/ws' }) // W7：字符串通道
    expect(() => patchCodec.parse({ mode: 'invalid' })).toThrow()
  })
})

describe('T4 客户端 bundle — 四组 29 键（T5 后改子集契约：client 仍是 29 键世界，T8 重写设置页时恢复逐字一致）', () => {
  it('分组与键序对齐 host SETTINGS_GROUPS（T5 子集契约：client 各组键 ⊆ host 同名组，组集仍为 4 组）', () => {
    const hostGroups = SETTINGS_GROUPS as Record<string, string[]>
    for (const [groupId, keys] of Object.entries(client.GROUP_KEYS as Record<string, string[]>)) {
      expect(Object.keys(hostGroups)).toContain(groupId)
      for (const key of keys) expect(hostGroups[groupId]).toContain(key)
    }
    expect(groups.map((group) => group.id)).toEqual(['connection', 'permissions', 'behavior', 'diagnostics'])
    // client 字段键全部存在于 host 键表（无孤儿键）；host 新增键待 T8 进面板
    const clientKeys = allFields.map((field) => field.key)
    for (const key of clientKeys) expect([...ALL_KEYS]).toContain(key)
    expect(allFields).toHaveLength(29) // T2 26→27（newMessagePolicy）、T9 27→28（autoSteerPolicy）、T3 28→29（deferredTimeoutMs）；T5 后 host 扩到 66，client 待 T8
  })

  it('默认值对齐 host SCHEMA_DEFAULTS（T5 后为子集契约：10 个翻转键豁免，待 T8 对齐）', () => {
    // T5 翻转的 10 个默认值：host 已按贡献者值收（用户 m00132 裁定①），client bundle
    // 仍持 T4 前默认，T8 重写设置页时统一——在此之前逐键豁免比对。
    const T5_FLIPPED = new Set(['allowPrivateHosts', 'injectEnabled', 'injectDryRun', 'inboxRedact', 'mode', 'newMessagePolicy', 'interimRecall', 'sendErrorNotice', 'textImageThreshold', 'cardFooter'])
    const hostDefaults = SCHEMA_DEFAULTS as Record<string, unknown>
    for (const [key, value] of Object.entries(client.DEFAULTS as Record<string, unknown>)) {
      expect(key in hostDefaults).toBe(true) // 无孤儿键
      if (!T5_FLIPPED.has(key)) expect(value).toEqual(hostDefaults[key])
    }
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
    expect(enumField('newMessagePolicy')?.options).toEqual(['queue', 'steer'])
    expect(enumField('autoSteerPolicy')?.options).toEqual(['admin', 'all']) // T9：枚举与宿主 ENUM_KEYS 同宽
  })

  it('分组标题与字段 label 为中文（T4 要求）', () => {
    expect(groups.map((group) => group.title)).toEqual(['连接', '权限', '行为', '诊断'])
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

  it('四组各产出标题与逐字段控件行（28 行 obx-field）', () => {
    const sections = renderAll(draft({ config: SCHEMA_DEFAULTS }))
    expect(sections.map((section) => (section.props as Record<string, unknown>)['data-group'])).toEqual(['connection', 'permissions', 'behavior', 'diagnostics'])
    const titles = sections.map((section) => ((section.children[0] as StubElement).children[0] as string))
    expect(titles).toEqual(['连接', '权限', '行为', '诊断'])
    const fieldRows = sections.flatMap((section) => walk(section).filter((element) => element.type === 'div' && element.props.className === 'obx-field'))
    expect(fieldRows).toHaveLength(29)
  })

  it('控件类型齐备：4 枚举下拉 + 3 多行文本 + 11 布尔勾选 + 5 文本框 + 1 密码框（secret 另含清除勾选）', () => {
    const elements = renderAll(draft({ config: SCHEMA_DEFAULTS })).flatMap((section) => walk(section))
    const inputs = elements.filter((element) => element.type === 'input') as Array<StubElement & { props: Record<string, unknown> }>
    const selects = elements.filter((element) => element.type === 'select')
    const textareas = elements.filter((element) => element.type === 'textarea')
    expect(selects).toHaveLength(6) // 5 原有枚举（mode/dmPolicy/groupPolicy/unknownCommand/newMessagePolicy）+ T9 autoSteerPolicy
    expect(textareas).toHaveLength(3)
    expect(inputs.filter((input) => input.props.type === 'checkbox')).toHaveLength(11 + 1) // 11 布尔（5 原有 + 6 W6）+ secret 清除勾选
    expect(inputs.filter((input) => input.props.type === 'text')).toHaveLength(8) // host/port/url/botQQ/workspacePath（W7）+ interimRecallMs/rateLimitPerMinute + T3 deferredTimeoutMs（number 以文本框渲染）
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

  it('仅下发与生效值有差异的键（29 键任意子集）', () => {
    const values = draft({ config: SCHEMA_DEFAULTS })
    values.port = '9999'
    values.mode = 'reverse' // T5 后 host 默认 'forward'，改写 'reverse' 才构成差异
    values.groupAllowFrom = '111\n222'
    const { patch, invalidKeys } = compute(values, SCHEMA_DEFAULTS)
    expect(invalidKeys).toEqual([])
    expect(patch).toEqual({ port: 9999, mode: 'reverse', groupAllowFrom: ['111', '222'] })
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

describe('W6 诊断组 — 6 个观测/调试布尔键的文案契约（中文标签 + 关掉会怎样 + 配置键名）', () => {
  const diagnosticsGroup = groups.find((group) => group.id === 'diagnostics')!
  const NEW_KEYS = ['actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun']

  it('诊断组键集与键序逐字对齐 host SETTINGS_GROUPS.diagnostics', () => {
    expect(diagnosticsGroup.fields.map((field) => field.key)).toEqual(NEW_KEYS)
  })

  it('每个键：中文标签 + hint 含「关掉会怎样」一句话与配置键名（对齐竞品行话术风格）', () => {
    expect(diagnosticsGroup.title).toMatch(/\p{Script=Han}/u)
    for (const field of diagnosticsGroup.fields) {
      expect(field.type).toBe('boolean')
      expect(field.label).toMatch(/\p{Script=Han}/u)
      expect(field.hint).toBeTruthy()
      expect(field.hint).toContain(`（配置键 ${field.key}）`) // 配置键名可追溯
      expect(field.hint!.length).toBeGreaterThan(20) // 一句话「关掉会怎样」而非空占位
    }
    expect(diagnosticsGroup.fields.map((field) => field.label)).toEqual([
      '主动写审计',
      '决策追踪（trace）',
      '入站事件录制',
      '录制脱敏',
      '事件注入（仅调试）',
      '注入 dry-run',
    ])
  })

  it('诊断组默认值与 host SCHEMA_DEFAULTS 一致（T5 前 host 值：actionAuditEnabled/injectDryRun 开，其余关；T5 翻转键豁免待 T8）', () => {
    const defaults = client.DEFAULTS as Record<string, unknown>
    expect(defaults.actionAuditEnabled).toBe(true)
    expect(defaults.injectDryRun).toBe(true) // client 仍持 T4 值；host 已翻转为 false（T5），T8 对齐
    for (const key of ['traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled']) {
      expect(defaults[key]).toBe(false) // client 侧；host 已翻转 inboxRedact/injectEnabled（T5）
    }
    // T5 后 host 扩到 66 键且翻转 10 处默认值，逐字一致契约待 T8 重写设置页恢复；
    // 此处只断言 client 29 键 ⊆ host 且非豁免键值一致。
    const T5_FLIPPED = new Set(['allowPrivateHosts', 'injectEnabled', 'injectDryRun', 'inboxRedact', 'mode', 'newMessagePolicy', 'interimRecall', 'sendErrorNotice', 'textImageThreshold', 'cardFooter'])
    const hostDefaults = SCHEMA_DEFAULTS as Record<string, unknown>
    for (const [key, value] of Object.entries(defaults)) {
      expect(key in hostDefaults).toBe(true)
      if (!T5_FLIPPED.has(key)) expect(value).toEqual(hostDefaults[key])
    }
  })

  it('诊断组渲染为 6 个布尔勾选行；patchCodec 接受 6 新键、拒绝非布尔', () => {
    const values = draft({ config: SCHEMA_DEFAULTS }) as Record<string, unknown>
    values.traceEnabled = true
    values.injectEnabled = false // T5 后 host 默认已翻转为 true，改写 false 才构成差异
    const compute = client.computePatch as (draftValues: Record<string, unknown>, config: Record<string, unknown>) => { patch: Record<string, unknown> }
    expect(compute(values, SCHEMA_DEFAULTS).patch).toEqual({ traceEnabled: true, injectEnabled: false })
    const updateSettings = descriptors[1] as { parameters: Array<{ codec: { schema: { parse(value: unknown): unknown } } }> }
    const patchCodec = updateSettings.parameters[0].codec.schema
    expect(patchCodec.parse({ actionAuditEnabled: false, injectDryRun: false })).toEqual({ actionAuditEnabled: false, injectDryRun: false })
    expect(() => patchCodec.parse({ traceEnabled: 'yes' })).toThrow()
  })
})

describe('W6 「非默认」徽标 — 快照生效值 vs schema 默认值（纯客户端计算）', () => {
  function badges(draftValues: Record<string, unknown>, nonDefaultKeys: string[]) {
    return groups.flatMap((group) => (client.renderGroup as Function)(stubReact, group, {
      draft: draftValues,
      nonDefaultKeys,
      secretSet: false,
      clearSecret: false,
      onChange: () => {},
      onSecretChange: () => {},
      onClearSecretChange: () => {},
    })).flatMap((section) => walk(section)).filter((element) => element.type === 'span' && (element.props as Record<string, unknown>).className === 'obx-badge')
  }

  it('nonDefaultKeys 命中的键打「非默认」徽标，未命中不打', () => {
    const draftValues = draft({ config: SCHEMA_DEFAULTS })
    expect(badges(draftValues, [])).toHaveLength(0)
    const traceBadges = badges(draftValues, ['traceEnabled'])
    expect(traceBadges).toHaveLength(1)
    expect(JSON.stringify(traceBadges[0])).toContain('非默认')
    // 多键命中逐键标注
    expect(badges(draftValues, ['traceEnabled', 'injectEnabled', 'port'])).toHaveLength(3)
  })

  it('徽标数据源是快照生效值（DEFAULTS 对照）：默认快照无任何徽标，改值后对应键出现徽标', () => {
    // 徽标是纯客户端计算（client.DEFAULTS 对照）。T5 后 host SCHEMA_DEFAULTS 与
    // client.DEFAULTS 在 10 个翻转键上暂时分叉（T8 对齐），故默认快照取 client.DEFAULTS 自洽断言。
    const snapshot: Record<string, unknown> = { config: { ...client.DEFAULTS as Record<string, unknown> }, secrets: [] }
    const panelKeys = (config: Record<string, unknown>) => {
      const allFields = client.ALL_FIELDS as Array<{ key: string }>
      const valueEquals = (a: unknown, b: unknown) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)
      const defaults = client.DEFAULTS as Record<string, unknown>
      return allFields.filter((field) => !valueEquals(config[field.key], defaults[field.key])).map((field) => field.key)
    }
    expect(panelKeys(snapshot.config as Record<string, unknown>)).toEqual([])
    expect(panelKeys({ ...client.DEFAULTS, traceEnabled: true, rateLimitPerMinute: 60 })).toEqual(['rateLimitPerMinute', 'traceEnabled'])
  })
})

describe('W6 失败守卫（客户端侧）— host edit-failed 中文错误可渲染且不误判为冲突', () => {
  const unwrap = client.unwrap as (result: unknown) => unknown
  const isConflictError = client.isConflictError as (cause: unknown) => boolean

  it('unwrap({ok:false}) 保留 code 与中文 message（面板 setError(messageOf) 直接可渲染）', () => {
    const rendered = '写入失败：配置文件被其他写入方占用（等待文件锁超时），本次修改未落盘，请稍后重试'
    let caught: unknown
    try {
      unwrap({ ok: false, error: { code: 'onebot-settings/edit-failed', message: rendered } })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(rendered)
    expect((caught as { code?: string }).code).toBe('onebot-settings/edit-failed')
  })

  it('edit-failed 不匹配冲突通道（isConflictError=false → 走通用错误渲染而非重拉重放）', () => {
    const cause = { code: 'onebot-settings/edit-failed', message: '写入失败：宿主 configEditor 拒绝了本次修改' }
    expect(isConflictError(cause)).toBe(false)
    expect(isConflictError({ code: 'onebot-settings/conflict', message: 'expectedRevision mismatch' })).toBe(true)
  })

  it('host patch 白名单 29 键与 client patchSchema 同宽：新键可下发（契约同步核对）', () => {
    const updateSettings = descriptors[1] as { parameters: Array<{ codec: { schema: { parse(value: unknown): unknown } } }> }
    const patch = updateSettings.parameters[0].codec.schema.parse({
      actionAuditEnabled: true, traceEnabled: false, recordInbound: true, inboxRedact: false, injectEnabled: false, injectDryRun: true,
    })
    expect(patch).toEqual({
      actionAuditEnabled: true, traceEnabled: false, recordInbound: true, inboxRedact: false, injectEnabled: false, injectDryRun: true,
    })
  })
})

describe('W7 workspacePath + 「快速填入 workspace」（connection 组新行 + 只填不存的辅助选择器）', () => {
  const fillWorkspacePath = client.fillWorkspacePath as (draft: Record<string, unknown>, path: string) => Record<string, unknown>
  const renderPicker = client.renderWorkspacePicker as (react: unknown, opts: Record<string, unknown>) => StubElement | null

  /** options 里的回调全部换 spy，便于断言「填入只走 onApply、不触保存」。 */
  function pickerOpts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      loaded: true,
      available: true,
      workspaces: [
        { id: 'ws-1', path: '/vol2/ws/alpha', sessionCount: 3 },
        { id: 'ws-2', path: '/vol2/ws/beta', sessionCount: 0 },
      ],
      selectedId: '',
      disabled: false,
      onSelectedChange: () => {},
      onApply: () => {},
      ...overrides,
    }
  }

  it('connection 组追加 workspacePath：键序组尾、中文 label、hint 申明新会话生效与 /workspace 覆盖不受影响', () => {
    const connection = groups.find((group) => group.id === 'connection')!
    expect(connection.fields.map((field) => field.key)).toEqual(['mode', 'host', 'port', 'url', 'accessToken', 'botQQ', 'workspacePath'])
    const workspaceField = connection.fields.find((field) => field.key === 'workspacePath')!
    expect(workspaceField.type).toBe('string')
    expect(workspaceField.label).toMatch(/\p{Script=Han}/u)
    expect(workspaceField.hint).toContain('新会话')
    expect(workspaceField.hint).toContain('/workspace')
    expect(workspaceField.hint).toContain('不受影响')
    expect(workspaceField.hint).toContain('（配置键 workspacePath）')
    expect((client.DEFAULTS as Record<string, unknown>).workspacePath).toBe('')
  })

  it('picker 正常态：select（value=id，label=path（N 会话））+「填入」按钮；未选中时按钮禁用', () => {
    const node = renderPicker(stubReact, pickerOpts())
    expect(node).not.toBeNull()
    expect(node!.props.className).toBe('obx-workspace-row')
    const elements = walk(node)
    const select = elements.find((element) => element.type === 'select')!
    expect(select.props['aria-label']).toBe('快速填入 workspace')
    expect((select.props as Record<string, unknown>).value).toBe('')
    const options = select.children as StubElement[]
    expect(options.map((option) => option.props.value)).toEqual(['', 'ws-1', 'ws-2'])
    expect(options.map((option) => option.children[0])).toEqual(['选择 workspace…', '/vol2/ws/alpha（3 会话）', '/vol2/ws/beta（0 会话）'])
    const button = elements.find((element) => element.type === 'button')!
    expect(button.props.disabled).toBe(true) // 未选中：填入禁用
    expect(button.children[0]).toBe('填入')
    // 选中后按钮可用；title 申明「只填值，保存仍走保存设置」。
    const selected = renderPicker(stubReact, pickerOpts({ selectedId: 'ws-1' }))
    const elements2 = walk(selected!)
    expect(elements2.find((element) => element.type === 'button')!.props.disabled).toBe(false)
    expect(JSON.stringify(selected)).toContain('保存仍走')
  })

  it('「填入」只调 onApply(选中 path)（且不触碰其他回调）——面板接线 onApply=setDraft(fillWorkspacePath(...))，保存仍走显式通道', () => {
    const applied: unknown[] = []
    const selectedChanges: unknown[] = []
    const node = renderPicker(stubReact, pickerOpts({
      selectedId: 'ws-2',
      onApply: (path: string) => { applied.push(path) },
      onSelectedChange: (id: string) => { selectedChanges.push(id) },
    }))
    const elements = walk(node!)
    const button = elements.find((element) => element.type === 'button')!
    button.props.onClick()
    expect(applied).toEqual(['/vol2/ws/beta']) // 填的是 path，不是 id
    expect(selectedChanges).toEqual([]) // 点击填入不触发 select 回调
    // 面板源码接线钉住：onApply 唯一动作是写草稿（fillWorkspacePath），结构上无保存调用。
    expect(CLIENT_SOURCE).toContain('setDraft(fillWorkspacePath(draft, path))')
    // fillWorkspacePath 纯函数：只改 workspacePath 一个键、返回新对象不改入参。
    const base = draft({ config: SCHEMA_DEFAULTS })
    base.botQQ = '10001'
    const filled = fillWorkspacePath(base, '/vol2/ws/alpha')
    expect(filled).toEqual({ ...base, workspacePath: '/vol2/ws/alpha' })
    expect(base.workspacePath).toBe('') // 入参草稿未被就地修改
    expect(filled).not.toBe(base)
    expect(fillWorkspacePath(base, undefined as unknown as string).workspacePath).toBe('') // 防御：nullish → ''
  })

  it('填入后显式保存通道才生效：computePatch 只产出 workspacePath 键，交 host updateSettings', () => {
    const base = draft({ config: SCHEMA_DEFAULTS })
    const filled = fillWorkspacePath(base, '/vol2/ws/alpha')
    const compute = client.computePatch as (draftValues: Record<string, unknown>, config: Record<string, unknown>) => { patch: Record<string, unknown> }
    expect(compute(filled, SCHEMA_DEFAULTS).patch).toEqual({ workspacePath: '/vol2/ws/alpha' })
    // 与默认值相同的值不下发（no-op 语义仍成立）。
    expect(compute(fillWorkspacePath(base, ''), SCHEMA_DEFAULTS).patch).toEqual({})
  })

  it('picker 降级态：未拉取不渲染；registry 缺席/列表为空隐藏下拉与按钮、渲染可直接输入的说明行', () => {
    expect(renderPicker(stubReact, pickerOpts({ loaded: false }))).toBeNull() // 打开面板拉取完成前不渲染
    const unavailable = renderPicker(stubReact, pickerOpts({ available: false, workspaces: [] }))
    expect(unavailable).not.toBeNull()
    expect(unavailable!.props.className).toBe('obx-hint obx-workspace-empty')
    const unavailableText = JSON.stringify(unavailable)
    expect(unavailableText).toContain('无法获取 workspace 列表')
    expect(unavailableText).toContain('可直接输入路径')
    expect(walk(unavailable!).filter((element) => element.type === 'select' || element.type === 'button')).toHaveLength(0)
    const empty = renderPicker(stubReact, pickerOpts({ available: true, workspaces: [] }))
    expect(JSON.stringify(empty)).toContain('暂无 workspace 记录，可直接输入路径。')
    expect(walk(empty!).filter((element) => element.type === 'select' || element.type === 'button')).toHaveLength(0)
  })

  it('renderGroup 经 renderExtraRow 注入 picker：仅在 workspacePath 字段后追加，obx-field 行数不变', () => {
    const connection = groups.find((group) => group.id === 'connection')!
    const render = (opts: Record<string, unknown>) => (client.renderGroup as Function)(stubReact, connection, {
      draft: draft({ config: SCHEMA_DEFAULTS }),
      secretSet: false,
      clearSecret: false,
      onChange: () => {},
      onSecretChange: () => {},
      onClearSecretChange: () => {},
      ...opts,
    })
    const withoutPicker = walk(render({}))
    expect(withoutPicker.filter((element) => element.props.className === 'obx-workspace-row')).toHaveLength(0)
    const withPicker = walk(render({
      renderExtraRow: (field: { key: string }) =>
        field.key === 'workspacePath' ? renderPicker(stubReact, pickerOpts({ selectedId: 'ws-1' })) : null,
    }))
    // 附加行渲染在 workspacePath 之后（connection 组最后一个字段行后），字段行计数不受影响。
    expect(withPicker.filter((element) => element.props.className === 'obx-field')).toHaveLength(7)
    expect(withPicker.filter((element) => element.props.className === 'obx-workspace-row')).toHaveLength(1)
  })
})

describe('T5 批 2 — 交互派生纯函数（computeDirtyKeys / deriveModeInactiveKeys，按文件尾导出惯例可测）', () => {
  const computeDirtyKeys = client.computeDirtyKeys as (
    draftValues: Record<string, unknown>,
    config: Record<string, unknown>,
    opts?: { secretDraft?: string; clearSecret?: boolean },
  ) => string[]
  const deriveModeInactiveKeys = client.deriveModeInactiveKeys as (mode: unknown) => string[]
  const draftOf = (client.draftFromSnapshot as (snapshot: { config: Record<string, unknown> }) => Record<string, unknown>)

  it('dirtyKeys 与保存流同口径（computePatch 键集）：草稿差异 + 密文通道合一；NaN 不入（UX §5.1）', () => {
    const values = draftOf({ config: SCHEMA_DEFAULTS })
    expect(computeDirtyKeys(values, SCHEMA_DEFAULTS)).toEqual([]) // 无脏 → 保存按钮禁用 + 无 badge
    values.port = '9999'
    expect(computeDirtyKeys(values, SCHEMA_DEFAULTS)).toEqual(['port'])
    // 密文通道并入 dirtyKeys：输入新值 / 勾选清除都令 accessToken 入列（互斥由面板 onSecretChange 保证）
    expect(computeDirtyKeys(values, SCHEMA_DEFAULTS, { secretDraft: 'tok', clearSecret: false })).toEqual(['port', 'accessToken'])
    expect(computeDirtyKeys(values, SCHEMA_DEFAULTS, { secretDraft: '', clearSecret: true })).toEqual(['port', 'accessToken'])
    // 数字非法键不进 patch → 不入 dirtyKeys（badNumber 反馈仍走 save() 通道）
    values.interimRecallMs = 'abc'
    expect(computeDirtyKeys(values, SCHEMA_DEFAULTS)).toEqual(['port'])
  })

  it('mode 联动（UX §3.2）：reverse→url、forward→host/port，其余无——禁用≠清空，值保留在草稿', () => {
    expect(deriveModeInactiveKeys('reverse')).toEqual(['url'])
    expect(deriveModeInactiveKeys('forward')).toEqual(['host', 'port'])
    expect(deriveModeInactiveKeys(undefined)).toEqual([])
    expect(deriveModeInactiveKeys('nonsense')).toEqual([])
  })
})

describe('T5 批 2 — 诊断组 details/summary 折叠渲染（UX §3.1：collapsible 配置驱动，缺省保持 section 形态）', () => {
  const diagnostics = groups.find((group) => group.id === 'diagnostics')!
  const draftOf = (client.draftFromSnapshot as (snapshot: { config: Record<string, unknown> }) => Record<string, unknown>)

  function renderWith(opts: Record<string, unknown>): StubElement {
    return (client.renderGroup as Function)(stubReact, diagnostics, {
      draft: draftOf({ config: SCHEMA_DEFAULTS }),
      secretSet: false,
      clearSecret: false,
      onChange: () => {},
      onSecretChange: () => {},
      onClearSecretChange: () => {},
      groupDesc: '观测与调试开关',
      ...opts,
    }) as StubElement
  }

  it('缺省（无 collapsible）保持 section>h3 既有形态；组描述行渲染在标题后', () => {
    const section = renderWith({})
    expect(section.type).toBe('section')
    expect(walk(section).filter((element) => element.props.className === 'obx-field')).toHaveLength(6)
    expect(JSON.stringify(section)).toContain('观测与调试开关')
  })

  it('collapsible 时 details>summary（aria-expanded/controls、open 受控）+ summary meta + 脏标记，字段行不减少', () => {
    const collapsed = renderWith({ collapsible: { open: false, summaryMeta: '6 项 · 2 项默认开' } })
    expect(collapsed.type).toBe('details')
    expect(collapsed.props['data-group']).toBe('diagnostics')
    expect(collapsed.props.open).toBe(false)
    expect(collapsed.props.className).toBe('obx-group obx-group--collapsible')
    const summary = collapsed.children[0] as StubElement
    expect(summary.type).toBe('summary')
    expect(summary.props['aria-expanded']).toBe(false)
    expect(String(summary.props['aria-controls'])).toContain('diagnostics')
    expect(JSON.stringify(summary)).toContain('诊断')
    expect(JSON.stringify(summary)).toContain('6 项 · 2 项默认开')
    expect(JSON.stringify(summary)).not.toContain('含未保存修改') // 无脏改动不打标记
    expect(walk(collapsed).filter((element) => element.props.className === 'obx-field')).toHaveLength(6)
    // 展开 + 含脏改动：aria-expanded 翻转 + 「● 含未保存修改」标记
    const expanded = renderWith({ collapsible: { open: true, summaryMeta: '6 项 · 2 项默认开', dirtyMark: '● 含未保存修改' } })
    const summary2 = expanded.children[0] as StubElement
    expect(summary2.props['aria-expanded']).toBe(true)
    expect(JSON.stringify(summary2)).toContain('● 含未保存修改')
  })
})

describe('T6 批 3 — 冲突合并保留 mergeOnConflict（UX §5.4：远端未变保留草稿、远端已变跟随新快照，纯函数文件尾导出）', () => {
  const mergeOnConflict = client.mergeOnConflict as (
    draftValues: Record<string, unknown> | null,
    oldConfig: Record<string, unknown> | null,
    nextConfig: Record<string, unknown> | null,
  ) => { draft: Record<string, unknown>; conflictKeys: string[]; keptCount: number }
  const computeDirtyKeys = client.computeDirtyKeys as (
    draftValues: Record<string, unknown>,
    config: Record<string, unknown>,
    opts?: { secretDraft?: string; clearSecret?: boolean },
  ) => string[]

  it('无冲突（远端值未变）：全部本地编辑保留（keptCount=N、conflictKeys=[]），纯函数不改入参', () => {
    const before = draft({ config: SCHEMA_DEFAULTS })
    before.port = '9999'
    before.botQQ = '10086'
    before.traceEnabled = true
    const beforeJson = JSON.stringify(before)
    const merged = mergeOnConflict(before, SCHEMA_DEFAULTS, { ...SCHEMA_DEFAULTS })
    expect(merged.conflictKeys).toEqual([])
    expect(merged.keptCount).toBe(3) // 「已保留 3 项未冲突的修改」
    expect(merged.draft.port).toBe('9999') // 展示形态原样保留
    expect(merged.draft.botQQ).toBe('10086')
    expect(merged.draft.traceEnabled).toBe(true) // 布尔草稿形态（非字符串）
    expect(merged.draft).toEqual(before) // 未编辑键逐键保留
    expect(merged.draft).not.toBe(before)
    expect(JSON.stringify(before)).toBe(beforeJson) // 纯函数：不 mutate 入参
    expect(Object.keys(merged.draft)).toHaveLength(Object.keys(client.DEFAULTS as Record<string, unknown>).length) // 合并不丢键（client 29 键世界；host 66 键待 T8 进面板）
  })

  it('部分冲突：远端已变的脏键跟随新快照并入 conflictKeys，其余编辑保留；合并后 computeDirtyKeys 与「N 项未保存」badge 同口径', () => {
    const before = draft({ config: SCHEMA_DEFAULTS })
    before.port = '9999' // 本地改 + 远端也改 → 丢弃草稿、跟随远端（UX §5.4 规则 3）
    before.botQQ = '10086' // 本地改，远端未改 → 保留（UX §5.4 规则 2）
    const next = { ...SCHEMA_DEFAULTS, port: 3000 }
    const merged = mergeOnConflict(before, SCHEMA_DEFAULTS, next)
    expect(merged.conflictKeys).toEqual(['port'])
    expect(merged.keptCount).toBe(1)
    expect(merged.draft.port).toBe('3000') // 跟随新快照（重写为展示形态字符串）
    expect(merged.draft.botQQ).toBe('10086')
    // badge 一致性：合并后的脏键 = 保留的本地编辑（port 已同步新快照不再计脏）
    expect(computeDirtyKeys(merged.draft, next)).toEqual(['botQQ'])
  })

  it('空集边界：无编辑且远端未变 → 零冲突零保留、结果与快照草稿同构；null 入参防御不抛', () => {
    const merged = mergeOnConflict(draft({ config: SCHEMA_DEFAULTS }), SCHEMA_DEFAULTS, { ...SCHEMA_DEFAULTS })
    expect(merged.conflictKeys).toEqual([])
    expect(merged.keptCount).toBe(0)
    expect(merged.draft).toEqual(draft({ config: SCHEMA_DEFAULTS }))
    const defensive = mergeOnConflict(null, null, null)
    expect(defensive.conflictKeys).toEqual([])
    expect(defensive.keptCount).toBe(0)
    expect(defensive.draft).toEqual(draft({ config: {} })) // 缺键防御：与 draftFromSnapshot({config:{}}) 同构
  })

  it('全部脏键被外部修改 → keptCount=0 退化为全量重建；密文例外：accessToken 恒 \'\'（明文通道由调用方清空）', () => {
    const before = draft({ config: SCHEMA_DEFAULTS })
    before.port = '9999'
    before.botQQ = '10086'
    before.accessToken = 'typed-secret' // 面板 onSecretChange 会把明文写进草稿——合并必须压回 ''
    const next = { ...SCHEMA_DEFAULTS, port: 3000, botQQ: '22222' }
    const merged = mergeOnConflict(before, SCHEMA_DEFAULTS, next)
    expect(merged.conflictKeys).toEqual(['port', 'botQQ']) // ALL_FIELDS 键序
    expect(merged.keptCount).toBe(0)
    expect(merged.draft.port).toBe('3000')
    expect(merged.draft.botQQ).toBe('22222')
    expect(merged.draft.accessToken).toBe('')
    expect(merged.draft).toEqual(draft({ config: next })) // 与全量重建同值（UX §5.4 规则 5 退化路径）
  })

  it('远端已变但本地未编辑的键静默跟随（不打橙标）；stringArray 以换行 join 展示形态重写', () => {
    const before = draft({ config: SCHEMA_DEFAULTS })
    before.rateLimitPerMinute = '60'
    const merged = mergeOnConflict(before, SCHEMA_DEFAULTS, { ...SCHEMA_DEFAULTS, adminUsers: ['10086', '22222'] })
    expect(merged.conflictKeys).toEqual([])
    expect(merged.keptCount).toBe(1)
    expect(merged.draft.adminUsers).toBe('10086\n22222')
    expect(merged.draft.rateLimitPerMinute).toBe('60')
    // 本地也编辑的 stringArray → 冲突键（跟随远端新值）
    const before2 = draft({ config: SCHEMA_DEFAULTS })
    before2.adminUsers = '30000'
    const merged2 = mergeOnConflict(before2, SCHEMA_DEFAULTS, { ...SCHEMA_DEFAULTS, adminUsers: ['10086'] })
    expect(merged2.conflictKeys).toEqual(['adminUsers'])
    expect(merged2.draft.adminUsers).toBe('10086')
  })

  it('面板接线（源码断言）：save 冲突分支走 refetchMerged 合并而非全量重建；横幅/橙标/密文清空落位', () => {
    expect(CLIENT_SOURCE).toContain('mergeOnConflict(draft, snapshot == null ? null : snapshot.config, next.config)')
    expect(CLIENT_SOURCE).toContain('setConflictKeys(merged.conflictKeys)')
    expect(CLIENT_SOURCE).toContain('setConflictActive(true)')
    expect(CLIENT_SOURCE).toContain('format(t("conflict.kept"), { count: merged.keptCount })')
    expect(CLIENT_SOURCE).toContain('t("conflict.secretCleared")')
    // locale zh/en 齐平的 4 新键落位（assertSameKeys 装载自检之外逐字钉住）
    expect(CLIENT_SOURCE).toContain('"conflict.kept": "已保留 {count} 项未冲突的修改，请核对后重新保存。"')
    expect(CLIENT_SOURCE).toContain('"conflict.kept": "Kept {count} non-conflicting change(s) — review and save again."')
  })
})

describe('T6 批 3 — 数字行内校验（UX §5.6：blur 触发、非法标红 + 合法范围提示、修正自动消除、保存按钮禁用兜底）', () => {
  const NUMBER_RANGE = client.NUMBER_RANGE as Record<string, [number, number | undefined]>
  const numberRangeInvalid = client.numberRangeInvalid as (
    field: { key: string; type: string } | null | undefined,
    raw: unknown,
  ) => string | null
  const connection = groups.find((group) => group.id === 'connection')!

  function renderConnection(opts: Record<string, unknown>): StubElement {
    return (client.renderGroup as Function)(stubReact, connection, {
      draft: draft({ config: SCHEMA_DEFAULTS }),
      secretSet: false,
      clearSecret: false,
      onChange: () => {},
      onSecretChange: () => {},
      onClearSecretChange: () => {},
      ...opts,
    }) as StubElement
  }
  const numberInput = (section: StubElement) =>
    walk(section).find((element) => String(element.props.className).includes('obx-input--number'))!

  it('NUMBER_RANGE 逐字对齐 host 常量（src/settings-remote.ts L129-134 字面量副本，不改 host）且覆盖全部数字键', () => {
    expect(NUMBER_RANGE).toStrictEqual({
      port: [1, 65535],
      interimRecallMs: [0, undefined],
      rateLimitPerMinute: [0, undefined],
      deferredTimeoutMs: [0, undefined],
    })
    expect(Object.keys(NUMBER_RANGE)).toEqual(allFields.filter((field) => field.type === 'number').map((field) => field.key))
    expect(CLIENT_SOURCE).toContain('src/settings-remote.ts L129-134') // 来源行号注明
  })

  it('numberRangeInvalid 与 host validatePatch 同语义：越界/NaN 判非法返回范围文案，边界含端点；非 number 不校验', () => {
    const portField = allFields.find((field) => field.key === 'port')!
    const recallField = allFields.find((field) => field.key === 'interimRecallMs')!
    expect(numberRangeInvalid(portField, '70000')).toBe('1–65535')
    expect(numberRangeInvalid(portField, '0')).toBe('1–65535')
    expect(numberRangeInvalid(portField, '3000')).toBeNull()
    expect(numberRangeInvalid(portField, '1')).toBeNull() // 下边界含
    expect(numberRangeInvalid(portField, '65535')).toBeNull() // 上边界含
    expect(numberRangeInvalid(portField, 'abc')).toBe('1–65535') // NaN 判非法
    expect(numberRangeInvalid(portField, '')).toBe('1–65535') // Number('')=0 越下界（与 coerceValue/host 同口径）
    expect(numberRangeInvalid(recallField, '-1')).toBe('≥0')
    expect(numberRangeInvalid(recallField, '0')).toBeNull()
    expect(numberRangeInvalid(recallField, '1e9')).toBeNull() // 无上限
    expect(numberRangeInvalid(null, 'x')).toBeNull() // 防御
    expect(numberRangeInvalid({ key: 'botQQ', type: 'string' }, 'x')).toBeNull() // 非 number 不校验
  })

  it('越界标红：number 输入挂 obx-input--invalid + aria-invalid + hint 行内红字合法范围；未命中键无痕迹', () => {
    const marked = renderConnection({ invalidNumbers: { port: '必须是 1–65535 的有限数字' } })
    const input = numberInput(marked)
    expect(String(input.props.className)).toContain('obx-input--invalid')
    expect(input.props['aria-invalid']).toBe('true')
    const invalidHint = walk(marked).find((element) => element.props.className === 'obx-hint--invalid')
    expect(invalidHint!.children[0]).toBe('必须是 1–65535 的有限数字')
    // 未命中键（botQQ 文本输入）不受影响
    const plain = walk(marked).find((element) => element.props.className === 'obx-input')!
    expect(plain.props['aria-invalid']).toBeUndefined()
    // 合法状态：无标红无红字
    const clean = numberInput(renderConnection({}))
    expect(String(clean.props.className)).not.toContain('obx-input--invalid')
    expect(clean.props['aria-invalid']).toBeUndefined()
    expect(JSON.stringify(renderConnection({}))).not.toContain('obx-hint--invalid')
  })

  it('blur 触发校验：number 键 onBlur 调 onNumberBlur(field, raw)（文本输入无 onBlur），标红不阻断输入', () => {
    const blurred: Array<[string, string]> = []
    const section = renderConnection({
      onNumberBlur: (field: { key: string }, raw: string) => { blurred.push([field.key, raw]) },
    })
    const portInput = numberInput(section)
    expect(typeof portInput.props.onBlur).toBe('function')
    ;(portInput.props.onBlur as (event: { target: { value: string } }) => void)({ target: { value: '70000' } })
    expect(blurred).toEqual([['port', '70000']])
    const botInput = walk(section).find((element) => element.props.className === 'obx-input')!
    expect(botInput.props.onBlur).toBeUndefined() // 非 number 不加 blur
    expect(typeof portInput.props.onChange).toBe('function') // 标红不阻断输入
  })

  it('冲突橙标：remoteOverwrittenKeys 命中字段 hint 行内嵌 warning「已被其他来源修改，已同步为最新值」，未命中不渲染', () => {
    const section = renderConnection({ remoteOverwrittenKeys: ['botQQ'] })
    const warnHints = walk(section).filter((element) => element.props.className === 'obx-hint--warn')
    expect(warnHints.map((element) => element.children[0])).toEqual(['已被其他来源修改，已同步为最新值'])
    // texts 缺省回退 zh 字面量（上文未传 texts）；显式 texts 可覆盖
    const custom = renderConnection({ remoteOverwrittenKeys: ['port'], texts: { remoteOverwritten: '远端已更新' } })
    expect(JSON.stringify(custom)).toContain('远端已更新')
    expect(walk(custom).filter((element) => element.props.className === 'obx-hint--warn')).toHaveLength(1)
    expect(JSON.stringify(renderConnection({}))).not.toContain('已被其他来源修改，已同步为最新值')
  })

  it('面板接线（源码断言）：blur 记态/修正自动消除/冲突键编辑撤销/合并后修剪/保存禁用 + title 落位', () => {
    expect(CLIENT_SOURCE).toContain('onNumberBlur: handleNumberBlur')
    expect(CLIENT_SOURCE).toContain('if (field.type === "number" && invalidNumbers[field.key] != null) handleNumberBlur(field, nextValue);')
    expect(CLIENT_SOURCE).toContain('if (conflictKeys.indexOf(field.key) >= 0) setConflictKeys(conflictKeys.filter(function (key) { return key !== field.key; }));')
    expect(CLIENT_SOURCE).toContain('numberRangeInvalid(field, merged.draft[key]) != null') // 合并后按结果修剪标红
    expect(CLIENT_SOURCE).toContain('disabled: busy || dirtyCount === 0 || invalidNumberCount > 0')
    expect(CLIENT_SOURCE).toContain('title: invalidNumberCount > 0')
    expect(CLIENT_SOURCE).toContain('conflictActive ? " obx-error--conflict"') // 冲突横幅显式状态挂样式
    expect(CLIENT_SOURCE).toContain('"field.numberInvalid": "必须是 {range} 的有限数字"')
    expect(CLIENT_SOURCE).toContain('"field.numberInvalid": "Must be a finite number {range}"')
  })
})
