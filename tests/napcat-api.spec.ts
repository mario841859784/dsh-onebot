/**
 * qq_napcat_api 放行规则：可配置白名单（napcatApiAllow，'*' = 禁区外全放行）、
 * 写死的禁区、本机文件放行目录（napcatApiFileRoots）、只读的 "list" 伪动作。
 * 连接是录制桩，不碰网络；文件都在临时目录里。带路径参数的动作取自
 * SnowLuma v2.2.1 的动作清单（upload_group_file / set_qq_avatar /
 * set_group_portrait / upload_image_to_qun_album / add_custom_face /
 * create_flash_task / download_file_stream 等）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

import { registerTools } from '../src/tools.js'
import {
  collectLocalPathCandidates,
  configureNapcatApi,
  DEFAULT_NAPCAT_API_ALLOW,
  isDeniedAction,
  looksLikeLocalPath,
  NAPCAT_API_DENY,
  normalizeActionName,
  type NapcatApiConfig,
} from '../src/napcat-api.js'
import { Config } from '../src/index.js'
import { SCHEMA_DEFAULTS } from '../src/settings-remote.js'

interface Tool {
  name: string
  description: string
  parameters: { properties: Record<string, { description?: string }> }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** 0.11.0 写死的说明与报错（缺省配置下必须逐字节不变）。 */
const LEGACY_WHITELIST = [
  'get_group_member_list', 'get_group_member_info', 'get_stranger_info', 'get_forward_msg', 'get_record', 'get_file',
  'upload_group_file', 'upload_private_file', 'get_group_root_files', 'get_group_files_by_folder', 'get_group_file_url',
  'get_private_file_url', 'ocr_image', 'get_ai_characters', 'send_group_ai_record',
]
const LEGACY_DESCRIPTION = '调用 NapCat 白名单内的 OneBot 扩展 API（群成员列表/信息、文件、OCR、AI 语音等）。非白名单 action 会被拒绝。'
const LEGACY_ACTION_DESCRIPTION = '白名单 action：' + LEGACY_WHITELIST.join(' / ')
const LEGACY_REFUSAL = 'qq_napcat_api: action 不在白名单内（' + LEGACY_WHITELIST.join(', ') + '）'

/** 注册全部 qq_* 工具（成员档位闸按「无 QQ 会话映射 = 不受限」走 'all'），取出 qq_napcat_api。 */
function harness(config?: Partial<NapcatApiConfig>) {
  configureNapcatApi(config)
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const tools: Tool[] = []
  const ctx = new Context()
  ctx.provide('tools' as never, {
    register: (tool: Tool) => {
      tools.push(tool)
      return () => undefined
    },
  } as never)
  registerTools(ctx, { memberToolTier: () => 'all' } as never, {
    call: async (action: string, params: Record<string, unknown>) => {
      calls.push({ action, params })
      return { ok: true }
    },
  } as never, { maxImageBytes: 1, maxVoiceBytes: 1, maxFileBytes: 1 })
  const tool = tools.find(t => t.name === 'qq_napcat_api')
  if (tool === undefined) throw new Error('qq_napcat_api not registered')
  // 参数先过宿主 defineTool 的 JSON Schema 校验（action 必须是字符串、不能带 undefined 值）。
  const run = (action: string, params?: Record<string, unknown>) => tool.execute(params === undefined ? { action } : { action, params }, {})
  return { tool, calls, run }
}

async function makeDirs() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'napcat-api-')))
  const root = join(base, 'allowed')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const inside = join(root, 'pic.png')
  const secret = join(outside, 'secret.txt')
  await writeFile(inside, 'png')
  await writeFile(secret, 'secret')
  return { base, root, outside, inside, secret }
}

afterEach(() => {
  configureNapcatApi(undefined)
})

