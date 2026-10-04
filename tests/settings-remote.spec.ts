/**
 * onebotSettings Typert Remote 服务测试（T3）。
 *
 * 三步主链路（PLAN T3 验收）：
 *   ① 写设置（updateSettings 合并写入 dsh-onebot 覆盖行）；
 *   ② 读快照（getSettings 返回的 revision 随已提交变更递增）；
 *   ③ 非法 revision 拒写（RemoteError onebot-settings/conflict，不落盘不递增）。
 *
 * 宿主 configEditor 以最小契约替身模拟（entries()/edit() 的持久化语义对齐
 * dsh-config-editor/lib/index.js:63-123：change(current, inherited) → next 作
 * 为覆盖行写 patch 文档、等价继承层时整行删除、成功后 entry.options.config
 * 更新；真实宿主侧的文件锁/原子写/失败回滚由宿主保证，此处只验证 Remote 的
 * 合并、revision、脱敏与校验行为）。契约唯一来源：docs/settings-page-design.md
 * §3/§3.1/§4。
 * @module dsh-onebot/tests/settings-remote
 */
import { isDeepStrictEqual } from 'node:util'

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import {
  ALL_KEYS,
  ENTRY_ID,
  NAMESPACE,
  OnebotSettingsService,
  SCHEMA_DEFAULTS,
  SETTINGS_GROUPS,
  createOnebotSettingsMethods,
  createRevisionState,
  getSettings,
  updateSettings,
} from '../src/settings-remote.js'

/** configEditor 最小替身：rows = profile patch 中 dsh-onebot 的覆盖行文档。 */
class FakeConfigEditor {
  /** 模拟 profile patch 文档中的覆盖行（含持久层落盘断言目标）。 */
  rows: Array<{ id: string; config: Record<string, unknown> }> = []
  writeCount = 0
  /** edit 调用总数（含失败）——「失败不重试」断言用。 */
  editCalls = 0
  failNextEdit: Error | null = null
  /** W6：模拟宿主「原子写已落盘 → reconcile 失败 → 逐字节还原 → rethrow」
   *  （docs/m1-characterization/config-editor.md §3 回滚行；测试禁断言 mtime）。 */
  rollbackSimulate = false
  entry: {
    options: { id: string; name: string; config: Record<string, unknown> }
    fiber: { state: number } | undefined
  }

  constructor(config: Record<string, unknown> = {}) {
    this.entry = { options: { id: ENTRY_ID, name: '/tmp/deploy/dsh-onebot/lib/index.js', config: { ...config } }, fiber: { state: 2 } }
  }

  entries() {
    return [this.entry]
  }

  async edit(entry: { options: { id: string; config: Record<string, unknown> } }, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) {
    this.editCalls += 1
    if (this.rollbackSimulate) {
      const before = structuredClone(entry.options.config)
      const next = change({ ...entry.options.config }, {})
      entry.options.config = structuredClone(next) // 步 14：原子写已替换文件
      entry.options.config = structuredClone(before) // 步 15 失败：宿主 L127 逐字节还原
      throw new Error('reconcile failed: dsh-onebot entry did not activate')
    }
    if (this.failNextEdit) {
      const error = this.failNextEdit
      this.failNextEdit = null
      throw error
    }
    this.writeCount += 1
    const next = change({ ...entry.options.config }, {})
    const index = this.rows.findLastIndex((row) => row.id === entry.options.id)
    if (isDeepStrictEqual(next, {})) {
      if (index >= 0) this.rows.splice(index, 1) // 等价继承层 → 覆盖行整行删除
    } else if (index >= 0) {
      this.rows[index] = { id: entry.options.id, config: structuredClone(next) }
    } else {
      this.rows.push({ id: entry.options.id, config: structuredClone(next) })
    }
    entry.options.config = structuredClone(next) // reconcile 已应用的运行态
  }
}

function errorCode(error: unknown): string {
  return (error as { code?: string }).code ?? ''
}

/** descriptor 参数名单（全 positional 断言用）：解构/默认值/rest 都会破坏逐字匹配。 */
function parameterNames(fn: Function): string[] {
  const text = fn.toString()
  const head = text.slice(0, text.indexOf(')') + 1)
  const inner = head.slice(head.indexOf('(') + 1, -1).trim()
  return inner === '' ? [] : inner.split(',').map((part) => part.trim())
}

