/**
 * 客户端设置页 UI bundle 测试（T8 · 贡献者 0.9.19 版重写；0.10.0 视觉对齐更新）。
 *
 * 验证 src/client.ts（构建产物 lib/client.js，CJS 包裹挂 window.__ModuleLoader__）
 * 的模块级契约：
 *   ① 语法可解析（new Function）+ CJS banner/footer 形态 + externals = react 与
 *      宿主 UI 原语 seed 模块（@deepseek-ai/dsh-client-ui-primitives，缺失回落 shim）；
 *   ② 入口导出 inject + apply；T11 侧边栏入口成对注册（main + sidebar.panellist 同 id）；
 *   ③ 六组 69 键：分组/键序/默认值与宿主侧 src/settings-remote.ts 导出常量逐字
 *      一致（descriptor 契约核对，防两侧漂移）；notices 为 5 真键（无贡献者 newSession）；
 *   ④ Typert descriptor 与宿主服务方法面逐字对齐：getSettings() /
 *      updateSettings(patch, expectedRevision) / listWorkspaces()，全 positional，
 *      patch/config codec 覆盖全部 71 键（防客户端网关按 schema 剥键丢编辑）；
 *   ⑤ 渲染函数模块级可测：renderGroup 纯函数产出 69 键控件行，控件经 opts.ui 依赖
 *      注入（测试用桩，宿主 primitives / 回落 shim 同契约）；showIf 条件显隐；
 *      accessToken 密码型输入且不明文回显；布尔行 Switch 左右布局；
 *      notices 行为组按 newMessagePolicy 档位显隐；
 *   ⑥ W6「非默认」徽标对所有类型键挂标（title=与默认值不同，经 ui.Tag）；
 *   ⑦ 0.10.0：诊断组折叠随页签式导航移除（无 details/summary、无 sessionStorage）；
 *   ⑧ 保存语义：computePatch 产出差异子集 patch；stringArray 宽分隔符；数字非法键
 *      不进 patch；mergeOnConflict 冲突合并；数字行内校验（NUMBER_RANGE 对齐 host，
 *      校验时机 = onChange 即时）。
 *
 * @module dsh-onebot/tests/client-settings
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  ALL_KEYS,
  NAMESPACE,
  NOTICE_KEYS,
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
/** 顶层字段行计数：只认精确 className，避免嵌套 obx-field-text 误计。 */
function topFieldRows(section: StubElement): StubElement[] {
  const out: StubElement[] = []
  const scan = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (node && typeof node === 'object' && (node as StubElement).type !== undefined) {
        const element = node as StubElement
        const className = String(element.props.className ?? '')
        if (className === 'obx-field' || className === 'obx-field obx-field--row') out.push(element)
        else scan(element.children ?? [])
      }
    }
  }
  scan(section.children ?? [])
  return out
}

/** ui 组件桩：与宿主 primitives / 回落 shim 同 props 契约（见 src/client.ts fallbackUi 注释）。 */
const stubUiComponent = (name: string) => {
  const component = (props: Record<string, unknown>) => stubReact.createElement(`ui-${name}`, props)
  return component
}
const stubUi = {
  Switch: stubUiComponent('switch'),
  Checkbox: stubUiComponent('checkbox'),
  Tag: stubUiComponent('tag'),
  Button: stubUiComponent('button'),
  SegmentedControl: stubUiComponent('segmented'),
  SegmentedTabs: stubUiComponent('tabs'),
  Input: stubUiComponent('input'),
}

/** CJS 包裹装载：模拟 window.__ModuleLoader__.load + require 外部表（react + 宿主原语 seed）。 */
function loadClientModule(): Record<string, unknown> {
  const factories: Record<string, (request: (spec: string) => unknown) => unknown> = {}
  const globalWithWindow = globalThis as unknown as { window?: { __ModuleLoader__: unknown } }
  globalWithWindow.window = { __ModuleLoader__: { load: (entry: { id: string; factory: (request: (spec: string) => unknown) => unknown }) => { factories[entry.id] = entry.factory } } }
  // 求值 bundle 源码：new Function 体在调用时经全局 window 找到 ModuleLoader 桩完成注册。
  new Function(CLIENT_SOURCE)()
  const factory = factories['dsh-onebot-qq']
  if (factory === undefined) throw new Error('lib/client.js 未注册 dsh-onebot-qq 模块')
  return factory((spec: string) => {
    if (spec === 'react') return stubReact
    // 宿主原语 seed 模块在测试环境缺席：bundle 侧 try/catch 回落 shim（同旧宿主路径）
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('seed 表缺席（测试环境）')
    throw new Error(`unexpected external require: ${spec}`)
  }) as Record<string, unknown>
}

const client = loadClientModule()
const descriptors = client.ONEBOT_SETTINGS_DESCRIPTORS as Array<Record<string, unknown>>
const groups = client.GROUPS as Array<{ id: string; title: string; fields: Array<{ key: string; label: string; type: string; options?: string[]; hint?: string; showIf?: { key: string; value: unknown } }> }>
const allFields = client.ALL_FIELDS as Array<{ key: string; type: string; showIf?: { key: string; value: unknown } }>
const draft = client.draftFromSnapshot as (snapshot: { config: Record<string, unknown> }) => Record<string, unknown>
const defaults = client.DEFAULTS as Record<string, unknown>

/** 宿主形态快照 config：SCHEMA_DEFAULTS 全 71 键（含 notices + chatIdleEvictDays），accessToken 按脱敏约定为 ''。 */
const SNAPSHOT_CONFIG: Record<string, unknown> = { ...SCHEMA_DEFAULTS, accessToken: '' }
const baseDraft = () => draft({ config: SNAPSHOT_CONFIG })
const renderGroup = (groupId: string, opts: Record<string, unknown>) =>
  (client.renderGroup as Function)(stubReact, groups.find((entry) => entry.id === groupId), {
    draft: baseDraft(),
    ui: stubUi,
    onChange: () => {},
    onSecretChange: () => {},
    onClearSecretChange: () => {},
    ...opts,
  }) as StubElement
const flat = (section: StubElement) => JSON.stringify(walk(section))

