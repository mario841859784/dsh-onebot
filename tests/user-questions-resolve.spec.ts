/**
 * userQuestions 服务解析回归：真实 cordis Context，子 fiber 由 root.plugin 建，
 * 服务由兄弟插件提供，和宿主 profile 下 user-questions 与 dsh-onebot 的关系相同。
 *
 * 不能用普通假对象（属性读永远成功），也不能把 apply 直接挂在根 Context 上：
 * 根 fiber 没有 runtime，cordis 对它的属性读不检查 inject。这两种写法都测不出
 * 「服务明明在，插件和 agent scope 却取不到」。
 * @module dsh-onebot/tests/user-questions-resolve
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerAskUserTool, resolveUserQuestions } from '../src/ask-tool.js'
import { apply, Config, inject } from '../src/index.js'

type AnswerPort = { answer(agent: unknown, callId: string, payload: unknown): Promise<boolean> }

/** plugin 入口交给 ChatBridge 的 deps，getter 不能被提前求值，所以存对象本身。 */
const bridgeDeps = vi.hoisted(() => [] as Array<{ userQuestions?: AnswerPort }>)
vi.mock('../src/bridge.js', () => ({
  ChatBridge: class {
    constructor(deps: { userQuestions?: AnswerPort }) {
      bridgeDeps.push(deps)
    }
    start(): void {}
    async stop(): Promise<void> {}
  },
}))

const answer = vi.fn(async () => true)

/** 和宿主 dsh-user-questions 一样以 Service 形式提供。 */
class UserQuestionsProvider extends Service {
  constructor(ctx: Context) {
    super(ctx, 'userQuestions' as never)
  }
  answer = answer
  askTimed = async () => ({ answers: [] })
}

/** 其他服务只需存在，由兄弟插件提供。 */
function provider(name: string, value: object) {
  return {
    name: name + '-provider',
    apply(ctx: Context) {
      ctx.provide(name as never, value as never)
    },
  }
}

function hasService(ctx: Context | undefined): boolean {
  return ctx?.get('userQuestions' as never) !== undefined
}

let profile: { dispose(): unknown } | undefined

/** 在根 Context 下建一个 profile 分组 fiber，兄弟插件都挂在它下面。 */
function mountProfile(setup: (group: Context) => void): void {
  const root = new Context()
  profile = root.plugin({ name: 'profile', apply: setup })
}

beforeEach(() => {
  bridgeDeps.length = 0
  answer.mockClear()
})

afterEach(async () => {
  await profile?.dispose()
  profile = undefined
})

describe('resolveUserQuestions on real cordis child fibers', () => {
  it('finds a sibling-provided service from a plugin fiber that does not inject it', async () => {
    let pluginCtx: Context | undefined
    mountProfile((group) => {
      group.plugin(UserQuestionsProvider)
      group.plugin({ name: 'consumer', apply(ctx: Context) { pluginCtx = ctx } })
    })
    await vi.waitFor(() => expect(hasService(pluginCtx)).toBe(true))

    // 夹具确实复现了宿主条件：服务已就绪，属性读仍然抛错。
    expect(() => (pluginCtx as unknown as { userQuestions: unknown }).userQuestions).toThrow('without inject')
    const resolved = resolveUserQuestions(pluginCtx!)
    expect(resolved).toBeDefined()
    await resolved!.answer({}, 'c1', { answers: [] })
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('finds it from an agent scope and registers ask_user_question there', async () => {
    const registered: string[] = []
    let loopCtx: Context | undefined
    mountProfile((group) => {
      group.plugin(UserQuestionsProvider)
      group.plugin(provider('tools', {
        register: (tool: { name: string }) => { registered.push(tool.name); return () => undefined },
      }))
      // agent scope 派生自 AgentLoop 的 fiber，不在 dsh-onebot 之下，改插件 inject 也救不了它。
      group.plugin({ name: 'agent-loop', inject: ['tools'], apply(ctx: Context) { loopCtx = ctx } })
    })
    await vi.waitFor(() => expect(hasService(loopCtx)).toBe(true))

    const scope = createScope(loopCtx!, {})
    expect(() => (scope.ctx as unknown as { userQuestions: unknown }).userQuestions).toThrow('without inject')
    expect(resolveUserQuestions(scope.ctx)).toBeDefined()
    expect(registerAskUserTool(scope.ctx as never, {})).toBeTypeOf('function')
    expect(registered).toEqual(['ask_user_question'])
  })
})

describe('plugin entry wires userQuestions into the bridge', () => {
  /** 真实 apply 挂在子 fiber 下；inject 列表里的服务都由兄弟插件提供。 */
  function mountPlugin(group: Context): void {
    const config = Config({
      mediaDir: mkdtempSync(join(tmpdir(), 'onebot-ask-resolve-')),
      host: '127.0.0.1',
      port: 0,
      accessToken: 'test-token',
      botQQ: '10002',
      sttEnabled: false,
      sensitivePatterns: [],
      workspacePath: tmpdir(),
    })
    for (const name of inject) group.plugin(provider(name, {}))
    group.plugin({
      name: 'dsh-onebot',
      inject,
      apply(ctx: Context) { apply(ctx as never, config) },
    })
  }

  it('hands the bridge the service when the provider is a sibling', async () => {
    mountProfile((group) => {
      group.plugin(UserQuestionsProvider)
      mountPlugin(group)
    })
    await vi.waitFor(() => expect(bridgeDeps[0]?.userQuestions).toBeDefined())
    await bridgeDeps[0]!.userQuestions!.answer({}, 'c1', { answers: [] })
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('loads without the service and picks it up when the provider arrives later', async () => {
    // cordis.patch.yml 的行序不决定加载顺序，服务可能晚于插件到达。
    let profileGroup: Context | undefined
    mountProfile((group) => {
      profileGroup = group
      mountPlugin(group)
    })
    await vi.waitFor(() => expect(bridgeDeps).toHaveLength(1))
    expect(bridgeDeps[0]!.userQuestions).toBeUndefined()

    profileGroup!.plugin(UserQuestionsProvider)
    await vi.waitFor(() => expect(bridgeDeps[0]!.userQuestions).toBeDefined())
    await bridgeDeps[0]!.userQuestions!.answer({}, 'c1', { answers: [] })
    expect(answer).toHaveBeenCalledTimes(1)
  })
})
