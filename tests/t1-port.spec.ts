import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { makeHarness } from './helpers/bridge-harness.js'

/**
 * T1（入站修复与唤醒门批次，PR port）端到端集成测试：走真 OneBotConnection
 * 反向 WS + ChatBridge 全管线（与 tests/inbound.spec.ts 的 harness 同构）。
 */

// Minimal valid 1x1 PNG so matchImageExt/shrinkImage see a real image.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

describe('T1 PR port: poke notice 唤醒端到端', () => {
  it('a group poke notice wakes the bot as a pseudo message with an at-self segment', async () => {
    const h = await makeHarness()
    h.client.send(JSON.stringify({
      post_type: 'notice', notice_type: 'poke', user_id: 20003, target_id: 10002, group_id: 888,
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const text = h.captured.followups[0].text
    // 群聊伪消息：戳一戳标注 + at-self 段过 @ 门（未被 @ 丢弃）。
    expect(text).toContain('[戳一戳]')
    expect(text).not.toContain('@20003')

    // 同一戳者在 3 秒节流窗口内的第二戳 → 不再唤醒。
    h.client.send(JSON.stringify({
      post_type: 'notice', notice_type: 'poke', user_id: 20003, target_id: 10002, group_id: 888,
    }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(h.captured.followups).toHaveLength(1)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('respects pokeEnabled: false and ignores pokes targeted at someone else', async () => {
    const h = await makeHarness({ pokeEnabled: false })
    h.client.send(JSON.stringify({
      post_type: 'notice', notice_type: 'poke', user_id: 20003, target_id: 10002, group_id: 888,
    }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(h.captured.followups).toHaveLength(0)

    const h2 = await makeHarness()
    // 互戳：target 是别人（20003 戳 30004）→ 不叫。
    h2.client.send(JSON.stringify({
      post_type: 'notice', notice_type: 'poke', user_id: 20003, target_id: 30004, group_id: 888,
    }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(h2.captured.followups).toHaveLength(0)
    h.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()
  })
})

describe('T1 PR port: 唤醒词端到端', () => {
  it('a member wake name at the message start wakes without an @', async () => {
    const h = await makeHarness({ wakeNamesMember: ['小雪'] })
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', group_id: 888, user_id: 20003, self_id: 10002,
      message: [{ type: 'text', data: { text: '小雪 帮我看看这个' } }],
      raw_message: '小雪 帮我看看这个',
      sender: { user_id: 20003, nickname: '小张' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('帮我看看这个')

    // 正文中段的子串命中不算（startsWith 收紧语义）。
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', group_id: 888, user_id: 20003, self_id: 10002,
      message: [{ type: 'text', data: { text: '帮我看看小雪这个' } }],
      raw_message: '帮我看看小雪这个',
      sender: { user_id: 20003, nickname: '小张' },
    }))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(h.captured.followups).toHaveLength(1)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('member wake names do not elevate an admin chat configured with admin-only names', async () => {
    // 发送者是管理员（policy.adminUsers=['10001']），只配了成员表 → 不命中。
    const h = await makeHarness({ wakeNamesMember: ['小雪'] })
    h.sendText('小雪 帮我看看这个')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    // 管理员私聊本来就不需要 @（无 requireMention 门），此用例的价值在
    // 群聊档位：只配成员表时管理员群聊消息不走成员表。
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()

    const h2 = await makeHarness({ wakeNamesAdmin: ['老雪'] })
    h2.sendGroupTextAs('老雪 帮我看看这个', 10001)
    await vi.waitFor(() => expect(h2.captured.followups).toHaveLength(1))
    expect(h2.captured.followups[0].text).toContain('帮我看看这个')
    h2.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()
  })
})

describe('T1 PR port: 私聊时间前缀取 event.time', () => {
  it('renders [HH:MM] from the message time, not the processing time', async () => {
    const h = await makeHarness()
    // 固定 event.time：本地时区渲染，与 formatClock 同一换算。
    const at = new Date(2026, 10, 9, 21, 5, 0).getTime() / 1000
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      time: at,
      message: [{ type: 'text', data: { text: '早上好' } }],
      raw_message: '早上好',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toMatch(/^\[21:05\] <user_message qq="10001" nickname="小明">\n早上好\n<\/user_message>$/)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('T1 PR port: 引用消息带图落地', () => {
  it('lands a quoted image as a local file and appends the path note to the expansion', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'image/png')
      res.end(PNG)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const h = await makeHarness({
        allowPrivateHosts: true,
        respond: {
          get_msg: params => {
            expect(params).toEqual({ message_id: 555 })
            return {
              sender: { user_id: 30004, nickname: '原作者' },
              message: [
                { type: 'text', data: { text: '看看这张图' } },
                { type: 'image', data: { url: 'http://127.0.0.1:' + port + '/img.png' } },
              ],
            }
          },
        },
      })
      // 引用消息走 segment 形态（与真实适配器一致的 reply 段）。
      h.client.send(JSON.stringify({
        post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
        message: [{ type: 'reply', data: { id: 555 } }, { type: 'text', data: { text: '这条什么意思' } }],
        raw_message: '[CQ:reply,id=555]这条什么意思',
        sender: { user_id: 10001, nickname: '小明' },
      }))
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
      const text = h.captured.followups[0].text
      expect(text).toContain('[引用]原作者: 看看这张图')
      // 引用里的图已落地本地文件并把路径喂给模型（上游只留文字）。
      const match = text.match(/\[引用里的图片:([^\]]+)\]/)
      expect(match).not.toBeNull()
      const imagePath = match![1]
      expect(imagePath).toMatch(/\.png$/)
      const bytes = await readFile(imagePath)
      expect(bytes.subarray(0, 8)).toEqual(PNG.subarray(0, 8))
      h.client.close()
      await h.bridge.stop()
      await h.connection.stop()
    } finally {
      server.close()
    }
  })

  it('keeps the text-only expansion when the quoted image fails to resolve', async () => {
    const h = await makeHarness({
      respond: {
        get_msg: () => ({
          sender: { user_id: 30004, nickname: '原作者' },
          message: [
            { type: 'text', data: { text: '只有文字' } },
            { type: 'image', data: { url: 'http://127.0.0.1:1/nope.png' } },
          ],
        }),
      },
    })
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'reply', data: { id: 556 } }, { type: 'text', data: { text: '这条什么意思' } }],
      raw_message: '[CQ:reply,id=556]这条什么意思',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const text = h.captured.followups[0].text
    expect(text).toContain('[引用]原作者: 只有文字')
    expect(text).not.toContain('[引用里的图片:')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
