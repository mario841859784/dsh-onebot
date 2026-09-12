import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import WebSocket from 'ws'

import { OneBotConnection } from '../src/connection.js'
import { ChatBridge } from '../src/bridge.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

import { makeCmdHarness, makeEvent, makeFakeAgents, makeHarness } from './helpers/bridge-harness.js'

describe('ChatBridge', () => {
  it('slash /new retirement is durable: the retired file records the bare id and a restart skips it (registry round-trip)', async () => {
    // Re-create the pre-split retirement state (the command-side segments
    // moved to commands.spec.ts): one message on the bare id, then /new
    // retires it and the next message re-creates on a suffixed id.
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.sessionIds).toHaveLength(1)
    h.sendText('/new')
    await vi.waitFor(() => expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('已开启新会话'))).toBe(true))
    h.sendText('新对话的第一条')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.sessionIds).toHaveLength(2)
    expect(h.sessionIds[1]).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
    // The retirement is durable: retired-sessions.json records the first
    // session id, so a restart never reuses it.
    const { readFile } = await import('node:fs/promises')
    await vi.waitFor(async () => {
      const retired = JSON.parse(await readFile(join(h.mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
      expect(retired).toContain('onebot-private-10001')
    })
    // Restart simulation: a fresh bridge on the same media dir must skip
    // the retired bare id and open the next message on a new suffixed id.
    const h2 = await makeHarness({ mediaDir: h.mediaDir })
    h2.sendText('重启后第一条')
    await vi.waitFor(() => expect(h2.captured.followups).toHaveLength(1))
    expect(h2.sessionIds).toHaveLength(1)
    expect(h2.sessionIds[0]).toMatch(/^onebot-private-10001-[a-z0-9]+$/)
    h2.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('auto-recalls each interim individually after interimRecallMs even before turn/end', async () => {
    const h = await makeCmdHarness({ interimRecallMs: 40 })
    h.sendText('开始长任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }

    // A tool-carrying interim is sent live immediately.
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'im-1', content: [
        { type: 'text', text: '第一步：查资料' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      ] },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('第一步'))).toBe(true)
    })

    // Its own 40ms timer recalls it while the turn is still running.
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'delete_msg')).toBe(true)
    }, { timeout: 3000 })

    // turn/end settles without throwing; the interim is already revoked.
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.outbound.filter(f => f.action === 'send_private_forward_msg')).toHaveLength(0)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('gates file edits by QQ admin for onebot chats (A1: non-QQ allowed)', async () => {
    const h = await makeCmdHarness()
    // Non-QQ session id: not in the chat mapping → allowed.
    expect(h.bridge.canEditFiles('some-web-session')).toBe(true)

    // An admin (10001) dispatches a turn; the role freezes at turn/start →
    // allowed for that turn.
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/start', { turn: 1 }))
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(true)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('freezes the edit role per turn in private chats: member turns stay denied and the admin turn is allowed (M1-A2)', async () => {
    const h = await makeCmdHarness({ allowAllUsers: true })
    // Member (10003) private chat: the turn opens with the member role, and a
    // second queued member turn keeps its own role after the first one ends.
    h.sendTextAs('请帮我修改文件', 10003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendTextAs('再改一处', 10003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    const memberSession = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', memberSession as never, makeEvent('turn/start', { turn: 1 }))
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(false)
    h.ctx.emit('session/event', memberSession as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    h.ctx.emit('session/event', memberSession as never, makeEvent('turn/start', { turn: 2 }))
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(false)

    // The admin's own private chat opens its turn with the admin role.
    h.sendTextAs('你好', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    h.ctx.emit('session/event', { id: h.sessionIds[1] } as never, makeEvent('turn/start', { turn: 1 }))
    expect(h.bridge.canEditFiles(h.sessionIds[1])).toBe(true)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('keeps a running member turn member-gated when an admin interjects in a group (M1-A2)', async () => {
    const h = await makeCmdHarness()
    // Group member (20003) starts a long-running turn.
    h.sendGroupTextAs('请帮我修改文件', 20003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 1 }))
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(false)

    // Admin interjects mid-turn: the admin role queues for the NEXT turn, but
    // the running member turn keeps its frozen role (the old lastUserId-based
    // gate elevated it mid-turn — TOCTOU).
    h.sendGroupTextAs('管理员插话', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(false)

    // The admin's queued turn opens → allowed for that turn.
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 2 }))
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(true)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('fails closed to member on turn/start with an empty dispatch queue (host-initiated turn, M1-A2)', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    // The admin's dispatched turn → allowed while it runs.
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 1 }))
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(true)
    // A turn the plugin never dispatched (host/web input on the same session)
    // finds the queue empty → member, never inheriting the previous role.
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 2 }))
    expect(h.bridge.canEditFiles(h.sessionIds[0])).toBe(false)

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('sets busy at turn/start and clears at turn/end, gating /retry (M1-B7)', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('turn/start', { turn: 1 }))
    h.sendText('/retry')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('当前正在生成'))).toBe(true)
    })
    expect(h.captured.followups).toHaveLength(1) // /retry did not re-feed while busy
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    h.sendText('/retry')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  // ---------------------------------------------------------- M2-T0: five-split characterization hardening

  // ------------------------------------------------------------ M2-C2: shared assembly (create vs resume)

  function chatsOf(h: { bridge: unknown }): Map<string, { lastNickname: string } & Record<string, unknown>> {
    return (h.bridge as unknown as { chats: Map<string, { lastNickname: string } & Record<string, unknown>> }).chats
  }

  it('characterization (M2-C2): lastNickname source per assembly path — create seeds it from the message, resume starts empty and the first message re-seeds it', async () => {
    const h1 = await makeHarness()
    h1.sendText('你好')
    await vi.waitFor(() => expect(h1.captured.followups).toHaveLength(1))
    // Create path (ensureChat): the inbound message's sanitized nickname seeds lastNickname.
    expect(chatsOf(h1).get('private:10001')!.lastNickname).toBe('小明')
    h1.client.close()
    await h1.bridge.stop()
    await h1.connection.stop()

    // Resume path (loadMapping): the mapping file records no nickname, the
    // resumed agent starts with the pre-C2 hardcoded '' and the first
    // post-resume message re-seeds it from its own sender.
    const h2 = await makeHarness({ mediaDir: h1.mediaDir, resumeOk: true })
    await vi.waitFor(() => expect(chatsOf(h2).get('private:10001')).toBeDefined())
    expect(chatsOf(h2).get('private:10001')!.lastNickname).toBe('')
    h2.sendText('重启后第一条')
    await vi.waitFor(() => expect(h2.captured.followups).toHaveLength(1))
    expect(chatsOf(h2).get('private:10001')!.lastNickname).toBe('小明')
    h2.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()
  })

  it('field snapshot (M2-C2): create and resume assemble identical initial ChatAgent state apart from the intended lastNickname divergence', async () => {
    // Assembly-initial state only (identity/handle fields excluded; runtime
    // message effects excluded by driving ensureChat directly — the registry
    // internal-path direct call is this file's convention).
    const snapshot = (c: Record<string, unknown>) => ({
      pendingFinal: c.pendingFinal,
      loopPending: c.loopPending,
      loopBuffer: c.loopBuffer,
      recallTimers: c.recallTimers,
      recalledInterimIds: c.recalledInterimIds,
      lastHandledMessageId: c.lastHandledMessageId,
      busy: c.busy,
      dispatchTimes: c.dispatchTimes,
      rateLimitNoticeAt: c.rateLimitNoticeAt,
      pendingTurnRoles: c.pendingTurnRoles,
      activeTurnRole: c.activeTurnRole,
      lastFollowup: c.lastFollowup,
      selectionRef: c.selectionRef,
      typingTimer: c.typingTimer,
    })
    const h1 = await makeHarness()
    await (h1.bridge as unknown as { ensureChat(chatId: string, nickname: string): Promise<unknown> }).ensureChat('private:10001', '小明')
    const created = chatsOf(h1).get('private:10001')!
    const createdSnapshot = snapshot(created)
    h1.client.close()
    await h1.bridge.stop()
    await h1.connection.stop()

    // Resume path: loadMapping assembles the resumed agent from the mapping.
    const h2 = await makeHarness({ mediaDir: h1.mediaDir, resumeOk: true })
    await vi.waitFor(() => expect(chatsOf(h2).get('private:10001')).toBeDefined())
    const resumed = chatsOf(h2).get('private:10001')!
    expect(snapshot(resumed)).toEqual(createdSnapshot)
    // The one deliberate divergence, kept per caller in the C2 factory:
    expect(created.lastNickname).toBe('小明')
    expect(resumed.lastNickname).toBe('')
    // Identity fields differ by construction (two distinct agent instances).
    expect(created.agent).not.toBe(resumed.agent)
    h2.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()
  })

  it('inbound pipeline order: policy gate → mention gate → command router → media → quote → dispatch (M2-T0 pipeline)', async () => {
    const h = await makeCmdHarness()
    const order: string[] = []
    const target = h.bridge as unknown as {
      tryHandleCommand(chatId: string, text: string, userId: string): Promise<boolean>
      buildBody(text: string, media: unknown[], chatId: string): Promise<string>
      expandQuote(messageId: string): Promise<string>
      dispatchFollowup(chatId: string, text: string, role: string, nickname?: string): Promise<void>
    }
    const realCommand = target.tryHandleCommand.bind(h.bridge)
    target.tryHandleCommand = async (chatId, text, userId) => {
      order.push('command')
      return await realCommand(chatId, text, userId)
    }
    const realBody = target.buildBody.bind(h.bridge)
    target.buildBody = async (text, media, chatId) => {
      order.push('media')
      return await realBody(text, media, chatId)
    }
    const realQuote = target.expandQuote.bind(h.bridge)
    target.expandQuote = async (messageId) => {
      order.push('quote')
      return await realQuote(messageId)
    }
    const realDispatch = target.dispatchFollowup.bind(h.bridge)
    target.dispatchFollowup = async (chatId, text, role, nickname) => {
      order.push('dispatch')
      return await realDispatch(chatId, text, role, nickname)
    }
    const realCall = h.connection.call.bind(h.connection)
    h.connection.call = (async (action: string, params: unknown) => {
      if (action === 'get_msg') {
        return { message: [{ type: 'text', data: { text: '被引用的原文' } }], raw_message: '被引用的原文', sender: { nickname: '引用来源' } }
      }
      return await realCall(action, params)
    }) as never

    // 1. policy gate: a non-admin private DM is dropped before everything
    //    (dmPolicy 'open' admits admins only).
    h.sendTextAs('私聊成员消息', 10003)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(order).toEqual([])
    expect(h.captured.followups).toHaveLength(0)

    // 2. mention gate: an unmentioned group message is dropped before the
    //    command router (no rejection notice either).
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 10001, group_id: 888, self_id: 10002,
      message: [{ type: 'text', data: { text: '无提及消息' } }], raw_message: '无提及消息',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(order).toEqual([])
    expect(h.captured.followups).toHaveLength(0)
    expect(h.outbound.some(f => JSON.stringify(f.params).includes('仅管理员可用'))).toBe(false)

    // 3. A normal group turn: the command router runs BEFORE media parsing
    //    (M1-C6a position, observable even for non-commands), then media,
    //    then quote expansion, then dispatch.
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 10001, group_id: 888, self_id: 10002,
      message: [
        { type: 'reply', data: { id: 555 } },
        { type: 'at', data: { qq: '10002' } },
        { type: 'text', data: { text: '看看这张' } },
        { type: 'image', data: { file: 'base64://' + png } },
      ],
      raw_message: '[CQ:reply,id=555][CQ:at,qq=10002]看看这张[CQ:image,file=base64://...]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(order).toEqual(['command', 'media', 'quote', 'dispatch'])
    const text = h.captured.followups[0].text
    expect(text).toContain('[引用]引用来源: 被引用的原文')
    expect(text).toContain('[图片:')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('sendInterim bookkeeping: buffer + id backfill + recall timer, with message-id dedupe (M2-T0 interim timing)', async () => {
    const h = await makeCmdHarness({ interimRecallMs: 50 })
    h.sendText('开始长任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    const emit = (id: string, text: string) => {
      h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
        turn: 1, step: 1, message: { role: 'assistant', id, content: [
          { type: 'text', text },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
        ] },
      }))
    }
    emit('im-book-1', '记账中间步')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('记账中间步'))).toBe(true)
    })
    const chat = (h.bridge as unknown as { chats: Map<string, {
      loopBuffer: Array<{ id: string; text: string; sentAt: number }>
      recallTimers: Map<string, unknown>
      lastHandledMessageId: string | undefined
      recalledInterimIds: Set<string>
    }> }).chats.get('private:10001')!
    // The completed send is booked: the loop buffer holds the QQ message id
    // and the text, and a per-message auto-recall timer is armed.
    expect(chat.loopBuffer).toHaveLength(1)
    expect(chat.loopBuffer[0].id).toBe('7')
    expect(chat.loopBuffer[0].text).toBe('记账中间步')
    expect(chat.recallTimers.has('7')).toBe(true)
    expect(chat.lastHandledMessageId).toBe('im-book-1')

    // Re-emitting the same message id must not resend or re-book.
    emit('im-book-1', '重复内容不应发送')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.outbound.filter(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('记账中间步'))).toHaveLength(1)
    expect(h.outbound.some(f => JSON.stringify(f.params).includes('重复内容不应发送'))).toBe(false)
    expect(chat.loopBuffer).toHaveLength(1)

    // The 50ms timer revokes the interim alone and records it as recalled.
    await vi.waitFor(() => expect(h.outbound.some(f => f.action === 'delete_msg')).toBe(true))
    expect(chat.recalledInterimIds.has('7')).toBe(true)

    // turn/end settles: one summary card for the (already revoked) interim,
    // and no second recall of the same id.
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))).toBe(true)
    })
    expect(h.outbound.filter(f => f.action === 'delete_msg')).toHaveLength(1)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('settleLoop drains the send chain before snapshotting: an in-flight interim is still summarized and recalled (M2-T0 interim timing)', async () => {
    const h = await makeCmdHarness({ interimRecallMs: 60_000 })
    const realCall = h.connection.call.bind(h.connection)
    h.connection.call = (async (action: string, params: unknown) => {
      if (action === 'send_msg') await new Promise(resolve => setTimeout(resolve, 120))
      return await realCall(action, params)
    }) as never
    h.sendText('开始长任务')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'im-slow-1', content: [
        { type: 'text', text: '慢中间步' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      ] },
    }))
    // turn/end arrives while the interim send is still in flight (120ms delay).
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))).toBe(true)
    })
    // Drain-before-snapshot proof: the late interim's id made it into the
    // snapshot, so its recall follows the summary card.
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'delete_msg')).toBe(true)
    })
    const interimIdx = h.outbound.findIndex(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('慢中间步'))
    const summaryIdx = h.outbound.findIndex(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))
    const deleteIdx = h.outbound.findIndex(f => f.action === 'delete_msg')
    expect(interimIdx).toBeGreaterThanOrEqual(0)
    expect(summaryIdx).toBeGreaterThan(interimIdx)
    expect(deleteIdx).toBeGreaterThan(summaryIdx)
    // Settled state: the buffer is drained, nothing is deferred, and the
    // original interim is recalled exactly once.
    const chat = (h.bridge as unknown as { chats: Map<string, { loopBuffer: unknown[]; loopPending: string | null }> }).chats.get('private:10001')!
    expect(chat.loopBuffer).toHaveLength(0)
    expect(chat.loopPending).toBeNull()
    expect(h.outbound.filter(f => f.action === 'delete_msg')).toHaveLength(1)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('golden: private plain-text round produces exactly one text send_msg (M2-T0 golden)', async () => {
    const h = await makeHarness()
    h.sendText('你好，帮我看看这个')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toBe('你好，帮我看看这个')
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '这是回复' }] },
    }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg')).toBe(true)
    })
    const sends = h.outbound.filter(f => f.action === 'send_msg')
    expect(sends).toHaveLength(1)
    expect(sends[0].params).toMatchObject({ user_id: 10001 })
    expect(sends[0].params.message).toEqual([{ type: 'text', data: { text: '这是回复' } }])
    expect(h.outbound.some(f => f.action === 'delete_msg' || f.action === 'send_forward_msg' || f.action === 'send_private_forward_msg')).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('golden: group @mention with a tool call yields interim → summary card → recall → final in order (M2-T0 golden)', async () => {
    const h = await makeCmdHarness({ interimRecallMs: 60_000 })
    h.sendGroupTextAs('帮我查一下', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toMatch(/^\[\d{2}:\d{2} 用户10001\(10001\)\]\[@我\] @10002帮我查一下$/)
    const session = { id: h.sessionIds[0] }
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'g-interim-1', content: [
        { type: 'text', text: '先查资料' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      ] },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('先查资料'))).toBe(true)
    })
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', id: 'g-final-1', content: [{ type: 'text', text: '查到了，结论如下' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('查到了，结论如下'))).toBe(true)
    })
    const frames = h.outbound.filter(f => ['send_msg', 'delete_msg', 'send_forward_msg', 'send_private_forward_msg'].includes(String(f.action)))
    const interimIdx = frames.findIndex(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('先查资料'))
    const summaryIdx = frames.findIndex(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('"type":"image"'))
    const recallIdx = frames.findIndex(f => f.action === 'delete_msg')
    const finalIdx = frames.findIndex(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('查到了，结论如下'))
    expect(interimIdx).toBeGreaterThanOrEqual(0)
    expect(summaryIdx).toBeGreaterThan(interimIdx)
    expect(recallIdx).toBeGreaterThan(summaryIdx)
    expect(finalIdx).toBeGreaterThan(recallIdx)
    const interimFrame = frames[interimIdx] as { params: { message: Array<{ type: string; data: { text?: string } }> } }
    expect(interimFrame.params.message).toEqual([{ type: 'text', data: { text: '先查资料' } }])
    const summaryFrame = frames[summaryIdx] as { params: { message: Array<{ type: string; data: { file?: string } }> } }
    expect(summaryFrame.params.message).toHaveLength(1)
    expect(summaryFrame.params.message[0].type).toBe('image')
    expect(String(summaryFrame.params.message[0].data.file)).toMatch(/^base64:\//)
    const finalFrame = frames[finalIdx] as { params: { message: Array<{ type: string; data: { text?: string } }> } }
    expect(finalFrame.params.message).toEqual([{ type: 'text', data: { text: '查到了，结论如下' } }])
    expect(frames.some(f => f.action === 'send_forward_msg' || f.action === 'send_private_forward_msg')).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('golden: a long final renders exactly one t2i image card segment (M2-T0 golden)', async () => {
    const h = await makeHarness({ textImageThreshold: 10 })
    h.sendText('长文测试')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const longText = '这是一段非常长的回复内容，长度超过了阈值十，因此渲染为一张文字图卡片发送。'.repeat(3)
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    }))
    h.ctx.emit('session/event', { id: h.sessionIds[0] } as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('base64://'))).toBe(true)
    })
    const sends = h.outbound.filter(f => f.action === 'send_msg')
    expect(sends).toHaveLength(1)
    expect(sends[0].params.message).toEqual([{ type: 'image', data: { file: expect.stringMatching(/^base64:\/\//) } }])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('sendToChat serializes per chat even for an unregistered chat (B8d/C6b send-chain decoupling)', async () => {
    const h = await makeHarness()
    // No chat is registered for private:99999 — the send chain must still
    // serialize: the delayed first send blocks the second one.
    const realCall = h.connection.call.bind(h.connection)
    h.connection.call = (async (action: string, params: Record<string, unknown>) => {
      if (action === 'send_msg' && JSON.stringify(params).includes('第一条')) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      return await realCall(action, params)
    }) as never
    const first = h.bridge.sendToChat('private:99999', '第一条', {})
    const second = h.bridge.sendToChat('private:99999', '第二条', {})
    await Promise.all([first, second])
    const texts = h.outbound.filter(f => f.action === 'send_msg').map(f => JSON.stringify(f.params))
    expect(texts.findIndex(t => t.includes('第一条'))).toBeLessThan(texts.findIndex(t => t.includes('第二条')))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
