/**
 * T3 (PR port) tests: 退休会话自动恢复 + 群工作区 — the two registry
 * features ported from the external contribution back to src/ TypeScript.
 *
 * The auto-recovery tests build a fake host persistence root following the
 * verified dsh 0.2.2 layout
 * `<root>/<projectKey>/<encodeSegment(sessionId)>/session.v4.jsonl[.zstd]`
 * (two directory levels; the contributor's flat-layout assumption is not
 * reproduced here). QQ chat session ids only contain [A-Za-z0-9-], which
 * the host's encodeSegment keeps verbatim, so plain directory names are used.
 * @module dsh-onebot/tests/t3-port
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChatRegistry, findLatestSessionForChat } from '../src/registry.js'
import type { BridgeConfig, RegistryDeps } from '../src/registry.js'

function makeRegistryDeps(overrides?: {
  config?: Partial<Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'agentPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'groupWorkspacePath' | 'sessionAutoRecover'>>
  agents?: unknown
  dshHome?: string
}): RegistryDeps {
  return {
    agents: (overrides?.agents ?? { create: vi.fn(), resume: vi.fn() }) as never,
    sessions: { flush: vi.fn(async () => undefined) } as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    agentPresets: {
      defaultId: 'standard',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => ({ id: id ?? 'standard' })),
    } as never,
    defaultModel: undefined,
    dshHome: overrides?.dshHome,
    config: {
      mediaDir: mkdtempSync(join(tmpdir(), 'onebot-test-')),
      workspacePath: '',
      agentPreset: '',
      restrictedMemberPrefix: false,
      maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024,
      maxFileBytes: 20 * 1024 * 1024,
      ...overrides?.config,
    },
    log: () => undefined,
    isStopping: () => false,
    onChatRemoved: () => undefined,
    installChannelScope: () => undefined,
  }
}

/** Build a fake host sessions root with candidate session dirs for one chat.
 * sessionIds get ascending mtimes so the last listed id is the newest. */
function makeSessionsRoot(dshHome: string, candidates: string[]): string {
  const root = join(dshHome, 'sessions')
  candidates.forEach((sessionId, index) => {
    const dir = join(root, '--proj--', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x')
    const mtime = new Date(1_700_000_000_000 + index * 1_000)
    utimesSync(join(dir, 'session.v4.jsonl.zstd'), mtime, mtime)
  })
  return root
}

describe('ChatRegistry.effectiveCwd 群工作区 (T3 PR port)', () => {
  it('a group chat uses groupWorkspacePath when configured', () => {
    const registry = new ChatRegistry(makeRegistryDeps({
      config: { workspacePath: '/srv/main', groupWorkspacePath: '/srv/group-888' },
    }))
    expect(registry.effectiveCwd('group:888')).toBe('/srv/group-888')
    // 私聊不受群工作区影响。
    expect(registry.effectiveCwd('private:10001')).toBe('/srv/main')
  })

  it('a per-chat /workspace override still wins over groupWorkspacePath', () => {
    const registry = new ChatRegistry(makeRegistryDeps({
      config: { workspacePath: '/srv/main', groupWorkspacePath: '/srv/group-888' },
    }))
    registry.getSettings('group:888').workspacePath = '/srv/custom'
    expect(registry.effectiveCwd('group:888')).toBe('/srv/custom')
  })

  it('an unconfigured groupWorkspacePath keeps the current behavior', () => {
    const registry = new ChatRegistry(makeRegistryDeps({
      config: { workspacePath: '/srv/main', groupWorkspacePath: '' },
    }))
    expect(registry.effectiveCwd('group:888')).toBe('/srv/main')
    expect(registry.effectiveCwd('private:10001')).toBe('/srv/main')
  })
})

describe('findLatestSessionForChat (T3 PR port 探测函数)', () => {
  it('returns the candidate with the newest log mtime across project dirs', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    makeSessionsRoot(dshHome, ['onebot-private-10001-old1', 'onebot-private-10001-old2'])
    // A second project dir also carries a candidate (older than old2).
    const otherDir = join(dshHome, 'sessions', '--other--', 'onebot-private-10001-old0')
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, 'session.v4.jsonl'), 'x')
    const t0 = new Date(1_700_000_000_000)
    utimesSync(join(otherDir, 'session.v4.jsonl'), t0, t0)
    await expect(findLatestSessionForChat(join(dshHome, 'sessions'), 'onebot-private-10001'))
      .resolves.toBe('onebot-private-10001-old2')
  })

  it('skips non-matching dirs and session dirs without a log file', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    makeSessionsRoot(dshHome, ['onebot-private-10001-old1'])
    // A suffixed-but-unrelated chat and a log-less candidate must be ignored.
    const other = join(dshHome, 'sessions', '--proj--', 'onebot-private-99999')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'session.v4.jsonl.zstd'), 'x')
    const empty = join(dshHome, 'sessions', '--proj--', 'onebot-private-10001-empty')
    mkdirSync(empty, { recursive: true })
    await expect(findLatestSessionForChat(join(dshHome, 'sessions'), 'onebot-private-10001'))
      .resolves.toBe('onebot-private-10001-old1')
  })

  it('resolves undefined on a missing root or no candidates (silent degrade)', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    await expect(findLatestSessionForChat(join(dshHome, 'sessions'), 'onebot-private-10001'))
      .resolves.toBeUndefined()
    const root = makeSessionsRoot(dshHome, [])
    await expect(findLatestSessionForChat(root, 'onebot-private-10001')).resolves.toBeUndefined()
  })
})