describe('缺省配置：行为与工具说明逐字节不变', () => {
  it('schema 缺省 = 原先写死的 15 个动作、放行目录为空；面板 SCHEMA_DEFAULTS 同序', () => {
    const resolved = Config({}) as unknown as { napcatApiAllow: string[]; napcatApiFileRoots: string[] }
    expect(resolved.napcatApiAllow).toEqual(LEGACY_WHITELIST)
    expect(resolved.napcatApiFileRoots).toEqual([])
    expect([...DEFAULT_NAPCAT_API_ALLOW]).toEqual(LEGACY_WHITELIST)
    expect(SCHEMA_DEFAULTS.napcatApiAllow).toEqual(LEGACY_WHITELIST)
    expect(SCHEMA_DEFAULTS.napcatApiFileRoots).toEqual([])
  })

  it('工具说明与 action 参数说明逐字节等于 0.11.0（未配置与显式写缺省值两种）', () => {
    for (const config of [undefined, { allow: [...LEGACY_WHITELIST], fileRoots: [] }]) {
      const { tool } = harness(config)
      expect(tool.description).toBe(LEGACY_DESCRIPTION)
      expect(tool.parameters.properties.action.description).toBe(LEGACY_ACTION_DESCRIPTION)
      expect(tool.parameters.properties.params.description).toBe('action 参数（JSON 对象）')
    }
  })

  it('白名单内照旧放行，参数原样转发（缺省不查本机路径）', async () => {
    const { run, calls } = harness()
    const params = { group_id: 1, file: '/etc/passwd', name: 'x' }
    await expect(run('upload_group_file', params)).resolves.toEqual({ ok: true })
    expect(calls).toEqual([{ action: 'upload_group_file', params }])
  })

  it('白名单外（含禁区动作与 "list"、大小写变体、非字符串）报错逐字节同旧版，不调协议端', async () => {
    const { run, calls } = harness()
    for (const action of ['get_cookies', 'send_packet', 'list', 'OCR_IMAGE', '.ocr_image']) {
      await expect(run(action, {})).rejects.toThrow(LEGACY_REFUSAL)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('禁区：写死在代码里，配置打不开', () => {
  const variants = [
    'get_cookies', '.get_cookies', 'nc_get_cookies', 'NC_GET_COOKIES', ' Get_Cookies ', 'get_cookies_async',
    'get_credentials', '_get_credentials', 'get_clientkey', 'nc_get_clientkey', '.get_clientkey',
    'get_csrf_token', 'get_csrf_token_rate_limited', 'request_decrypt_key',
    'send_packet', '.send_packet', 'nc_send_packet', 'send_packet_async', '..SEND_PACKET',
    'bot_exit', 'set_restart', 'set_restart_rate_limited', 'set_restart_plugin',
    '.handle_quick_operation', 'handle_quick_operation', '.handle_quick_operation_async',
  ]

  it('动作名先去前导点 / 下划线、统一大小写、去 nc_ 前缀和 _async / _rate_limited 后缀再比', () => {
    expect(normalizeActionName('.Send_Packet')).toBe('send_packet')
    expect(normalizeActionName('nc_get_cookies_async')).toBe('get_cookies')
    expect(normalizeActionName('._nc_.handle_quick_operation')).toBe('handle_quick_operation')
    for (const name of variants) expect(isDeniedAction(name), name).toBe(true)
    for (const name of ['get_login_info', 'get_cookies_count', 'send_group_msg', 'get_rkey', 'ocr_image', 'set_group_portrait']) {
      expect(isDeniedAction(name), name).toBe(false)
    }
    expect([...NAPCAT_API_DENY].sort()).toEqual([
      'bot_exit', 'get_client_key', 'get_clientkey', 'get_cookie', 'get_cookies', 'get_credentials', 'get_csrf',
      'get_csrf_token', 'handle_quick_operation', 'request_decrypt_key', 'send_packet', 'set_restart', 'set_restart_plugin',
    ])
  })

  it("allow 写 '*' 或把禁区动作逐个写进白名单都放不开；报错说明是禁区；不调协议端", async () => {
    for (const allow of [['*'], [...variants], ['*', ...variants]]) {
      const { run, calls } = harness({ allow })
      for (const action of variants) {
        await expect(run(action, {}), action).rejects.toThrow(/在禁区内，配置也不能放行/)
      }
      expect(calls).toHaveLength(0)
    }
  })
})

describe("allow 为 '*'：禁区外全部放行", () => {
  it('任意非禁区动作放行；说明换成「除禁区外的 OneBot 11 / NapCat 扩展动作」并提 list', async () => {
    const { tool, run, calls } = harness({ allow: ['*'] })
    expect(tool.description).toContain('除禁区外的 OneBot 11 / NapCat 扩展动作')
    expect(tool.description).toContain('action 填 "list" 可查看当前放行规则')
    expect(tool.description).not.toContain('参数里的本机文件')
    expect(tool.parameters.properties.action.description).toBe('除禁区外的 OneBot 11 / NapCat 扩展动作名；"list" = 查看当前放行规则')
    await run('get_login_info', {})
    await run('set_group_portrait', { group_id: 1, file: '/anything/outside.png' }) // 未配放行目录：不查路径（同以前）
    expect(calls.map(c => c.action)).toEqual(['get_login_info', 'set_group_portrait'])
  })

  it('"list" 回规则快照，不调协议端', async () => {
    const { run, calls } = harness({ allow: ['*'] })
    const listing = await run('list') as Record<string, unknown>
    expect(listing.allow).toBe('*')
    expect(listing.deny).toEqual([...NAPCAT_API_DENY])
    expect(listing.fileRoots).toEqual([])
    expect(String(listing.fileCheck)).toContain('不检查')
    expect(calls).toHaveLength(0)
  })
})

describe('allow 为自定义列表', () => {
  it('只放列表里的；列表外报白名单错误并提 list；list 回数组', async () => {
    const { tool, run, calls } = harness({ allow: [' get_login_info ', 'get_login_info', ''] })
    expect(tool.parameters.properties.action.description).toBe('白名单 action：get_login_info；"list" = 查看当前放行规则')
    await run('get_login_info', {})
    await expect(run('ocr_image', {})).rejects.toThrow('qq_napcat_api: action 不在白名单内（get_login_info）；"list" 可查看当前放行规则')
    await expect(run('', {})).rejects.toThrow(/action 必填/)
    expect(await run('list')).toMatchObject({ allow: ['get_login_info'] })
    expect(calls.map(c => c.action)).toEqual(['get_login_info'])
  })

  it('白名单与缺省同内容但配了放行目录：说明提放行目录与 list（不再走旧文案）', async () => {
    const { root } = await makeDirs()
    const { tool } = harness({ allow: [...LEGACY_WHITELIST], fileRoots: [root] })
    expect(tool.description).not.toBe(LEGACY_DESCRIPTION)
    expect(tool.description).toContain('参数里的本机文件（绝对路径或 file:// 地址）必须在放行目录内')
    expect(tool.parameters.properties.action.description).toBe(LEGACY_ACTION_DESCRIPTION + '；"list" = 查看当前放行规则')
  })
})

describe('「像本机文件」的认法', () => {
  it('绝对路径 / file: / UNC / 设备路径 / ./ ../ / 盘符相对路径（C:foo）算；http(s)://、base64://、普通文字、裸文件名不算', () => {
    for (const v of ['C:\\x\\y.png', 'c:/x', 'C:foo', 'Q:hello', '/etc/passwd', '\\\\server\\share\\x', '\\\\?\\C:\\x', '\\??\\C:\\x', '//server/share',
      'file:///C:/x', 'FILE://x', 'file:x', './a.png', '../a.png', '..\\a.png', '..']) {
      expect(looksLikeLocalPath(v), v).toBe(true)
    }
    for (const v of ['https://example.com/a.png', 'http://127.0.0.1/a', 'base64://AAAA', 'abc.image', 'hello world', 'a/b.png', '']) {
      expect(looksLikeLocalPath(v), v).toBe(false)
    }
  })

  it('递归数组 / 嵌套对象 / CQ 码参数；正文键只看 CQ 码；群文件目录键不当本机路径', () => {
    const found = collectLocalPathCandidates({
      file: '/a',
      files: ['C:\\b', 'https://x/y'],
      message: [{ type: 'image', data: { file: 'file:///c', url: 'http://x' } }, { type: 'text', data: { text: '/help' } }],
      content: '看这个 [CQ:image,file=file:///d&#44;e,summary=x] 和 [CQ:record,file=/f]',
      raw_message: '/new',
      folder: '/',
      parent_directory: '/abc',
      deep: { deeper: { thumb_path: '/g' } },
    }).map(c => c.value)
    expect(found).toEqual(['/a', 'C:\\b', 'file:///c', 'file:///d,e', '/f', '/g'])
  })
})

describe('本机文件放行目录（napcatApiFileRoots）', () => {
  /** SnowLuma v2.2.1 里带本机文件参数的动作：参数位置 → 用一个路径组装 params。 */
  const PATH_ACTIONS: Array<[string, (p: string) => Record<string, unknown>]> = [
    ['upload_group_file', p => ({ group_id: 1, file: p, name: 'a.png', folder: '/' })],
    ['upload_private_file', p => ({ user_id: 1, file: p })],
    ['set_qq_avatar', p => ({ file: p })],
    ['set_group_portrait', p => ({ group_id: 1, file: p })],
    ['upload_image_to_qun_album', p => ({ group_id: 1, album_id: 'a', album_name: 'b', file: p })],
    ['upload_video_to_qun_album', p => ({ group_id: 1, album_id: 'a', album_name: 'b', file: p })],
    ['add_custom_face', p => ({ file: p })],
    ['create_flash_task', p => ({ files: [p], name: 'x' })],
    ['create_flash_task', p => ({ files: [], thumb_path: p })],
    ['download_file_stream', p => ({ file: p })],
    ['download_file_image_stream', p => ({ file: p })],
    ['ocr_image', p => ({ image: p })],
    ['send_group_msg', p => ({ group_id: 1, message: [{ type: 'image', data: { file: p } }] })],
    ['send_private_msg', p => ({ user_id: 1, message: '[CQ:image,file=' + pathToFileURL(p).href + ']' })],
  ]

  it('放行目录里的文件放行、参数原样转发；目录外一律拒绝且不调协议端', async () => {
    const d = await makeDirs()
    const { run, calls } = harness({ allow: ['*'], fileRoots: [d.root] })
    for (const [action, build] of PATH_ACTIONS) {
      const params = build(d.inside)
      await expect(run(action, params), action + ' inside').resolves.toEqual({ ok: true })
      expect(calls.at(-1)).toEqual({ action, params })
    }
    const before = calls.length
    for (const [action, build] of PATH_ACTIONS) {
      await expect(run(action, build(d.secret)), action + ' outside').rejects.toThrow(/不在放行目录（napcatApiFileRoots）内/)
    }
    expect(calls).toHaveLength(before)
  })

  it('盘符相对路径（C:foo 这类无分隔符写法）fail closed 拒绝且不调协议端（T5：堵住绕过 napcatApiFileRoots 检查的洞）', async () => {
    const d = await makeDirs()
    const { run, calls } = harness({ allow: ['*'], fileRoots: [d.root] })
    for (const [action, build] of PATH_ACTIONS) {
      await expect(run(action, build('C:foo')), action + ' drive-relative').rejects.toThrow(/不在放行目录（napcatApiFileRoots）内/)
    }
    expect(calls).toHaveLength(0)
  })

  it('file:// 地址按两种读法核对；网络共享的 file:// 拒绝', async () => {
    const d = await makeDirs()
    const { run } = harness({ allow: ['*'], fileRoots: [d.root] })
    await expect(run('set_qq_avatar', { file: pathToFileURL(d.inside).href })).resolves.toEqual({ ok: true })
    await expect(run('set_qq_avatar', { file: pathToFileURL(d.secret).href })).rejects.toThrow(/不在放行目录/)
    await expect(run('set_qq_avatar', { file: 'file://server/share/pic.png' })).rejects.toThrow(/不在放行目录/)
    await expect(run('set_qq_avatar', { file: 'file://../outside/secret.txt' })).rejects.toThrow(/不在放行目录/)
  })

  it('.. 越界、相对路径、不存在的文件、UNC、\\\\?\\、\\??\\、NTFS 流、NUL 一律拒绝', async () => {
    const d = await makeDirs()
    const { run, calls } = harness({ allow: ['*'], fileRoots: [d.root] })
    const bad = [
      join(d.root, '..', 'outside', 'secret.txt'),
      d.root + '/../outside/secret.txt',
      './pic.png',
      '../outside/secret.txt',
      join(d.root, 'missing.png'),
      '\\\\server\\share\\pic.png',
      '//server/share/pic.png',
      '\\\\?\\' + d.inside,
      '\\\\.\\' + d.inside,
      '\\??\\' + d.inside,
      d.inside + ':evil',
      d.inside + '::$DATA',
      d.inside + '\0.png',
    ]
    for (const p of bad) {
      await expect(run('set_group_portrait', { group_id: 1, file: p }), JSON.stringify(p)).rejects.toThrow(/不在放行目录/)
    }
    expect(calls).toHaveLength(0)
  })

  it('放行目录里指向目录外的链接（Windows 用目录联接）拒绝；目录本身是链接时按真实路径比', async () => {
    const d = await makeDirs()
    const link = join(d.root, 'escape')
    await symlink(d.outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const { run } = harness({ allow: ['*'], fileRoots: [d.root] })
    await expect(run('set_qq_avatar', { file: join(link, 'secret.txt') })).rejects.toThrow(/不在放行目录/)
    // 放行目录配成一个链接：链接后面的真实目录里的文件放行
    const rootLink = join(d.base, 'root-link')
    await symlink(d.root, rootLink, process.platform === 'win32' ? 'junction' : 'dir')
    const viaLink = harness({ allow: ['*'], fileRoots: [rootLink] })
    await expect(viaLink.run('set_qq_avatar', { file: d.inside })).resolves.toEqual({ ok: true })
    await expect(viaLink.run('set_qq_avatar', { file: d.secret })).rejects.toThrow(/不在放行目录/)
  })

  it.runIf(process.platform === 'win32')('Windows：路径大小写不同照样认得出在不在放行目录里', async () => {
    const d = await makeDirs()
    const { run } = harness({ allow: ['*'], fileRoots: [d.root.toLowerCase()] })
    await expect(run('set_qq_avatar', { file: d.inside.toUpperCase() })).resolves.toEqual({ ok: true })
    await expect(run('set_qq_avatar', { file: d.secret.toUpperCase() })).rejects.toThrow(/不在放行目录/)
  })

  it('http(s)://、base64://、正文里的「/help」、群文件目录「/」不受影响', async () => {
    const d = await makeDirs()
    const { run, calls } = harness({ allow: ['*'], fileRoots: [d.root] })
    await run('download_file', { url: 'https://example.com/a.png', name: 'a.png' })
    await run('download_file', { base64: 'AAAA', name: 'a.bin' })
    await run('set_qq_avatar', { file: 'base64://AAAA' })
    await run('send_group_msg', { group_id: 1, message: '/help 看看' })
    await run('send_group_msg', { group_id: 1, message: [{ type: 'text', data: { text: '/etc/passwd 是什么' } }] })
    await run('get_group_files_by_folder', { group_id: 1, folder: '/abc' })
    await run('move_group_file', { group_id: 1, file_id: 'x', parent_directory: '/', target_directory: '/abc' })
    expect(calls).toHaveLength(7)
  })

  it('白名单仍然先判：放行目录不让白名单外的动作通过；list 回放行目录', async () => {
    const d = await makeDirs()
    const { run, calls } = harness({ fileRoots: [d.root] })
    await expect(run('set_qq_avatar', { file: d.inside })).rejects.toThrow(/不在白名单内/)
    await expect(run('upload_group_file', { group_id: 1, file: d.secret })).rejects.toThrow(/不在放行目录/)
    await run('upload_group_file', { group_id: 1, file: d.inside })
    expect(calls).toHaveLength(1)
    const listing = await run('list') as Record<string, unknown>
    expect(listing.allow).toEqual(LEGACY_WHITELIST)
    expect(listing.fileRoots).toEqual([d.root])
  })
})