describe('onebotSettings remote — 三步主链路（写设置 → revision 递增 → 非法 revision 拒写）', () => {
  it('step 0: getSettings 返回基线快照（revision 0、schema 默认值、脱敏、分组、effect）', () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    const snapshot = getSettings(editor, state)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.entryActive).toBe(true)
    expect(Object.keys(snapshot.config).sort()).toEqual([...ALL_KEYS].sort())
    expect(snapshot.config.requireMention).toBe(SCHEMA_DEFAULTS.requireMention)
    expect(snapshot.config.port).toBe(SCHEMA_DEFAULTS.port)
    expect(snapshot.config.interimRecallMs).toBe(SCHEMA_DEFAULTS.interimRecallMs)
    expect(snapshot.config.accessToken).toBe('') // 未配置：脱敏位空
    expect(snapshot.secrets).toEqual([{ path: ['accessToken'], set: false }])
    expect(snapshot.groups).toEqual(SETTINGS_GROUPS)
    expect(snapshot.effect).toBe('restart')
    // 无变更的重复读不递增。
    expect(getSettings(editor, state).revision).toBe(0)
  })

  it('step 1: updateSettings 合并写入覆盖行并递增 revision', async () => {
    const editor = new FakeConfigEditor({ host: '127.0.0.1', port: 18643 }) // 现网手改键保持不动
    const state = createRevisionState()
    expect(getSettings(editor, state).revision).toBe(0)

    const written = await updateSettings(editor, state, { requireMention: false, port: 20001 })
    expect(written.revision).toBe(1) // ② 读快照 revision 递增
    expect(written.config.requireMention).toBe(false)
    expect(written.config.port).toBe(20001)
    expect(editor.writeCount).toBe(1)
    // 持久层断言：覆盖行出现对应键（等价 T1 §3 的 profile patch dsh-onebot 行）。
    expect(editor.rows).toHaveLength(1)
    expect(editor.rows[0].id).toBe(ENTRY_ID)
    expect(editor.rows[0].config.requireMention).toBe(false)
    expect(editor.rows[0].config.port).toBe(20001)
    expect(editor.rows[0].config.host).toBe('127.0.0.1') // 非本次写入的原键保留

    // 重复读稳定在同一 revision；下一次读侧观察不再递增。
    expect(getSettings(editor, state).revision).toBe(1)
  })

  it('step 2: 非法 expectedRevision 拒写（conflict，不落盘、revision 不变），正确 revision 可重放', async () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    await updateSettings(editor, state, { requireMention: false })

    let caught: unknown
    try {
      await updateSettings(editor, state, { requireMention: true }, 0) // ③ 过期 revision
    } catch (error) {
      caught = error
    }
    expect(errorCode(caught)).toBe('onebot-settings/conflict')
    expect((caught as { details?: { expected: number; actual: number } }).details).toEqual({ expected: 0, actual: 1 })
    expect(editor.writeCount).toBe(1) // 拒写不落盘
    expect(editor.rows[0].config.requireMention).toBe(false) // 覆盖行原值未动
    expect(getSettings(editor, state).revision).toBe(1) // 拒写不递增

    // 客户端按 T1 §3.1：取新快照后以正确 revision 重放。
    const replayed = await updateSettings(editor, state, { requireMention: true }, 1)
    expect(replayed.revision).toBe(2)
    expect(replayed.config.requireMention).toBe(true)
  })
})

describe('onebotSettings remote — revision/no-op/失败路径（T1 §3.1 #4 #5）', () => {
  it('no-op（合并结果与当前生效 config 全等）不写盘、不递增', async () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    await updateSettings(editor, state, { port: 20001 })
    const before = getSettings(editor, state).revision
    const writes = editor.writeCount

    const noop = await updateSettings(editor, state, { port: 20001 })
    expect(noop.revision).toBe(before)
    expect(editor.writeCount).toBe(writes)
  })

  it('edit 失败（宿主侧校验/激活失败回滚）归一为 onebot-settings/edit-failed，revision 不递增、运行态不变', async () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    await updateSettings(editor, state, { port: 20001 })
    const before = getSettings(editor, state).revision
    editor.failNextEdit = new Error('Configuration plugin is no longer active')

    await expect(updateSettings(editor, state, { requireMention: false })).rejects.toMatchObject({
      code: 'onebot-settings/edit-failed',
      message: expect.stringContaining('插件当前未激活'),
    })
    expect(getSettings(editor, state).revision).toBe(before)
    expect(editor.entry.options.config.requireMention).toBeUndefined() // 无半态
  })

  it('外部来源的已提交变更（手改 patch / 宿主原生设置页）同样使读侧 revision 递增', () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    expect(getSettings(editor, state).revision).toBe(0)
    // 模拟 HMR 应用了外部手改（不经本 Remote）。
    editor.entry.options.config = { ...editor.entry.options.config, interimRecallMs: 60_000 }
    expect(getSettings(editor, state).revision).toBe(1)
  })
})