describe('ChatRegistry loadMapping 退休会话自动恢复 (T3 PR port)', () => {
  /** Registry over a mapping file that binds the chat to a dead session,
   * with an injectable resume stub and a fake sessions root. */
  function makeRecoveryDeps(overrides?: {
    retired?: string[]
    mapping?: Record<string, unknown>
    agents?: unknown
    dshHome?: string
    sessionAutoRecover?: boolean
    workspacePath?: string
    groupWorkspacePath?: string
  }): { deps: RegistryDeps; mediaDir: string } {
    const deps = makeRegistryDeps({
      agents: overrides?.agents,
      dshHome: overrides?.dshHome,
      config: {
        sessionAutoRecover: overrides?.sessionAutoRecover,
        workspacePath: overrides?.workspacePath,
        groupWorkspacePath: overrides?.groupWorkspacePath,
      },
    })
    const mediaDir = deps.config.mediaDir
    if (overrides?.mapping !== undefined) {
      writeFileSync(join(mediaDir, 'chat-sessions.json'), JSON.stringify(overrides.mapping), 'utf8')
    }
    if (overrides?.retired !== undefined) {
      writeFileSync(join(mediaDir, 'retired-sessions.json'), JSON.stringify(overrides.retired), 'utf8')
    }
    return { deps, mediaDir }
  }

  it('retired-skip branch: auto-rebinds the newest usable session of the chat', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    makeSessionsRoot(dshHome, ['onebot-private-10001-old1', 'onebot-private-10001-old2'])
    const agents = {
      create: vi.fn(),
      resume: vi.fn(async (options: { resumeSessionId: string }) => {
        if (options.resumeSessionId === 'onebot-private-10001-dead') throw new Error('not persisted')
        return {
          agent: {
            session: { id: options.resumeSessionId, seq: 1, header: { cwd: process.cwd() } },
            status: 'idle',
            model: { current: () => undefined, select: () => undefined },
            cancel: () => undefined,
            followup: () => undefined,
            whenIdle: async () => undefined,
          },
          dispose: async () => undefined,
        }
      }),
    }
    const { deps, mediaDir } = makeRecoveryDeps({
      agents,
      dshHome,
      sessionAutoRecover: true,
      retired: ['onebot-private-10001-dead'],
      mapping: { 'private:10001': { session: 'onebot-private-10001-dead', goal: 'keepme' } },
    })
    const registry = new ChatRegistry(deps)
    await registry.loadRetired()
    await registry.loadMapping()
    // The newest candidate won; the dead retired id was never resumed.
    expect(agents.resume).toHaveBeenCalledTimes(1)
    expect(agents.resume.mock.calls[0][0].resumeSessionId).toBe('onebot-private-10001-old2')
    expect(registry.chats.get('private:10001')?.agent.session.id).toBe('onebot-private-10001-old2')
    // The retired file gained the dead id's successor? No — only the original retire list.
    // Persisted settings (goal) survive onto the recovered chat.
    expect(registry.getSettings('private:10001').goal).toBe('keepme')
    expect(mediaDir).toBeDefined()
  })

  it('retired-skip branch: a retired newest candidate degrades (single-pick + guard, faithful to the contributor)', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    makeSessionsRoot(dshHome, ['onebot-private-10001-old1', 'onebot-private-10001-old2'])
    const agents = {
      create: vi.fn(),
      resume: vi.fn(async (options: { resumeSessionId: string }) => ({
        agent: {
          session: { id: options.resumeSessionId, seq: 1, header: { cwd: process.cwd() } },
          status: 'idle', model: { current: () => undefined, select: () => undefined },
          cancel: () => undefined, followup: () => undefined, whenIdle: async () => undefined,
        },
        dispose: async () => undefined,
      })),
    }
    const { deps } = makeRecoveryDeps({
      agents,
      dshHome,
      sessionAutoRecover: true,
      retired: ['onebot-private-10001-dead', 'onebot-private-10001-old2'],
      mapping: { 'private:10001': { session: 'onebot-private-10001-dead' } },
    })
    const registry = new ChatRegistry(deps)
    await registry.loadRetired()
    await registry.loadMapping()
    // old2 (newest) is itself retired → the recovery condition
    // (recovered !== undefined && recovered !== sessionId && !retired)
    // fails for the single picked candidate → silent degrade, no resume.
    expect(agents.resume).not.toHaveBeenCalled()
    expect(registry.chats.size).toBe(0)
  })

  it('retired-skip branch degrades silently when no candidate exists', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const agents = { create: vi.fn(), resume: vi.fn(async () => { throw new Error('not persisted') }) }
    const { deps } = makeRecoveryDeps({
      agents,
      dshHome,
      sessionAutoRecover: true,
      retired: ['onebot-private-10001-dead'],
      mapping: { 'private:10001': { session: 'onebot-private-10001-dead', goal: 'keepme' } },
    })
    const registry = new ChatRegistry(deps)
    await expect(registry.loadRetired().then(() => registry.loadMapping())).resolves.toBeUndefined()
    expect(agents.resume).not.toHaveBeenCalled()
    expect(registry.chats.size).toBe(0)
    // Original behavior preserved: the object entry stays as the settings carrier.
    expect(registry.getSettings('private:10001').goal).toBe('keepme')
  })

  it('failed-resume branch: recovers the newest usable session after a failed resume', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    makeSessionsRoot(dshHome, ['onebot-private-10001-old1', 'onebot-private-10001-old2'])
    const agents = {
      create: vi.fn(),
      resume: vi.fn(async (options: { resumeSessionId: string }) => {
        if (options.resumeSessionId === 'onebot-private-10001-dead') throw new Error('not persisted')
        return {
          agent: {
            session: { id: options.resumeSessionId, seq: 1, header: { cwd: process.cwd() } },
            status: 'idle', model: { current: () => undefined, select: () => undefined },
            cancel: () => undefined, followup: () => undefined, whenIdle: async () => undefined,
          },
          dispose: async () => undefined,
        }
      }),
    }
    const { deps } = makeRecoveryDeps({
      agents,
      dshHome,
      sessionAutoRecover: true,
      mapping: { 'private:10001': 'onebot-private-10001-dead' },
    })
    const registry = new ChatRegistry(deps)
    await registry.loadMapping()
    // First the dead recorded id, then the recovered newest candidate.
    expect(agents.resume).toHaveBeenCalledTimes(2)
    expect(agents.resume.mock.calls[1][0].resumeSessionId).toBe('onebot-private-10001-old2')
    expect(registry.chats.get('private:10001')?.agent.session.id).toBe('onebot-private-10001-old2')
  })

  it('failed-resume branch degrades silently when recovery finds nothing', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const agents = {
      create: vi.fn(),
      resume: vi.fn(async () => { throw new Error('not persisted') }),
    }
    const { deps } = makeRecoveryDeps({
      agents,
      dshHome,
      sessionAutoRecover: true,
      mapping: { 'private:10001': 'onebot-private-10001-dead' },
    })
    const registry = new ChatRegistry(deps)
    await expect(registry.loadMapping()).resolves.toBeUndefined()
    expect(agents.resume).toHaveBeenCalledTimes(1)
    expect(registry.chats.size).toBe(0)
    expect(registry.brokenSessionCount()).toBe(1)
  })

  it('the switch is off by default: no probe, upstream behavior unchanged', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    makeSessionsRoot(dshHome, ['onebot-private-10001-old1', 'onebot-private-10001-old2'])
    const agents = {
      create: vi.fn(),
      resume: vi.fn(async (options: { resumeSessionId: string }) => {
        if (options.resumeSessionId === 'onebot-private-10001-dead') throw new Error('not persisted')
        return {
          agent: {
            session: { id: options.resumeSessionId, seq: 1, header: { cwd: process.cwd() } },
            status: 'idle', model: { current: () => undefined, select: () => undefined },
            cancel: () => undefined, followup: () => undefined, whenIdle: async () => undefined,
          },
          dispose: async () => undefined,
        }
      }),
    }
    // sessionAutoRecover left unset (the schema default is false).
    const { deps } = makeRecoveryDeps({
      agents,
      dshHome,
      retired: ['onebot-private-10001-dead'],
      mapping: { 'private:10001': { session: 'onebot-private-10001-dead' } },
    })
    const registry = new ChatRegistry(deps)
    await registry.loadRetired()
    await registry.loadMapping()
    expect(agents.resume).not.toHaveBeenCalled()
    expect(registry.chats.size).toBe(0)
  })

  describe('群工作区恢复 (T3 评审必改 1: effectiveCwd(chatId) 透传)', () => {
    function makeResumeStub(headerCwd: string): { resume: ReturnType<typeof vi.fn> } {
      return {
        create: vi.fn(),
        resume: vi.fn(async (options: { resumeSessionId: string }) => ({
          agent: {
            session: { id: options.resumeSessionId, seq: 1, header: { cwd: headerCwd } },
            status: 'idle', model: { current: () => undefined, select: () => undefined },
            cancel: () => undefined, followup: () => undefined, whenIdle: async () => undefined,
          },
          dispose: async () => undefined,
        })),
      } as never
    }

    it('a recovered group chat resolves the group workspace and writes no per-chat override', async () => {
      const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
      makeSessionsRoot(dshHome, ['onebot-group-888-old1'])
      const attachSession = vi.fn(async () => undefined)
      const workspaceRegistry = {
        resolveByPath: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ attachSession })),
      }
      const agents = makeResumeStub('/srv/group-888')
      const { deps } = makeRecoveryDeps({
        agents,
        dshHome,
        sessionAutoRecover: true,
        workspacePath: '/srv/main',
        groupWorkspacePath: '/srv/group-888',
        retired: ['onebot-group-888-dead'],
        mapping: { 'group:888': { session: 'onebot-group-888-dead' } },
      })
      deps.workspaceRegistry = workspaceRegistry as never
      const registry = new ChatRegistry(deps)
      await registry.loadRetired()
      await registry.loadMapping()
      // 群会话恢复成功，header cwd 即群工作区目录。
      expect(agents.resume).toHaveBeenCalledTimes(1)
      expect(registry.chats.get('group:888')?.agent.session.header.cwd).toBe('/srv/group-888')
      // 群 cwd 与该 chat 的 effectiveCwd(chatId) 一致 → 不产生 per-chat 覆盖写。
      expect(registry.getSettings('group:888').workspacePath).toBeUndefined()
      // 群工作区被自动创建并挂载（评审必改 1a：不再判为 foreign cwd 跳过）。
      expect(workspaceRegistry.create).toHaveBeenCalledWith('/srv/group-888')
      expect(attachSession).toHaveBeenCalledTimes(1)
    })

    it('a per-chat override restored from the mapping is not clobbered by the resumed header cwd', async () => {
      const dshHome = mkdtempSync(join(tmpdir(), 'onebot-test-'))
      makeSessionsRoot(dshHome, ['onebot-private-10001-old1'])
      const { deps } = makeRecoveryDeps({
        agents: makeResumeStub('/srv/main'),
        dshHome,
        sessionAutoRecover: true,
        workspacePath: '/srv/main',
        retired: ['onebot-private-10001-dead'],
        mapping: { 'private:10001': { session: 'onebot-private-10001-dead', workspacePath: '/srv/custom' } },
      })
      const registry = new ChatRegistry(deps)
      await registry.loadRetired()
      await registry.loadMapping()
      // 映射恢复的 /workspace 覆盖是用户的持久选择，header cwd 不得覆写它。
      expect(registry.getSettings('private:10001').workspacePath).toBe('/srv/custom')
    })
  })
})
