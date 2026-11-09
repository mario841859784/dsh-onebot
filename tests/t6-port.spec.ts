/**
 * T6 tests: GIF 分帧可选模块（gif-sheet.ts + inbound 接线）与官方表情名表
 * （qq-faces.ts + cq.ts faceStyle）。覆盖：开关两侧、依赖缺失/失败静默降级、
 * 资源上限先于依赖加载、键表转正（gifFramesEnabled 入表、faceStyle 出豁免）。
 * @module dsh-onebot/tests/t6-port
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

import { gifFramesNote, gifSheet, MAX_FILE_BYTES, MAX_DIMENSION, MAX_FRAMES } from '../src/gif-sheet.js'
import { faceNames, faceToEmoji, parseMessage, setFaceStyle } from '../src/cq.js'
import { QQ_FACES } from '../src/qq-faces.js'
import { Config } from '../src/index.js'
import { ALL_KEYS, PENDING_SCHEMA_KEYS, SCHEMA_DEFAULTS, SETTINGS_GROUPS } from '../src/settings-remote.js'

/** Failing loader: 依赖缺失（--omit=optional）时 gifSheet 走到的路径。 */
const missingDepSheet = async (): Promise<never> => {
  throw new Error("Cannot find module 'gifuct-js' Require stack: /somewhere/without/optional-deps")
}

describe('T6 官方表情名表（qq-faces.ts + cq.ts faceStyle）', () => {
  it('内置表与贡献者 qq-faces.json 抽样一致：329 条、冻结', () => {
    const names = faceNames()
    expect(Object.keys(names)).toHaveLength(329)
    expect(names['0']).toBe('惊讶')
    expect(names['14']).toBe('微笑')
    expect(names['2']).toBe('色')
    expect(names['63']).toBe('玫瑰')
    expect(names['484']).toBe('比爱心')
    expect(Object.isFrozen(QQ_FACES)).toBe(true)
    // 每条名称非空且不含 CQ 会用到的定界符。
    for (const [id, name] of Object.entries(names)) {
      expect(id).toMatch(/^\d+$/)
      expect(name).not.toBe('')
      expect(name).not.toMatch(/[\[\]]/)
    }
  })

  it('faceStyle 默认 name：有名 [名]、表外 [表情id]', () => {
    setFaceStyle('name')
    expect(faceToEmoji('14')).toBe('[微笑]')
    expect(faceToEmoji('484')).toBe('[比爱心]')
    expect(faceToEmoji('999999')).toBe('[表情999999]')
  })

  it('setFaceStyle 非法值回落 name；emoji 恢复旧对照（表外塌成 😀）', () => {
    setFaceStyle('emoji')
    expect(faceToEmoji('14')).toBe('🥰')
    expect(faceToEmoji('999999')).toBe('😀')
    setFaceStyle('bogus')
    expect(faceToEmoji('14')).toBe('[微笑]')
  })

  it('parseMessage 的 face 段按当前风格呈现', () => {
    setFaceStyle('name')
    const segs = [{ type: 'face', data: { id: '14' } }]
    expect(parseMessage(segs, '').text).toContain('[微笑]')
    setFaceStyle('emoji')
    expect(parseMessage(segs, '').text).toContain('🥰')
    setFaceStyle('name')
  })
})