describe('onebotSettings remote — 输入校验与脱敏（T1 §3/§4）', () => {
  it('未知键 / 类型不符 / 非 object patch 整单拒绝且不落盘不递增', async () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    const before = getSettings(editor, state).revision
    const writes = editor.writeCount

    for (const patch of [{ mediaDir: '/x' }, { port: '20001' }, { mode: 'both' }, { allowFrom: '12345' }, 'port=1', null]) {
      await expect(updateSettings(editor, state, patch)).rejects.toMatchObject({ code: 'onebot-settings/bad-request' })
    }
    expect(editor.writeCount).toBe(writes)
    expect(getSettings(editor, state).revision).toBe(before)
  })

  it('accessToken 快照脱敏不回显明文；明文仅落持久层；空串 = 清空', async () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    const baseline = getSettings(editor, state)
    expect(baseline.secrets).toEqual([{ path: ['accessToken'], set: false }])

    const written = await updateSettings(editor, state, { accessToken: 'super-secret' }, baseline.revision)
    expect(written.config.accessToken).toBe('') // 快照脱敏：不回显明文
    expect(written.secrets).toEqual([{ path: ['accessToken'], set: true }])
    expect(editor.rows[0].config.accessToken).toBe('super-secret') // 持久层明文（宿主既有管道行为）
    expect(JSON.stringify(written)).not.toContain('super-secret')

    const cleared = await updateSettings(editor, state, { accessToken: '' }, written.revision)
    expect(cleared.config.accessToken).toBe('')
    expect(cleared.secrets).toEqual([{ path: ['accessToken'], set: false }])
    expect(editor.rows[0].config.accessToken).toBe('')
  })
})

describe('onebotSettings remote — descriptor 契约（T1 §4：全 positional）与降级形态', () => {
  it('descriptor 方法全 positional：getSettings() / updateSettings(patch, expectedRevision)', async () => {
    const editor = new FakeConfigEditor()
    const methods = createOnebotSettingsMethods(editor)
    expect(parameterNames(methods.getSettings)).toEqual([])
    expect(parameterNames(methods.updateSettings)).toEqual(['patch', 'expectedRevision'])

    // 真实 cordis 根 Context 上实例化 typert 服务（类方法面 = descriptor 面）。
    const ctx = new Context()
    ctx.reflect.provide('configEditor', editor)
    const service = new OnebotSettingsService(ctx)
    expect(service.name).toBe(NAMESPACE)
    expect(parameterNames(service.getSettings)).toEqual([])
    expect(parameterNames(service.updateSettings)).toEqual(['patch', 'expectedRevision'])
    expect(await service.updateSettings({ botQQ: '10001' })).toMatchObject({ revision: 1, config: { botQQ: '10001' } })
    expect(await service.getSettings()).toMatchObject({ revision: 1 })
  })

  it('createOnebotSettingsMethods 与 descriptor 方法共享同一实现语义', async () => {
    const editor = new FakeConfigEditor()
    const methods = createOnebotSettingsMethods(editor)
    const first = await methods.updateSettings({ botQQ: '10001' })
    expect(first.revision).toBe(1)
    expect(await methods.getSettings()).toMatchObject({ revision: 1, config: { botQQ: '10001' } })
  })

  it('dsh-onebot 条目不存在时显式报错（no-entry），不得静默', async () => {
    const empty = { entries: () => [], edit: async () => undefined }
    expect(() => getSettings(empty, createRevisionState())).toThrow(ENTRY_ID)
    await expect(updateSettings(empty, createRevisionState(), { port: 1 })).rejects.toMatchObject({
      code: 'onebot-settings/no-entry',
    })
  })

  it('条目失活（fiber 缺失/非 active）在快照中如实标记 entryActive=false', () => {
    const editor = new FakeConfigEditor()
    editor.entry.fiber = undefined
    expect(getSettings(editor, createRevisionState()).entryActive).toBe(false)
  })
})

