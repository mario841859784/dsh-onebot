/**
 * T11 客户端侧边栏入口测试。
 *
 * 验证 src/client.ts（构建产物 lib/client.js）apply(ctx) 的 slot 注册契约：
 *   ① 成对注册：sidebarEntryEnabled 开（默认）时，main keyed slot 与
 *      sidebar.panellist 列表条目同 id（SIDEBAR_PANEL_ID="qq-bot"）成对注册——
 *      宿主 dsh-client-ui-layout selectPanel 按 main key 校验，缺一面板抛错；
 *   ② 开关关：sidebarEntryEnabled=false 时两侧都不注册（避免不成对状态），
 *      插件菜单下的 plugins.bundle.config 设置页入口无条件保留；
 *   ③ 快照读取失败兜底为默认值（开）；
 *   ④ 侧边栏条目形态：order/label 词条、图标组件收 {size} 自绘 SVG。
 *
 * @module dsh-onebot/tests/sidebar-entry
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { SCHEMA_DEFAULTS } from '../src/settings-remote.js'

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 极简 React 替身：createElement 产出可遍历的元素树（与 client-settings 同款）。 */
type StubElement = { type: unknown; props: Record<string, unknown>; children: unknown[] }
const stubReact = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): StubElement {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true) }
  },
}

/** CJS 包裹装载：模拟 window.__ModuleLoader__.load + require('react') 外部表。 */
function loadClientModule(): Record<string, unknown> {
  const factories: Record<string, (request: (spec: string) => unknown) => unknown> = {}
  const globalWithWindow = globalThis as unknown as { window?: { __ModuleLoader__: unknown } }
  globalWithWindow.window = { __ModuleLoader__: { load: (entry: { id: string; factory: (request: (spec: string) => unknown) => unknown }) => { factories[entry.id] = entry.factory } } }
  new Function(CLIENT_SOURCE)()
  const factory = factories['dsh-onebot-qq']
  if (factory === undefined) throw new Error('lib/client.js 未注册 dsh-onebot-qq 模块')
  return factory((spec: string) => {
    if (spec !== 'react') throw new Error(`unexpected external require: ${spec}`)
    return stubReact
  }) as Record<string, unknown>
}

const client = loadClientModule()

/** apply 桩 ctx：捕获 inject/register/effect，remote 按给定快照（或错误）应答。 */
function runApply(config: Record<string, unknown> | Error) {
  const injected: string[] = []
  const registered: Array<{ descriptor: Record<string, unknown>; render: unknown }> = []
  const effectLabels: string[] = []
  const remote = {
    getSettings: async () => {
      if (config instanceof Error) throw config
      return { revision: 1, entryActive: true, config, secrets: [], groups: [], effect: 'restart' }
    },
  }
  const ctx = {
    // effect 只登记不执行：首个 effect 回调操作 document（node 测试环境无 DOM），
    // 宿主生命周期行为不在本测范围。
    effect: (_fn: unknown, label: string) => { effectLabels.push(label) },
    locale: { register: () => () => {}, bind: () => (key: string) => `t:${key}` },
    remote: { $mount: async () => () => {} },
    get: (name: string) => (name === 'remote.onebotSettings' ? remote : undefined),
    slots: {
      inject: (name: string, register: () => unknown) => {
        injected.push(name)
        register()
      },
      register: (descriptor: Record<string, unknown>, render: unknown) => {
        registered.push({ descriptor, render })
        return descriptor
      },
    },
  }
  const apply = client.apply as (ctx: unknown) => Promise<unknown>
  return apply(ctx).then(() => ({ injected, registered, effectLabels }))
}

const registeredOf = (result: Awaited<ReturnType<typeof runApply>>, name: string) =>
  result.registered.filter((entry) => entry.descriptor.name === name)