describe('T6 GIF 分帧（gif-sheet.ts + inbound 接线）', () => {
  it('默认（gifFramesEnabled=false）完全不动作：不调用分帧、返回空串', async () => {
    const sheet = vi.fn(async () => { throw new Error('不该被调用') })
    await expect(gifFramesNote('/tmp/a.gif', false, sheet)).resolves.toBe('')
    expect(sheet).not.toHaveBeenCalled()
  })

  it('非 .gif 后缀不动作（与贡献者一致：/\\.gif$/i 大小写不敏感判定）', async () => {
    const sheet = vi.fn(async () => undefined)
    await expect(gifFramesNote('/tmp/a.png', true, sheet)).resolves.toBe('')
    expect(sheet).not.toHaveBeenCalled()
  })

  it('大写 .GIF 后缀与贡献者一致：同样触发分帧，out 去掉大写后缀加 -frames.png', async () => {
    const sheet = vi.fn(async () => undefined)
    await expect(gifFramesNote('/media/pics/cat.GIF', true, sheet)).resolves.toBe('\n[动图分帧:/media/pics/cat-frames.png]')
    expect(sheet).toHaveBeenCalledWith('/media/pics/cat.GIF', '/media/pics/cat-frames.png', 4)
  })

  it('开启且成功：注入假分帧，得到 [动图分帧:out] 附注（out 去后缀加 -frames.png）', async () => {
    const sheet = vi.fn(async () => undefined)
    await expect(gifFramesNote('/media/pics/cat.gif', true, sheet)).resolves.toBe('\n[动图分帧:/media/pics/cat-frames.png]')
    expect(sheet).toHaveBeenCalledWith('/media/pics/cat.gif', '/media/pics/cat-frames.png', 4)
  })

  it('依赖缺失（gifuct-js 未安装）：静默降级为空串，不抛错', async () => {
    await expect(gifFramesNote('/tmp/a.gif', true, missingDepSheet)).resolves.toBe('')
  })

  it('文件异常/超限等任何失败：一律静默为空串', async () => {
    await expect(gifFramesNote('/tmp/不存在.gif', true, async () => { throw new Error('动图 9MB，超过分帧上限') })).resolves.toBe('')
    await expect(gifFramesNote('/tmp/a.gif', true, async () => { throw new Error('ENOENT') })).resolves.toBe('')
  })

  it('gifSheet 真实失败路径：文件不存在抛错（错误被 note 包装成静默）', async () => {
    await expect(gifSheet('/tmp/t6-不存在-8f2a1c.gif', '/tmp/x.png')).rejects.toThrow()
    const dir = mkdtempSync(join(tmpdir(), 't6-gif-'))
    const big = join(dir, 'big.gif')
    writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0))
    // 资源上限先于依赖加载：8MiB+1 直接拒绝。
    await expect(gifSheet(big, join(dir, 'out.png'))).rejects.toThrow('分帧上限')
  })

  it('资源上限常量与贡献者一致', () => {
    expect(MAX_FILE_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_DIMENSION).toBe(1024)
    expect(MAX_FRAMES).toBe(150)
  })

  it('贡献者的硬编码 Android 路径兜底与 DSH_PROFILE_NM 覆盖已删除（源码级红线断言）', () => {
    const source = readFileSync(new URL('../src/gif-sheet.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('DSH_PROFILE_NM')
    expect(source).not.toContain('/data/data/com.dsharnessmobile.shell')
    expect(source).toContain('createRequire(import.meta.url)')
  })

  it('import 本模块在宿主进程内安全（CLI 守卫不把宿主 argv 当文件名）', async () => {
    // process.argv[1] 是 vitest 二进制——import 时不允许任何分帧尝试。
    await expect(import('../src/gif-sheet.js')).resolves.toBeTruthy()
  })
})

describe('T6 键表转正（gifFramesEnabled 入表 / faceStyle 出豁免）', () => {
  const resolved = Config({}) as Record<string, unknown>

  it('gifFramesEnabled：media 组 + 布尔通道 + 默认 false + schema 已定义', () => {
    expect(SETTINGS_GROUPS.media).toContain('gifFramesEnabled')
    expect(ALL_KEYS).toContain('gifFramesEnabled')
    expect(SCHEMA_DEFAULTS.gifFramesEnabled).toBe(false)
    expect(resolved.gifFramesEnabled).toBe(false)
  })

  it('faceStyle：schema 已定义且默认 name，已不在 PENDING 豁免名单', () => {
    expect(resolved.faceStyle).toBe('name')
    expect(SCHEMA_DEFAULTS.faceStyle).toBe('name')
    expect(PENDING_SCHEMA_KEYS).not.toContain('faceStyle')
  })
})