describe('T8 客户端 bundle — 装载契约（CJS 包裹 / externals / 入口导出）', () => {
  it('语法可解析：new Function 直接解析 lib/client.js 全文', () => {
    expect(() => new Function(CLIENT_SOURCE)).not.toThrow()
  })

  it('CJS 包裹形态：banner window.__ModuleLoader__.load({id, factory:(require)=>{ + footer return module.exports', () => {
    expect(CLIENT_SOURCE).toContain('window.__ModuleLoader__.load({')
    expect(CLIENT_SOURCE).toContain('id: "dsh-onebot-qq",')
    expect(CLIENT_SOURCE).toContain('factory: (require) => {')
    // tsc 重排印后 footer 缩进为空格（源 src/client.ts 为 tab）。
    expect(CLIENT_SOURCE.trimEnd().endsWith('return module.exports;\n    }\n});')).toBe(true)
  })

  it('externals = react + 宿主 UI 原语 seed 模块（缺失时 try/catch 回落 shim）', () => {
    const requireCalls = CLIENT_SOURCE.match(/require\s*\(/g) ?? []
    const reactCalls = CLIENT_SOURCE.match(/require\s*\(\s*["']react["']\s*\)/g) ?? []
    expect(reactCalls.length).toBe(1)
    expect(CLIENT_SOURCE).toContain('require(HOST_PRIMITIVES_ID)')
    expect(CLIENT_SOURCE).toContain('@deepseek-ai/dsh-client-ui-primitives')
    expect(requireCalls.length).toBe(reactCalls.length + 1) // 恰一处宿主原语 require（try/catch 包裹）
    expect(requireCalls.length).toBeGreaterThan(0)
  })

  it('入口导出 inject（宿主客户端服务名数组）+ apply(ctx)', () => {
    expect(client.inject).toEqual(['slots', 'locale', 'remote'])
    expect(typeof client.apply).toBe('function')
    expect(typeof client.OnebotSettingsPanel).toBe('function')
  })

  it('无 node:/npm 运行时依赖；@deepseek-ai 仅允许宿主原语 seed 模块', () => {
    expect(CLIENT_SOURCE).not.toMatch(/require\s*\(\s*["'](node:|schemastery)/)
    expect(CLIENT_SOURCE).not.toMatch(/require\s*\(\s*["']@deepseek-ai\/(?!dsh-client-ui-primitives")/)
    expect(CLIENT_SOURCE).not.toMatch(/\bimport\s/)
  })

  it('T11 边界：侧边栏入口图标为自绘 SVG（QQ 专属图形，非宿主图标表）', () => {
    expect(CLIENT_SOURCE).toContain('sidebar.panellist') // T11：侧边栏列表槽注入
    expect(CLIENT_SOURCE).toContain('OnebotSidebarIcon')
    expect(CLIENT_SOURCE).toContain('SIDEBAR_PANEL_ID')
    expect(client.OnebotSidebarIcon).toBeTypeOf('function')
    expect(client.SIDEBAR_PANEL_ID).toBe('qq-bot')
    expect(CLIENT_SOURCE).toContain('ui-native') // 面板构建标记（0.10.0 原生 UI 重写）
  })
})

describe('T8 客户端 bundle — descriptor 契约核对（与宿主 src/settings-remote.ts 逐字对齐）', () => {
  it('namespace/service = onebotSettings，与宿主 NAMESPACE 常量一致', () => {
    expect(client.ONEBOT_SETTINGS_REMOTE).toEqual({ package: 'dsh-onebot-qq', descriptors })
    for (const descriptor of descriptors) {
      expect(descriptor.namespace).toBe(NAMESPACE)
      expect(descriptor.service).toBe(NAMESPACE)
      expect(descriptor.method).toBeTypeOf('string')
      expect(descriptor.id).toBe(`dsh-onebot-qq#${NAMESPACE}/${String(descriptor.method)}`)
    }
  })

  it('方法集逐字对齐：getSettings() 0 参；updateSettings(patch, expectedRevision)；listWorkspaces() 0 参，全 positional', () => {
    expect(descriptors.map((descriptor) => descriptor.method)).toEqual(['getSettings', 'updateSettings', 'listWorkspaces'])
    const getSettings = descriptors[0] as { parameters: Array<unknown>; result: { schema: { parse(value: unknown): unknown } } }
    expect(getSettings.parameters).toEqual([])
    const updateSettings = descriptors[1] as { parameters: Array<{ name: string }>; result: { schema: { parse(value: unknown): unknown } } }
    expect(updateSettings.parameters.map((parameter) => parameter.name)).toEqual(['patch', 'expectedRevision'])
    const listWorkspaces = descriptors[2] as { parameters: Array<unknown>; result: { typeSymbol: string; schema: { parse(value: unknown): unknown } } }
    expect(listWorkspaces.parameters).toEqual([])
    expect(listWorkspaces.result.typeSymbol).toBe('WorkspaceListResult')
    expect(listWorkspaces.result.schema.parse({ available: true, workspaces: [{ id: 'ws-1', path: '/tmp/ws', sessionCount: 2 }] })).toEqual({
      available: true,
      workspaces: [{ id: 'ws-1', path: '/tmp/ws', sessionCount: 2 }],
    })
    expect(listWorkspaces.result.schema.parse({ available: false, workspaces: [] })).toEqual({ available: false, workspaces: [] })
  })

  it('result codec 可解析宿主形态快照（71 键 config 含 notices/chatIdleEvictDays + secrets 脱敏标记 + groups + effect=restart）', () => {
    const getSettings = descriptors[0] as { result: { schema: { parse(value: unknown): unknown } } }
    const snapshot = {
      revision: 3,
      entryActive: true,
      config: { ...SNAPSHOT_CONFIG },
      secrets: SECRET_KEYS.map((key) => ({ path: [key], set: key === 'accessToken' })),
      groups: SETTINGS_GROUPS,
      effect: REMOTE_EFFECT,
    }
    const parsed = getSettings.result.schema.parse(snapshot) as { config: Record<string, unknown> }
    expect(parsed.config.accessToken).toBe('')
    // T6/T7 转正键不被客户端 codec 剥掉（防网关按 schema 剥键丢编辑）
    expect(parsed.config.gifFramesEnabled).toBe(false)
    expect(parsed.config.inboxQueueEnabled).toBe(false)
    expect(parsed.config.inboxQueueDelayMs).toBe(600)
    expect(parsed.config.titleSyncEnabled).toBe(false) // T24
    expect(parsed.config.notices).toEqual(SCHEMA_DEFAULTS.notices)
  })

  it('result codec 拒绝缺键/多 effect 快照（严格 codec，防宿主契约漂移静默通过）', () => {
    const getSettings = descriptors[0] as { result: { schema: { parse(value: unknown): unknown } } }
    const missing = { ...SNAPSHOT_CONFIG }
    delete missing.port
    expect(() => getSettings.result.schema.parse({ revision: 0, entryActive: true, config: missing, secrets: [], groups: SETTINGS_GROUPS, effect: 'restart' })).toThrow()
    expect(() => getSettings.result.schema.parse({ revision: 0, entryActive: true, config: SNAPSHOT_CONFIG, secrets: [], groups: SETTINGS_GROUPS, effect: 'none' })).toThrow()
  })

  it('updateSettings patch codec 接受全 71 键任意子集（含 T6/T7 转正键与 notices）、拒绝非法值', () => {
    const updateSettings = descriptors[1] as { parameters: Array<{ codec: { schema: { parse(value: unknown): unknown } } }> }
    const patchCodec = updateSettings.parameters[0].codec.schema
    expect(patchCodec.parse({ port: 1234, mode: 'reverse' })).toEqual({ port: 1234, mode: 'reverse' })
    expect(patchCodec.parse({ gifFramesEnabled: true, inboxQueueEnabled: true, inboxQueueDelayMs: 800 })).toEqual({
      gifFramesEnabled: true,
      inboxQueueEnabled: true,
      inboxQueueDelayMs: 800,
    })
    // T24：标题同步开关进 patch codec（防网关剥键丢编辑）。
    expect(patchCodec.parse({ titleSyncEnabled: true })).toEqual({ titleSyncEnabled: true })
    expect(() => patchCodec.parse({ titleSyncEnabled: 'yes' })).toThrow()
    expect(patchCodec.parse({ forceSessionId: 'abc123' })).toEqual({ forceSessionId: 'abc123' })
    expect(patchCodec.parse({ notices: { queue: '自定义', answerAccepted: false } })).toEqual({ notices: { queue: '自定义', answerAccepted: false } })
    expect(() => patchCodec.parse({ mode: 'invalid' })).toThrow()
    expect(() => patchCodec.parse({ gifFramesEnabled: 'yes' })).toThrow()
    expect(() => patchCodec.parse({ notices: { queue: 5 } })).toThrow()
  })
})

describe('T8 客户端 bundle — 六组 69 键（与 host SETTINGS_GROUPS 逐字一致，T8 恢复全等契约）', () => {
  it('分组键序逐字对齐 host SETTINGS_GROUPS（6 组 69 键，含 T6/T7 转正键、T11 sidebarEntryEnabled 与 T24 titleSyncEnabled）', () => {
    expect(client.GROUP_KEYS).toStrictEqual(SETTINGS_GROUPS)
    expect(groups.map((group) => group.id)).toEqual(['connection', 'permissions', 'behavior', 'session', 'media', 'diagnostics'])
    expect(allFields).toHaveLength(69)
    const clientKeys = allFields.map((field) => field.key)
    expect(new Set(clientKeys).size).toBe(69) // 无重复
    for (const key of clientKeys) expect([...ALL_KEYS]).toContain(key) // 无孤儿键
    // T6/T7 新增键落位
    expect(groups.find((group) => group.id === 'media')!.fields.map((field) => field.key)).toContain('gifFramesEnabled')
    expect(groups.find((group) => group.id === 'behavior')!.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(['inboxQueueEnabled', 'inboxQueueDelayMs']),
    )
    // T24：标题同步开关落位 behavior 组
    expect(groups.find((group) => group.id === 'behavior')!.fields.map((field) => field.key)).toContain('titleSyncEnabled')
    // T11：侧边栏入口开关落位 connection 组
    expect(groups.find((group) => group.id === 'connection')!.fields.map((field) => field.key)).toContain('sidebarEntryEnabled')
  })

  it('默认值逐字对齐 host SCHEMA_DEFAULTS（T8 恢复全等，无豁免；notices 走面板 5 真键不在 DEFAULTS）', () => {
    const hostDefaults = SCHEMA_DEFAULTS as Record<string, unknown>
    expect(Object.keys(defaults)).toHaveLength(70) // 69 面板键 + chatIdleEvictDays
    expect('notices' in defaults).toBe(false) // notices 由 NOTICE_KEYS 面板通道承载
    expect(defaults.chatIdleEvictDays).toBe(hostDefaults.chatIdleEvictDays) // 不上面板但参与徽标对照
    expect(defaults.sidebarEntryEnabled).toBe(true) // T11：侧边栏入口默认开（用户裁定）
    expect(defaults.titleSyncEnabled).toBe(false) // T24：标题同步默认关（用户裁定）
    for (const [key, value] of Object.entries(defaults)) {
      expect(key in hostDefaults).toBe(true) // 无孤儿键
      expect(value).toEqual(hostDefaults[key])
    }
  })

  it('字段类型与 host 默认值形态一致；枚举字段选项覆盖默认值（9 枚举与宿主 ENUM_KEYS 同宽）', () => {
    for (const field of allFields) {
      const fallback = SCHEMA_DEFAULTS[field.key]
      if (field.type === 'boolean') expect(typeof fallback).toBe('boolean')
      else if (field.type === 'number') expect(typeof fallback).toBe('number')
      else if (field.type === 'enum') expect(field.options ?? []).toContain(fallback)
      else if (field.type === 'stringArray') expect(Array.isArray(fallback)).toBe(true)
      else expect(field.type === 'string' || field.type === 'secret').toBe(true)
    }
    const enumField = (key: string) => groups.flatMap((group) => group.fields).find((field) => field.key === key)
    expect(enumField('mode')?.options).toEqual(['reverse', 'forward'])
    expect(enumField('dmPolicy')?.options).toEqual(['open', 'allowlist', 'disabled'])
    expect(enumField('groupPolicy')?.options).toEqual(['open', 'allowlist', 'disabled'])
    expect(enumField('unknownCommand')?.options).toEqual(['intercept', 'passthrough'])
    expect(enumField('newMessagePolicy')?.options).toEqual(['queue', 'steer'])
    expect(enumField('autoSteerPolicy')?.options).toEqual(['admin', 'all'])
    expect(enumField('faceStyle')?.options).toEqual(['name', 'emoji'])
    expect(enumField('logLevel')?.options).toEqual(['debug', 'info', 'warn', 'error'])
    expect(enumField('sttEngine')?.options).toEqual(['auto', 'openai', 'whisper-cpp', 'custom'])
  })

  it('分组标题与字段 label 为中文（T8 要求：贡献者口语短文案 × 中文）', () => {
    expect(groups.map((group) => group.title)).toEqual(['连接', '权限', '行为', '会话', '媒体', '诊断'])
    for (const field of allFields) expect(field.label).toMatch(/\p{Script=Han}/u)
  })

  it('accessToken 是唯一 secret 字段（脱敏约定：密码型输入 + 不明文回显）', () => {
    const secretFields = allFields.filter((field) => field.type === 'secret')
    expect(secretFields.map((field) => field.key)).toEqual([...SECRET_KEYS])
  })
})

describe('T8 notices 面板 — 5 真键（本仓 schema 无贡献者 newSession）', () => {
  it('草稿含 5 个 notices.* 键，与 host NOTICE_KEYS 一一对应', () => {
    const draftKeys = Object.keys(baseDraft()).filter((key) => key.startsWith('notices.')).map((key) => key.slice('notices.'.length))
    expect(draftKeys).toEqual([...NOTICE_KEYS])
  })

  it('默认（policy=steer）：behavior 组显 插话/回答/超时补发/限流 4 条通知，不显排队提示；session 组无通知行', () => {
    const behavior = flat(renderGroup('behavior', { onNoticeChange: () => {} }))
    expect(behavior).toContain('插话提示')
    expect(behavior).toContain('回答回执')
    expect(behavior).toContain('超时补发提示')
    expect(behavior).toContain('限流提示')
    expect(behavior).not.toContain('排队提示')
    expect(flat(renderGroup('session', {}))).not.toContain('提示')
  })

  it('policy=queue 档位切换：显排队提示、隐插话提示（贡献者三元组面板语义保留到真键）', () => {
    const section = renderGroup('behavior', { draft: { ...baseDraft(), newMessagePolicy: 'queue' }, onNoticeChange: () => {} })
    const rendered = flat(section)
    expect(rendered).toContain('排队提示')
    expect(rendered).not.toContain('插话提示')
  })

  it('通知行 = Switch 桩开关 + 开启时文案 textarea（aria-label=「XX提示文案」）', () => {
    const elements = walk(renderGroup('behavior', { onNoticeChange: () => {} }))
    const switches = elements.filter((element) => element.type === stubUi.Switch && String(element.props.label ?? '').includes('提示'))
    expect(switches.length).toBeGreaterThanOrEqual(3)
    const textareas = elements.filter((element) => element.type === 'textarea' && String(element.props['aria-label'] ?? '').endsWith('文案'))
    expect(textareas).toHaveLength(4)
  })

  it('computePatch notices 增量：自定义文案下发 string、恢复默认文案下发 true、关闭下发 false', () => {
    const compute = client.computePatch as (
      draftValues: Record<string, unknown>,
      config: Record<string, unknown>,
      opts?: { secretDraft?: string; clearSecret?: boolean },
    ) => { patch: Record<string, unknown>; invalidKeys: string[] }
    const queueDef = '⏳ 当前任务运行中，新消息已排队，将在当前任务结束后依次处理。'
    const values = baseDraft()
    values['notices.queue'] = { on: true, text: '自定义排队文案' }
    const custom = compute(values, SNAPSHOT_CONFIG)
    // notices 增量合并进 patch.notices：未动键按 draftToNotice 归一为 true（= 默认文案），动的键下发自定义 string
    expect(custom.patch.notices).toEqual({ steerAccepted: true, queue: '自定义排队文案', answerAccepted: true, deferredTimeout: true, rateLimited: true })
    const values2 = baseDraft()
    values2['notices.steerAccepted'] = { on: true, text: '✅ 已作为补充指令提交给当前任务，模型将在下一步读取。' } // == 默认文案 → true == 当前生效值 → 无差异，notices 不进 patch
    expect(compute(values2, SNAPSHOT_CONFIG).patch.notices).toBeUndefined()
    const values3 = baseDraft()
    values3['notices.answerAccepted'] = { on: false, text: '' }
    expect(compute(values3, SNAPSHOT_CONFIG).patch.notices).toEqual({ steerAccepted: true, queue: true, answerAccepted: false, deferredTimeout: true, rateLimited: true })
  })
})

describe('T8 showIf 条件显隐 — 贡献者面板交互契约', () => {
  const connection = groups.find((group) => group.id === 'connection')!
  const visibleLabels = (groupId: string, draftOverrides: Record<string, unknown>) => {
    const section = renderGroup(groupId, { draft: { ...baseDraft(), ...draftOverrides } })
    return walk(section).flatMap((element) => {
      if (element.props.className === 'obx-label') return [element.children[0]]
      // 文本/分段控件的 label 在 ui 桩 props 上（原生组件自渲染 label）
      if (element.type === stubUi.Input || element.type === stubUi.SegmentedControl) return [element.props.label]
      return []
    })
  }

  it('mode 联动：forward 显 url 隐 host/port；reverse 显 host/port 隐 url', () => {
    const forward = visibleLabels('connection', { mode: 'forward' })
    expect(forward).toContain('正向 WS 服务器地址')
    expect(forward).not.toContain('反向 WS 监听地址')
    expect(forward).not.toContain('反向 WS 监听端口')
    const reverse = visibleLabels('connection', { mode: 'reverse' })
    expect(reverse).toContain('反向 WS 监听地址')
    expect(reverse).toContain('反向 WS 监听端口')
    expect(reverse).not.toContain('正向 WS 服务器地址')
  })

  it('中间消息联动：interimRecall ← interimMessages、interimRecallMs ← interimRecall（两级级联）', () => {
    const off = visibleLabels('behavior', { interimMessages: false })
    expect(off).not.toContain('自动撤回中间消息')
    expect(off).not.toContain('中间消息保留时长（毫秒）')
    const level1 = visibleLabels('behavior', { interimRecall: false }) // 默认档：撤回开关显、延迟隐藏
    expect(level1).toContain('自动撤回中间消息')
    expect(level1).not.toContain('中间消息保留时长（毫秒）')
    const level2 = visibleLabels('behavior', { interimRecall: true, interimRecallMs: '0' })
    expect(level2).toContain('中间消息保留时长（毫秒）')
  })

  it('autoSteerPolicy ← newMessagePolicy=steer；inboxQueueDelayMs ← inboxQueueEnabled', () => {
    expect(visibleLabels('behavior', {})).toContain('自动插话资格')
    expect(visibleLabels('behavior', { newMessagePolicy: 'queue' })).not.toContain('自动插话资格')
    expect(visibleLabels('behavior', {})).not.toContain('合并等待窗口（毫秒）')
    expect(visibleLabels('behavior', { inboxQueueEnabled: true })).toContain('合并等待窗口（毫秒）')
  })

  it('stt 联动：sttCommand/sttArgs ← sttEngine=custom、sttModel ← sttEngine=openai；memoryFiles ← memoryFilesEnabled', () => {
    const mediaLabels = visibleLabels('media', {})
    expect(mediaLabels).not.toContain('自定义转写程序')
    expect(mediaLabels).not.toContain('转写参数模板')
    expect(mediaLabels).not.toContain('转写模型')
    const custom = visibleLabels('media', { sttEngine: 'custom' })
    expect(custom).toContain('自定义转写程序')
    expect(custom).toContain('转写参数模板')
    const openai = visibleLabels('media', { sttEngine: 'openai' })
    expect(openai).toContain('转写模型')
    expect(visibleLabels('session', {})).not.toContain('记忆文件路径')
    expect(visibleLabels('session', { memoryFilesEnabled: true })).toContain('记忆文件路径')
  })

  it('渲染行计数与 showIf 自洽：默认草稿顶层字段行 69 行 = 全键 - 8 个隐藏键（host/port/interimRecallMs/inboxQueueDelayMs/memoryFiles/sttCommand/sttArgs/sttModel）', () => {
    const visible = (field: { showIf?: { key: string; value: unknown } }) => !field.showIf || baseDraft()[field.showIf.key] === field.showIf.value
    const expectedVisible = allFields.filter(visible).length
    expect(expectedVisible).toBe(61)
    const rowsPerGroup = groups.map((group) => topFieldRows(renderGroup(group.id, {})).length)
    expect(rowsPerGroup).toEqual([12, 15, 18, 4, 13, 7]) // behavior 18 = 10 字段 + 4 通知开关行 + 4 文案行；connection 12 含 T11 sidebarEntryEnabled
    expect(rowsPerGroup.reduce((sum, count) => sum + count, 0)).toBe(69)
  })
})

describe('T8 客户端 bundle — 渲染函数模块级可测（renderGroup 纯函数，ui 桩注入）', () => {
  it('六组各产出标题与逐字段控件行；控件类型齐备（9 分段 + 12 多行文本 + 30 开关 + 17 文本输入 + 1 密码框 + 1 清除勾选）', () => {
    const sections = groups.map((group) => renderGroup(group.id, {}))
    expect(sections.map((section) => section.props['data-group'])).toEqual(['connection', 'permissions', 'behavior', 'session', 'media', 'diagnostics'])
    const elements = sections.flatMap((section) => walk(section))
    expect(elements.filter((element) => element.type === stubUi.SegmentedControl)).toHaveLength(9) // 9 枚举全显（原生分段控件）
    expect(elements.filter((element) => element.type === 'textarea')).toHaveLength(12) // 8 可见 stringArray + 4 通知文案
    const inputs = elements.filter((element) => element.type === stubUi.Input)
    expect(inputs.filter((input) => input.props.type === 'text')).toHaveLength(17) // 8 可见 number + 9 可见 string
    expect(inputs.filter((input) => input.props.type === 'password')).toHaveLength(1)
    expect(elements.filter((element) => element.type === stubUi.Switch)).toHaveLength(30) // 26 布尔 + 4 通知开关
    expect(elements.filter((element) => element.type === stubUi.Checkbox)).toHaveLength(1) // 仅 secret 清除勾选
    expect(elements.filter((element) => element.type === 'input')).toHaveLength(0) // 控件全走 ui 桩；原始 input 不再出现
  })

  it('布尔行左右布局：Switch 桩收 checked/label/disabled（aria 语义由宿主组件承担）', () => {
    const diagnostics = groups.find((group) => group.id === 'diagnostics')!
    const section = renderGroup('diagnostics', { draft: { ...baseDraft(), traceEnabled: true } })
    const switches = walk(section).filter((element) => element.type === stubUi.Switch && String(element.props.label ?? '').includes('决策追踪'))
    expect(switches).toHaveLength(1)
    expect(switches[0].props.checked).toBe(true)
    expect(diagnostics.fields.find((field) => field.key === 'traceEnabled')).toBeDefined()
  })

  it('accessToken 密码型输入且不明文回显：value 恒空、树内不含明文；状态徽标 + 清除勾选三态齐备', () => {
    const snapshot = { config: { ...SNAPSHOT_CONFIG, accessToken: 'super-secret-token' } }
    const redactedDraft = draft(snapshot)
    expect(redactedDraft.accessToken).toBe('') // draftFromSnapshot 脱敏：明文绝不进入草稿
    const section = renderGroup('connection', { draft: redactedDraft, secretSet: true })
    const elements = walk(section)
    const passwordInputs = elements.filter((element) => element.type === stubUi.Input && element.props.type === 'password')
    expect(passwordInputs).toHaveLength(1)
    expect(passwordInputs[0].props.value).toBe('')
    expect(passwordInputs[0].props.placeholder).toBe('••••••••••••••••')
    expect(JSON.stringify(elements)).not.toContain('super-secret-token')
    expect(JSON.stringify(elements)).toContain('已配置（脱敏，不回显）')
    const section2 = renderGroup('connection', { secretSet: false, clearSecret: true })
    const elements2 = walk(section2)
    expect(JSON.stringify(elements2)).toContain('未配置') // secretSet:false + 勾清除仍显「未配置」（既有契约）
    expect(JSON.stringify(elements2)).not.toContain('保存后清空')
    const checkboxes = elements2.filter((element) => element.type === stubUi.Checkbox)
    expect(checkboxes).toHaveLength(1)
    expect(checkboxes[0].props.label).toBe('清除已保存的 AccessToken')
    expect(checkboxes[0].props.checked).toBe(true)
  })
})

describe('T8 补回上游缺口① — W6「非默认」徽标（所有类型键挂标，title=与默认值不同）', () => {
  function badges(draftValues: Record<string, unknown>, nonDefaultKeys: string[]) {
    return groups
      .flatMap((group) => (client.renderGroup as Function)(stubReact, group, {
        draft: draftValues,
        ui: stubUi,
        nonDefaultKeys,
        secretSet: false,
        clearSecret: false,
        onChange: () => {},
        onSecretChange: () => {},
        onClearSecretChange: () => {},
        onNoticeChange: () => {},
      }))
      .flatMap((section) => walk(section))
      // W6 徽标 = children 带「与默认值不同」title 的 Tag；密文状态徽标（未配置等）不计
      .filter((element) => element.type === stubUi.Tag && JSON.stringify(element).includes('与默认值不同'))
  }

  it('nonDefaultKeys 命中的键打「非默认」徽标且带 title，未命中不打', () => {
    const draftValues = baseDraft()
    expect(badges(draftValues, [])).toHaveLength(0)
    const traceBadges = badges(draftValues, ['traceEnabled'])
    expect(traceBadges).toHaveLength(1)
    expect(JSON.stringify(traceBadges[0])).toContain('非默认')
    // title 挂在 children span 上（宿主 Tag 不透传多余 props）
    expect(JSON.stringify(traceBadges[0])).toContain('与默认值不同')
  })

  it('T8 语义恢复：不限字段类型——string/number/stringArray/enum 键命中同样挂标（贡献者只给 boolean/enum 挂，上游 W6 全键）', () => {
    const draftValues = baseDraft()
    const hits = ['botQQ', 'rateLimitPerMinute', 'allowFrom', 'faceStyle', 'traceEnabled'] // string/number/stringArray/enum/boolean
    const found = badges(draftValues, hits)
    expect(found).toHaveLength(5)
    for (const badge of found) expect(JSON.stringify(badge)).toContain('与默认值不同')
  })

  it('徽标数据源是快照生效值 vs DEFAULTS（纯客户端计算）：默认快照无任何徽标，改值后对应键出现徽标', () => {
    const panelKeys = (config: Record<string, unknown>) => {
      const valueEquals = (a: unknown, b: unknown) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)
      return allFields.filter((field) => !valueEquals(config[field.key], defaults[field.key])).map((field) => field.key)
    }
    expect(panelKeys({ ...SNAPSHOT_CONFIG })).toEqual([])
    const hits = panelKeys({ ...SNAPSHOT_CONFIG, traceEnabled: true, rateLimitPerMinute: 60, gifFramesEnabled: true })
    expect(hits).toHaveLength(3)
    expect(hits.sort()).toEqual(['gifFramesEnabled', 'rateLimitPerMinute', 'traceEnabled'])
    expect(CLIENT_SOURCE).toContain('title: "与默认值不同"')
  })
})

describe('0.10.0 页签式导航 — 诊断组折叠随折叠交互移除', () => {
  it('诊断组常规 section 形态（无 details/summary 折叠），7 字段行', () => {
    const section = renderGroup('diagnostics', {})
    expect(section.type).toBe('section')
    expect(section.props['data-group']).toBe('diagnostics')
    expect(topFieldRows(section)).toHaveLength(7)
  })

  it('折叠记忆源码已移除（持久化 API/diagnosticsExpanded/summary 词条不再出现）', () => {
    expect(CLIENT_SOURCE).not.toContain('DIAGNOSTICS_EXPANDED_KEY =')
    expect(CLIENT_SOURCE).not.toContain('window.sessionStorage')
    expect(CLIENT_SOURCE).not.toContain('diagnostics.summary')
    expect(CLIENT_SOURCE).not.toContain('collapsible')
  })
})

describe('T8 保存语义 — computePatch / computeDirtyKeys（updateSettings(patch, expectedRevision) 入参构造）', () => {
  const compute = client.computePatch as (
    draftValues: Record<string, unknown>,
    config: Record<string, unknown>,
    opts?: { secretDraft?: string; clearSecret?: boolean },
  ) => { patch: Record<string, unknown>; invalidKeys: string[] }
  const computeDirtyKeys = client.computeDirtyKeys as (
    draftValues: Record<string, unknown>,
    config: Record<string, unknown>,
    opts?: { secretDraft?: string; clearSecret?: boolean },
  ) => string[]

  it('仅下发与生效值有差异的键（含 T6/T7 转正键）', () => {
    const values = baseDraft()
    values.port = '9999'
    values.mode = 'reverse'
    values.groupAllowFrom = '111\n222'
    values.gifFramesEnabled = true
    values.inboxQueueDelayMs = '800'
    const { patch, invalidKeys } = compute(values, SNAPSHOT_CONFIG)
    expect(invalidKeys).toEqual([])
    expect(patch).toEqual({ port: 9999, mode: 'reverse', groupAllowFrom: ['111', '222'], gifFramesEnabled: true, inboxQueueDelayMs: 800 })
  })

  it('无差异时 patch 为空对象（no-op 短路，host 不递增 revision）', () => {
    expect(compute(baseDraft(), SNAPSHOT_CONFIG, { secretDraft: '', clearSecret: false }).patch).toEqual({})
  })

  it('accessToken 三态：留空 = 不修改（缺省）；输入 = 明文写入；勾选清除 = 下发空串', () => {
    const values = baseDraft()
    expect(compute(values, SNAPSHOT_CONFIG, { secretDraft: '', clearSecret: false }).patch.accessToken).toBeUndefined()
    expect(compute(values, SNAPSHOT_CONFIG, { secretDraft: 'new-token', clearSecret: false }).patch.accessToken).toBe('new-token')
    expect(compute(values, SNAPSHOT_CONFIG, { secretDraft: '', clearSecret: true }).patch.accessToken).toBe('')
  })

  it('数字字段非法输入不进 patch 且单独报告（host validatePatch 二次校验兜底）', () => {
    const values = baseDraft()
    values.interimRecallMs = 'abc'
    values.rateLimitPerMinute = '45'
    const { patch, invalidKeys } = compute(values, SNAPSHOT_CONFIG)
    expect(invalidKeys).toEqual(['interimRecallMs'])
    expect(patch).toEqual({ rateLimitPerMinute: 45 })
  })

  it('stringArray 宽分隔符（T8 贡献者语义）：逗号/顿号/换行皆可拆，空格不拆、trim、去空段', () => {
    const values = baseDraft()
    values.adminUsers = ' 10000 ，20000、30000 \n 40000 '
    expect(compute(values, SNAPSHOT_CONFIG).patch.adminUsers).toEqual(['10000', '20000', '30000', '40000'])
    const values2 = baseDraft()
    values2.allowFrom = 'a b, c'
    expect(compute(values2, SNAPSHOT_CONFIG).patch.allowFrom).toEqual(['a b', 'c']) // 空格不拆
  })

  it('dirtyKeys 与保存流同口径；mode 联动派生（reverse→url、forward→host/port）', () => {
    const deriveModeInactiveKeys = client.deriveModeInactiveKeys as (mode: unknown) => string[]
    const values = baseDraft()
    expect(computeDirtyKeys(values, SNAPSHOT_CONFIG)).toEqual([])
    values.port = '9999'
    expect(computeDirtyKeys(values, SNAPSHOT_CONFIG)).toEqual(['port'])
    expect(computeDirtyKeys(values, SNAPSHOT_CONFIG, { secretDraft: 'tok', clearSecret: false })).toEqual(['port', 'accessToken'])
    values.interimRecallMs = 'abc'
    expect(computeDirtyKeys(values, SNAPSHOT_CONFIG)).toEqual(['port']) // 非法数字不入 dirty
    expect(deriveModeInactiveKeys('reverse')).toEqual(['url'])
    expect(deriveModeInactiveKeys('forward')).toEqual(['host', 'port'])
    expect(deriveModeInactiveKeys(undefined)).toEqual([])
  })
})

describe('T8 数字行内校验 — NUMBER_RANGE 对齐 host + numberRangeInvalid 同语义', () => {
  const NUMBER_RANGE = client.NUMBER_RANGE as Record<string, [number, number | undefined]>
  const numberRangeInvalid = client.numberRangeInvalid as (
    field: { key: string; type: string } | null | undefined,
    raw: unknown,
  ) => string | null

  it('NUMBER_RANGE 覆盖全部面板数字键（11 键，含 T7 inboxQueueDelayMs；chatIdleEvictDays 不上面板不入表）且注明来源行号', () => {
    expect(NUMBER_RANGE).toStrictEqual({
      port: [1, 65535],
      interimRecallMs: [0, undefined],
      rateLimitPerMinute: [0, undefined],
      deferredTimeoutMs: [0, undefined],
      inboxQueueDelayMs: [0, undefined],
      textImageThreshold: [0, undefined],
      maxFileBytes: [1, 4294967296],
      outboundImageMaxBytes: [1, 104857600],
      maxVoiceBytes: [1, 52428800],
      inboundImageMaxPx: [0, undefined],
      inboundFileMaxBytes: [0, undefined],
    })
    expect(Object.keys(NUMBER_RANGE)).toEqual(allFields.filter((field) => field.type === 'number').map((field) => field.key))
    expect(CLIENT_SOURCE).toContain('src/settings-remote.ts L204-218')
  })

  it('numberRangeInvalid：越界/NaN 判非法返回范围文案，边界含端点；非 number 不校验', () => {
    const portField = allFields.find((field) => field.key === 'port')!
    const recallField = allFields.find((field) => field.key === 'interimRecallMs')!
    expect(numberRangeInvalid(portField, '70000')).toBe('1–65535')
    expect(numberRangeInvalid(portField, '0')).toBe('1–65535')
    expect(numberRangeInvalid(portField, '3000')).toBeNull()
    expect(numberRangeInvalid(portField, '65535')).toBeNull()
    expect(numberRangeInvalid(portField, 'abc')).toBe('1–65535')
    expect(numberRangeInvalid(portField, '')).toBe('1–65535')
    expect(numberRangeInvalid(recallField, '-1')).toBe('≥0')
    expect(numberRangeInvalid(recallField, '0')).toBeNull()
    expect(numberRangeInvalid(recallField, '1e9')).toBeNull()
    expect(numberRangeInvalid(null, 'x')).toBeNull()
    expect(numberRangeInvalid({ key: 'botQQ', type: 'string' }, 'x')).toBeNull()
  })

  it('越界标红：number 控件 aria-invalid 透传 + hint 行内嵌红字；校验时机 = onChange 即时', () => {
    const connection = groups.find((group) => group.id === 'connection')!
    const section = (client.renderGroup as Function)(stubReact, connection, {
      draft: { ...baseDraft(), mode: 'reverse' }, // reverse 档位 port 才可见（showIf）
      ui: stubUi,
      invalidNumbers: { port: '必须是 1–65535 的有限数字' },
      onChange: () => {},
      onSecretChange: () => {},
      onClearSecretChange: () => {},
    }) as StubElement
    const rendered = JSON.stringify(walk(section))
    expect(rendered).toContain('obx-hint--invalid') // 红字范围提示内嵌 hint 行
    expect(rendered).toContain('必须是 1–65535 的有限数字')
    const narrowControl = walk(section).find((element) => element.props.className === 'obx-control--narrow')!
    const portInput = walk(narrowControl).find((element) => element.type === stubUi.Input)!
    expect(portInput.props['aria-invalid']).toBe(true)
    // tsc 会把单行 if 块展开为多行，这里用正则匹配调用接线（0.10.0 起 onChange 即时校验）
    expect(CLIENT_SOURCE).toMatch(/if \(field\.type === "number"\)\s*\{\s*validateNumberField\(field, nextValue\);/)
    expect(CLIENT_SOURCE).toContain('disabled: busy || dirtyCount === 0 || invalidNumberCount > 0')
  })
})

describe('T8 冲突合并 — mergeOnConflict（远端未变保留草稿、远端已变跟随新快照）', () => {
  const mergeOnConflict = client.mergeOnConflict as (
    draftValues: Record<string, unknown> | null,
    oldConfig: Record<string, unknown> | null,
    nextConfig: Record<string, unknown> | null,
  ) => { draft: Record<string, unknown>; conflictKeys: string[]; keptCount: number }

  it('无冲突：全部本地编辑保留（keptCount=N、conflictKeys=[]），纯函数不改入参', () => {
    const before = baseDraft()
    before.port = '9999'
    before.botQQ = '10086'
    before.traceEnabled = true
    const beforeJson = JSON.stringify(before)
    const merged = mergeOnConflict(before, SNAPSHOT_CONFIG, { ...SNAPSHOT_CONFIG })
    expect(merged.conflictKeys).toEqual([])
    expect(merged.keptCount).toBe(3)
    expect(merged.draft.port).toBe('9999')
    expect(merged.draft.botQQ).toBe('10086')
    expect(merged.draft.traceEnabled).toBe(true)
    expect(merged.draft).not.toBe(before)
    expect(JSON.stringify(before)).toBe(beforeJson)
  })

  it('部分冲突：远端已变的脏键跟随新快照并入 conflictKeys，其余保留；合并覆盖全部 69 面板键', () => {
    const before = baseDraft()
    before.port = '9999'
    before.botQQ = '10086'
    const next = { ...SNAPSHOT_CONFIG, port: 3000 }
    const merged = mergeOnConflict(before, SNAPSHOT_CONFIG, next)
    expect(merged.conflictKeys).toEqual(['port'])
    expect(merged.keptCount).toBe(1)
    expect(merged.draft.port).toBe('3000')
    expect(merged.draft.botQQ).toBe('10086')
    expect(Object.keys(merged.draft)).toHaveLength(69)
    expect((client.computeDirtyKeys as Function)(merged.draft, next)).toEqual(['botQQ'])
  })

  it('空集与 null 防御；密文例外 accessToken 恒 \'\'；stringArray 以「, 」join 展示形态重写', () => {
    const merged = mergeOnConflict(baseDraft(), SNAPSHOT_CONFIG, { ...SNAPSHOT_CONFIG })
    expect(merged.conflictKeys).toEqual([])
    expect(merged.keptCount).toBe(0)
    const defensive = mergeOnConflict(null, null, null)
    expect(defensive.conflictKeys).toEqual([])
    expect(defensive.keptCount).toBe(0)
    const before = baseDraft()
    before.accessToken = 'typed-secret'
    before.rateLimitPerMinute = '60'
    before.botQQ = '10086' // 本地脏键 + 远端已变 → 冲突键
    const next = { ...SNAPSHOT_CONFIG, botQQ: '22222', adminUsers: ['10086', '22222'] }
    const merged2 = mergeOnConflict(before, SNAPSHOT_CONFIG, next)
    expect(merged2.draft.accessToken).toBe('')
    expect(merged2.draft.adminUsers).toBe('10086, 22222')
    expect(merged2.draft.rateLimitPerMinute).toBe('60')
    expect(merged2.conflictKeys).toEqual(['botQQ'])
    expect(CLIENT_SOURCE).toContain('mergeOnConflict(draft, snapshot == null ? null : snapshot.config, next.config)')
  })
})

describe('T8 workspace 快速填入 — fillWorkspacePath 双键（workspacePath/groupWorkspacePath）', () => {
  const fillWorkspacePath = client.fillWorkspacePath as (draft: Record<string, unknown>, path: string, key?: string) => Record<string, unknown>

  it('纯函数：默认写 workspacePath，第三参可写 groupWorkspacePath；不改入参、nullish 防御', () => {
    const base = baseDraft()
    base.botQQ = '10001'
    const filled = fillWorkspacePath(base, '/vol2/ws/alpha')
    expect(filled).toEqual({ ...base, workspacePath: '/vol2/ws/alpha' })
    expect(base.workspacePath).toBe('')
    expect(filled).not.toBe(base)
    const groupFilled = fillWorkspacePath(base, '/vol2/ws/beta', 'groupWorkspacePath')
    expect(groupFilled.groupWorkspacePath).toBe('/vol2/ws/beta')
    expect(groupFilled.workspacePath).toBe('')
    expect(fillWorkspacePath(base, undefined as unknown as string).workspacePath).toBe('')
    expect(CLIENT_SOURCE).toContain('setDraft(fillWorkspacePath(draft, path, field.key))')
  })

  it('填入后显式保存通道才生效：computePatch 只产出 workspacePath 键', () => {
    const compute = client.computePatch as (draftValues: Record<string, unknown>, config: Record<string, unknown>) => { patch: Record<string, unknown> }
    const filled = fillWorkspacePath(baseDraft(), '/vol2/ws/alpha')
    expect(compute(filled, SNAPSHOT_CONFIG).patch).toEqual({ workspacePath: '/vol2/ws/alpha' })
    expect(compute(fillWorkspacePath(baseDraft(), ''), SNAPSHOT_CONFIG).patch).toEqual({})
  })

  it('picker 正常态：select（value=id，label=path（N 会话））+「填入」按钮（ui 桩）；降级态说明行', () => {
    const renderPicker = client.renderWorkspacePicker as (react: unknown, opts: Record<string, unknown>) => StubElement | null
    const pickerOpts = (overrides: Record<string, unknown> = {}) => ({
      ui: stubUi,
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
    })
    expect(renderPicker(stubReact, pickerOpts({ loaded: false }))).toBeNull()
    const node = renderPicker(stubReact, pickerOpts())!
    const elements = walk(node)
    const select = elements.find((element) => element.type === 'select')!
    expect((select.props as Record<string, unknown>).value).toBe('')
    const options = select.children as StubElement[]
    expect(options.map((option) => option.props.value)).toEqual(['', 'ws-1', 'ws-2'])
    expect(options.map((option) => option.children[0])).toEqual(['选择 workspace…', '/vol2/ws/alpha（3 会话）', '/vol2/ws/beta（0 会话）'])
    expect(elements.find((element) => element.type === stubUi.Button)!.props.disabled).toBe(true)
    const applied: unknown[] = []
    const selected = renderPicker(stubReact, pickerOpts({ selectedId: 'ws-2', onApply: (path: string) => { applied.push(path) } }))!
    const button = walk(selected).find((element) => element.type === stubUi.Button)!
    expect(button.props.disabled).toBe(false)
    button.props.onClick()
    expect(applied).toEqual(['/vol2/ws/beta']) // 填的是 path，不是 id
  })
})

describe('T8 失败守卫 — host edit-failed 中文错误可渲染且不误判为冲突', () => {
  const unwrap = client.unwrap as (result: unknown) => unknown
  const isConflictError = client.isConflictError as (cause: unknown) => boolean

  it('unwrap({ok:false}) 保留 code 与中文 message', () => {
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

  it('edit-failed 不匹配冲突通道；conflict 命中', () => {
    expect(isConflictError({ code: 'onebot-settings/edit-failed', message: '写入失败：宿主 configEditor 拒绝了本次修改' })).toBe(false)
    expect(isConflictError({ code: 'onebot-settings/conflict', message: 'expectedRevision mismatch' })).toBe(true)
  })

  it('面板接线（源码断言）：冲突键编辑撤销 / toast 5 秒 / beforeunload 守卫 / 双语词条', () => {
    expect(CLIENT_SOURCE).toContain('setConflictKeys(conflictKeys.filter(function (key) { return key !== field.key; }));')
    expect(CLIENT_SOURCE).toContain('setTimeout(function () {')
    expect(CLIENT_SOURCE).toContain('t("conflict.secretCleared")')
    expect(CLIENT_SOURCE).toContain('"conflict.kept": "已保留 {count} 项未冲突的修改，请核对后重新保存。"')
    expect(CLIENT_SOURCE).toContain('"conflict.kept": "Kept {count} non-conflicting change(s) — review and save again."')
  })
})

describe('0.10.0 设置页样式 — dsw token 对齐（页骨架/发丝分隔/布局分支收敛）', () => {
  it('面板容器：960px 居中内容列（宿主原生页口径），token 引用宿主 --dsw-*', () => {
    const rule = CLIENT_SOURCE.match(/\.obx-panel\{[^}]*\}/)
    expect(rule).not.toBeNull()
    expect(rule![0]).toContain('max-width:960px')
    expect(rule![0]).toContain('margin-inline:auto')
    expect(rule![0]).toContain('var(--dsw-alias-label-primary')
    expect(rule![0]).toContain('var(--dsw-radius-md,12px)')
  })

  it('字段行发丝分隔：0.5px + 宿主 border-l2 别名（原生表单形态）；组头/子标题后首行无线', () => {
    const field = CLIENT_SOURCE.match(/\.obx-field\{[^}]*\}/)
    expect(field).not.toBeNull()
    expect(field![0]).toContain('border-top:.5px solid var(--obx-hairline)')
    expect(CLIENT_SOURCE).toContain('.obx-group-head+.obx-field,.obx-subgroup-title+.obx-field{border-top:none}')
  })

  it('布局分支收敛：容器查询网格/行内 hint/自造紫色 accent 已移除（label 上、hint 下统一纵向）', () => {
    expect(CLIENT_SOURCE).not.toContain('@container')
    expect(CLIENT_SOURCE).not.toContain('obx-hint-inline')
    expect(CLIENT_SOURCE).not.toContain('obx-input--invalid')
    expect(CLIENT_SOURCE).not.toContain('--obx-accent')
    expect(CLIENT_SOURCE).not.toContain('#6e57af')
  })

  it('自造视觉体系退出：SVG 开关/胶囊页签/密文自绘徽标不再出现（控件交宿主 primitives）', () => {
    expect(CLIENT_SOURCE).not.toContain('obx-toggle--svg')
    expect(CLIENT_SOURCE).not.toContain('obx-btn--pill')
    expect(CLIENT_SOURCE).not.toContain('obx-secret-badge')
    expect(CLIENT_SOURCE).not.toContain('obx-tab{')
  })
})