describe('T11 侧边栏入口 — 成对注册（开关开，默认）', () => {
  it('sidebarEntryEnabled=true：main 与 sidebar.panellist 同 id "qq-bot" 成对注册', async () => {
    const result = await runApply({ ...SCHEMA_DEFAULTS })
    expect(result.injected).toContain('plugins.bundle.config')
    expect(result.injected).toContain('main')
    expect(result.injected).toContain('sidebar.panellist')

    const mainSlots = registeredOf(result, 'main')
    const sidebarSlots = registeredOf(result, 'sidebar.panellist')
    expect(mainSlots).toHaveLength(1)
    expect(sidebarSlots).toHaveLength(1)
    // 宿主合同：sidebar.panellist 的 id 必须与 main keyed slot 的 key 一致
    expect(mainSlots[0].descriptor.key).toBe('qq-bot')
    expect(sidebarSlots[0].descriptor.id).toBe('qq-bot')
    expect(mainSlots[0].descriptor.key).toBe(sidebarSlots[0].descriptor.id)
  })

  it('main 面板渲染产出 OnebotSettingsPanel（侧边栏入口打开的就是现有设置面板，同 panel）', async () => {
    const result = await runApply({ ...SCHEMA_DEFAULTS })
    const mainSlot = registeredOf(result, 'main')[0]
    const element = (mainSlot.render as (props: Record<string, unknown>) => StubElement)({ t: (key: string) => key })
    expect(element.type).toBe(client.OnebotSettingsPanel)
  })

  it('sidebar.panellist 条目：order/label 词条/图标组件收 {size} 自绘 SVG', async () => {
    const result = await runApply({ ...SCHEMA_DEFAULTS })
    const sidebarSlot = registeredOf(result, 'sidebar.panellist')[0]
    expect(sidebarSlot.descriptor.order).toBe(20)
    expect((sidebarSlot.descriptor.label as () => string)()).toBe('t:sidebar.panel') // 中文词条经 locale（源码 zh="QQ Bot"）

    const icon = (sidebarSlot.render as (props: Record<string, unknown>) => StubElement)({ size: 16 })
    expect(icon.type).toBe('svg')
    expect(icon.props.width).toBe(16)
    expect(icon.props.height).toBe(16)
    expect((sidebarSlot.render as (props: Record<string, unknown>) => StubElement)({}).props.width).toBe(18) // 缺省 size
  })
})

describe('T11 侧边栏入口 — 开关关与兜底', () => {
  it('sidebarEntryEnabled=false：main 与 sidebar.panellist 都不注册（避免不成对状态）；设置页入口保留', async () => {
    const result = await runApply({ ...SCHEMA_DEFAULTS, sidebarEntryEnabled: false })
    expect(result.injected).toEqual(['plugins.bundle.config'])
    expect(registeredOf(result, 'main')).toHaveLength(0)
    expect(registeredOf(result, 'sidebar.panellist')).toHaveLength(0)
    expect(registeredOf(result, 'plugins.bundle.config')).toHaveLength(1)
  })

  it('getSettings 抛错：按 schema 默认值（开）兜底，两侧成对注册', async () => {
    const result = await runApply(new Error('remote unavailable'))
    expect(result.injected).toContain('main')
    expect(result.injected).toContain('sidebar.panellist')
    expect(registeredOf(result, 'main')[0].descriptor.key).toBe(registeredOf(result, 'sidebar.panellist')[0].descriptor.id)
  })
})

describe('T11 侧边栏入口 — 源码形态', () => {
  it('成对注册收在同一条件分支（防只改一侧造成不成对状态）', () => {
    const injectMain = CLIENT_SOURCE.indexOf('ctx.slots.inject("main"')
    const injectSidebar = CLIENT_SOURCE.indexOf('ctx.slots.inject("sidebar.panellist"')
    expect(injectMain).toBeGreaterThan(-1)
    expect(injectSidebar).toBeGreaterThan(injectMain) // 同一 if (sidebarEnabled) 块内先后注册
    const guard = CLIENT_SOURCE.indexOf('if (sidebarEnabled)')
    expect(guard).toBeGreaterThan(-1)
    expect(injectMain).toBeGreaterThan(guard)
    // 条件块闭合（下一个 "return function" 的 dispose 返回）之前不含其他无条件 inject
    const block = CLIENT_SOURCE.slice(guard, CLIENT_SOURCE.indexOf('return function () { void disposeRemote(); };', guard))
    expect(block).toContain('ctx.slots.inject("main"')
    expect(block).toContain('ctx.slots.inject("sidebar.panellist"')
  })
})
