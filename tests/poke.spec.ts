import { describe, expect, it, vi } from 'vitest'
import type { OneBotEvent } from '../src/connection.js'
import { createPokeHandler, POKE_THROTTLE_MS } from '../src/poke.js'

/** Poke notice fixture: user pokes the bot (user_id=发起者, target_id=被戳者). */
const poke = (overrides: Partial<OneBotEvent> = {}): OneBotEvent => ({
  post_type: 'notice', notice_type: 'poke', user_id: 20003, target_id: 10002, ...overrides,
})

interface HarnessOptions {
  pokeEnabled?: boolean
  selfId?: string
  now?: () => number
}

function makeHarness(options: HarnessOptions = {}) {
  const dispatched: OneBotEvent[] = []
  const log = vi.fn()
  let clock = 1_000_000
  const handler = createPokeHandler({
    pokeEnabled: options.pokeEnabled ?? true,
    selfId: () => options.selfId ?? '10002',
    dispatch: event => dispatched.push(event),
    log,
    now: options.now ?? (() => clock),
  })
  return {
    handler, dispatched, log,
    tick: (ms: number) => { clock += ms },
  }
}

describe('poke notice handler (T1 PR port: 戳一戳唤醒)', () => {
  it('dispatches a private pseudo message for a private poke', () => {
    const h = makeHarness()
    h.handler(poke())
    expect(h.dispatched).toHaveLength(1)
    const pseudo = h.dispatched[0]
    expect(pseudo.post_type).toBe('message')
    expect(pseudo.message_type).toBe('private')
    expect(pseudo.user_id).toBe('20003') // handler normalizes wire ids to strings
    expect(pseudo.raw_message).toBe('[戳一戳]')
    expect(pseudo.message).toEqual([{ type: 'text', data: { text: '[戳一戳]' } }])
    expect(pseudo.time).toBe(1000) // Math.floor(now/1000)
    expect(pseudo.message_id).toBe('poke-1000000')
    expect(pseudo.sender).toEqual({ user_id: '20003', nickname: '' })
  })

  it('appends an at-self segment in group pokes so the @ gate admits the pseudo message', () => {
    const h = makeHarness()
    h.handler(poke({ group_id: 888 }))
    expect(h.dispatched[0].message_type).toBe('group')
    expect(h.dispatched[0].group_id).toBe('888')
    expect(h.dispatched[0].message).toEqual([
      { type: 'text', data: { text: '[戳一戳]' } },
      { type: 'at', data: { qq: '10002' } },
    ])
  })

  it('ignores everything while pokeEnabled is off', () => {
    const h = makeHarness({ pokeEnabled: false })
    h.handler(poke())
    h.handler(poke({ group_id: 888 }))
    expect(h.dispatched).toHaveLength(0)
  })

  it('ignores self pokes and pokes targeted at someone else', () => {
    const h = makeHarness()
    // 发起者就是机器人自己（NapCat 回显）→ 忽略。
    h.handler(poke({ user_id: 10002, target_id: 20003 }))
    // target 是别人（互戳场景）→ 不叫。
    h.handler(poke({ target_id: 20003 }))
    expect(h.dispatched).toHaveLength(0)
    // target 缺失（部分实现不带）→ 退回宁多叫不漏。
    h.handler(poke({ target_id: undefined }))
    expect(h.dispatched).toHaveLength(1)
  })

  it('throttles the same poker to one dispatch per window', () => {
    const h = makeHarness()
    h.handler(poke({ group_id: 888 }))
    h.handler(poke({ group_id: 888 }))
    expect(h.dispatched).toHaveLength(1)
    expect(h.log).toHaveBeenCalledWith('debug', expect.stringContaining('戳一戳节流'))
    // 窗口过后再戳 → 放行。
    h.tick(POKE_THROTTLE_MS)
    h.handler(poke({ group_id: 888 }))
    expect(h.dispatched).toHaveLength(2)
  })

  it('throttles per (chat, poker) key: a different group or poker is independent', () => {
    const h = makeHarness()
    h.handler(poke({ group_id: 888 }))
    h.handler(poke({ group_id: 999 }))
    h.handler(poke()) // private chat
    h.handler(poke({ group_id: 888, user_id: 30004 }))
    expect(h.dispatched).toHaveLength(4)
  })

  it('prunes stale throttle entries once the table grows past the cap', () => {
    let clock = 1_000_000
    const dispatched: OneBotEvent[] = []
    const handler = createPokeHandler({
      pokeEnabled: true, selfId: () => '10002',
      dispatch: event => dispatched.push(event),
      now: () => clock,
    })
    // Fill past the cap with distinct pokers, then advance past the keep
    // window and poke again: the old entries must have been evicted.
    for (let i = 0; i < 250; i++) {
      handler(poke({ group_id: 888, user_id: 30000 + i }))
    }
    expect(dispatched).toHaveLength(250)
    clock += 60_000
    handler(poke({ group_id: 888, user_id: 30000 }))
    expect(dispatched).toHaveLength(251)
  })

  it('string user_id wire shapes work the same as numeric ones', () => {
    const h = makeHarness()
    h.handler(poke({ user_id: '20003', target_id: '10002' }))
    expect(h.dispatched).toHaveLength(1)
    expect(h.dispatched[0].user_id).toBe('20003')
  })
})