describe('onebotSettings remote — W6 白名单扩展（W1/W2 观测/调试 6 键）', () => {
  const NEW_BOOLEAN_KEYS = ['actionAuditEnabled', 'traceEnabled', 'recordInbound', 'inboxRedact', 'injectEnabled', 'injectDryRun'] as const
  /** 期望默认值（摘自 src/index.ts schema：actionAuditEnabled/injectDryRun 默认开，其余默认关）。 */
  const NEW_DEFAULTS: Record<string, boolean> = {
    actionAuditEnabled: true,
    traceEnabled: false,
    recordInbound: false,
    inboxRedact: false,
    injectEnabled: false,
    injectDryRun: true,
  }

  it('6 个新键入快照：默认值正确、落在 diagnostics 组、计入 ALL_KEYS', () => {
    const editor = new FakeConfigEditor()
    const snapshot = getSettings(editor, createRevisionState())
    expect(ALL_KEYS).toHaveLength(25)
    expect(snapshot.groups.diagnostics).toEqual([...NEW_BOOLEAN_KEYS])
    for (const key of NEW_BOOLEAN_KEYS) {
      expect(snapshot.config[key]).toBe(NEW_DEFAULTS[key])
    }
  })

  it('新键布尔写入进入覆盖行并递增 revision；与既有键混合 patch 一次写完成', async () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    const written = await updateSettings(editor, state, { traceEnabled: true, injectEnabled: true, port: 20001 })
    expect(written.revision).toBe(1)
    expect(written.config.traceEnabled).toBe(true)
    expect(written.config.injectEnabled).toBe(true)
    expect(editor.writeCount).toBe(1)
    expect(editor.rows[0].config.traceEnabled).toBe(true)
    expect(editor.rows[0].config.injectEnabled).toBe(true)
  })

  it('新键非布尔值拒写（bad-request，edit 零调用、revision 不变）', async () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    const before = getSettings(editor, state).revision
    const writes = editor.editCalls

    for (const [key, value] of [
      ['actionAuditEnabled', 'yes'],
      ['traceEnabled', 1],
      ['recordInbound', null],
      ['inboxRedact', ['true']],
      ['injectEnabled', 'on'],
      ['injectDryRun', 0],
    ] as const) {
      await expect(updateSettings(editor, state, { [key]: value })).rejects.toMatchObject({ code: 'onebot-settings/bad-request' })
    }
    expect(editor.editCalls).toBe(writes) // 拒写绝不触达宿主 edit
    expect(getSettings(editor, state).revision).toBe(before)
  })
})

describe('onebotSettings remote — W6 失败守卫（configEditor 失败场景：归一 + 零补偿写）', () => {
  it('锁冲突（宿主文件锁超时）归一为中文 edit-failed：不重试、不补偿写、revision 不递增', async () => {
    const editor = new FakeConfigEditor({ host: '127.0.0.1' })
    const state = createRevisionState()
    const baseline = getSettings(editor, state)
    editor.failNextEdit = new Error('atomic-write: timed out waiting for the writer lock at /dsh/profiles/web/package.json.lock')

    await expect(updateSettings(editor, state, { traceEnabled: true })).rejects.toMatchObject({
      code: 'onebot-settings/edit-failed',
      message: expect.stringContaining('文件锁'),
      details: { hostMessage: expect.stringContaining('writer lock') },
    })
    expect(editor.editCalls).toBe(1) // 单次调用，插件侧无重试
    expect(editor.rows).toHaveLength(0) // 无补偿写：覆盖行保持失败前形态
    const after = getSettings(editor, state)
    expect(after.revision).toBe(baseline.revision)
    expect(after.config).toEqual(baseline.config) // 逐键等于写前生效值
  })

  it('校验拒绝（宿主 schema/resolveConfig 失败）归一转发，原覆盖行逐键不动', async () => {
    const editor = new FakeConfigEditor({ port: 8643 })
    const state = createRevisionState()
    const baseline = getSettings(editor, state)
    editor.failNextEdit = new Error('Invalid config: expected port to be a number in range')

    await expect(updateSettings(editor, state, { port: 20001, requireMention: false })).rejects.toMatchObject({
      code: 'onebot-settings/edit-failed',
      message: expect.stringContaining('宿主 configEditor 拒绝'),
    })
    expect(editor.rows).toHaveLength(0)
    expect(editor.entry.options.config).toEqual({ port: 8643 }) // 原覆盖行不动
    expect(getSettings(editor, state)).toMatchObject({ revision: baseline.revision })
  })

  it('激活失败回滚（写后 reconcile 失败 → 宿主还原）→ 快照恢复旧值、revision 不递增、无半态', async () => {
    const editor = new FakeConfigEditor()
    const state = createRevisionState()
    const baseline = getSettings(editor, state)
    editor.rollbackSimulate = true

    await expect(updateSettings(editor, state, { recordInbound: true, injectDryRun: false })).rejects.toMatchObject({
      code: 'onebot-settings/edit-failed',
      message: expect.stringContaining('写入失败'),
    })
    const after = getSettings(editor, state)
    expect(after.revision).toBe(baseline.revision) // 回滚后指纹与写前一致 → 不递增
    expect(after.config).toEqual(baseline.config) // 逐键还原，无半态（新键无残留）
    expect(editor.entry.options.config.recordInbound).toBeUndefined()
  })
})
