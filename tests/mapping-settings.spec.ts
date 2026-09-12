/**
 * Mapping-file settings persistence tests (M3-D4b): /mode (/mode → interimOverride)
 * and /goal survive a restart through the chat-sessions.json mapping. The
 * format is additive — a legacy entry is a bare chat→session-id string; an
 * entry with persisted settings becomes { session, interimOverride?, goal? }.
 * Covers: command-setter wiring → debounced write → restart round-trip, the
 * legacy-file fallback, and the idle-eviction snapshot cycle.
 * @module dsh-onebot/tests/mapping-settings
 */
import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { OneBotConnection } from '../src/connection.js'
import { ChatBridge } from '../src/bridge.js'
import { ChatRegistry } from '../src/registry.js'
import type { RegistryDeps } from '../src/registry.js'
import type { BridgeConfig } from '../src/bridge.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

import { makeFakeAgents, makeHarness } from './helpers/bridge-harness.js'

/** Registry-only view of a harness-built bridge (same convention as registry.spec). */
function registryOf(h: { bridge: unknown }): ChatRegistry {
  return (h.bridge as unknown as { registry: ChatRegistry }).registry
}

/** Minimal RegistryDeps for direct-registry tests (same convention as registry.spec). */
function makeRegistryDeps(overrides?: {
  agents?: unknown
  config?: Partial<Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'agentPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'chatIdleEvictDays'>>
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
    config: {
      mediaDir: mkdtemp(),
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

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), 'onebot-test-'))
}

describe('mapping-file settings persistence (M3-D4b)', () => {
  it('persists /mode and /goal through the command setters and restores them on restart', async () => {
    const h = await makeHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendText('/mode instant')
    h.sendText('/goal 做好测试')
    // The debounced write lands the entry in the new additive format (the
    // legacy shape is a bare string; settings turn it into an object).
    await vi.waitFor(async () => {
      const mapping = JSON.parse(await readFile(join(h.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, unknown>
      expect(mapping['private:10001']).toEqual({ session: h.sessionIds[0], interimOverride: false, goal: '做好测试' })
    }, { timeout: 10_000 })
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()

    // A fresh bridge over the same mediaDir restores the settings on resume.
    const captured2 = { followups: [] as Array<{ text: string; sessionId: string }>, channelTools: [] as string[], channelSections: [] as string[] }
    const bridge2 = new ChatBridge({
      ctx: new Context(),
      connection: new OneBotConnection({ mode: 'reverse', host: '127.0.0.1', port: 0, url: 'ws://127.0.0.1:3002', accessToken: 'test-token', callTimeoutMs: 3_000 }),
      media: new MediaStore(join(h.mediaDir, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
      agents: makeFakeAgents([], captured2, { resumeOk: true }) as never,
      sessions: { flush: vi.fn(async () => undefined) } as never,
      sessionPersistence: undefined,
      workspaceRegistry: undefined as never,
      agentPresets: undefined as never,
      defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, splitLength: 100, requireMention: true,
        interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
        sensitivePatterns: [], mediaDir: h.mediaDir, maxImageBytes: 8 * 1024 * 1024,
        maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    bridge2.start()
    await vi.waitFor(() => expect(registryOf({ bridge: bridge2 }).getSettings('private:10001').goal).toBe('做好测试'))
    expect(registryOf({ bridge: bridge2 }).getSettings('private:10001').interimOverride).toBe(false)
    await bridge2.stop()
  }, 30_000)

  it('loadMapping accepts a legacy mapping file and falls back to the current defaults', async () => {
    const sessionIds: string[] = []
    const captured = { followups: [] as Array<{ text: string; sessionId: string }> }
    const agents = makeFakeAgents(sessionIds, captured, { resumeOk: true })
    const deps = makeRegistryDeps({ agents })
    // Old format: bare chat→session strings, no settings fields at all.
    await writeFile(join(deps.config.mediaDir, 'chat-sessions.json'), JSON.stringify({
      'private:10001': 'onebot-private-10001',
      'private:10002': { session: 'onebot-private-10002', goal: '只带目标的条目' },
    }), 'utf8')
    const registry = new ChatRegistry(deps)
    await registry.loadMapping()
    // Both shapes resume without crashing.
    expect(registry.chats.get('private:10001')?.sessionId).toBe('onebot-private-10001')
    expect(registry.chats.get('private:10002')?.sessionId).toBe('onebot-private-10002')
    // Legacy chat: no settings on file → the current defaults apply.
    expect(registry.getSettings('private:10001').interimOverride).toBeUndefined()
    expect(registry.getSettings('private:10001').goal).toBeUndefined()
    // New-format partial entry: only the fields present are restored.
    expect(registry.getSettings('private:10002').goal).toBe('只带目标的条目')
    expect(registry.getSettings('private:10002').interimOverride).toBeUndefined()
    await registry.stop()
  })

  it('keeps persisted mode/goal across an idle eviction cycle (settings snapshot)', async () => {
    const sessionIds: string[] = []
    const deps1 = makeRegistryDeps({ agents: makeFakeAgents(sessionIds, { followups: [] }, { resumeOk: true }), config: { chatIdleEvictDays: 7 } })
    const registry1 = new ChatRegistry(deps1)
    registry1.getSettings('private:10001').interimOverride = false
    registry1.getSettings('private:10001').goal = '把事情做好'
    await registry1.ensureChat('private:10001', '小明')
    const chat = registry1.chats.get('private:10001')!
    chat.lastActivityAt = Date.now() - 8 * 24 * 60 * 60 * 1000
    await registry1.sweepIdleChats()
    expect(registry1.chats.has('private:10001')).toBe(false)
    await registry1.saveMapping()
    await registry1.stop()
    const mapping = JSON.parse(await readFile(join(deps1.config.mediaDir, 'chat-sessions.json'), 'utf8')) as Record<string, { session: string; interimOverride?: boolean; goal?: string }>
    expect(mapping['private:10001']).toEqual({ session: sessionIds[0], interimOverride: false, goal: '把事情做好' })

    const deps2 = makeRegistryDeps({ agents: makeFakeAgents([], { followups: [] }, { resumeOk: true }), config: { mediaDir: deps1.config.mediaDir } })
    const registry2 = new ChatRegistry(deps2)
    await registry2.loadMapping()
    expect(registry2.chats.get('private:10001')?.sessionId).toBe(sessionIds[0])
    expect(registry2.getSettings('private:10001').interimOverride).toBe(false)
    expect(registry2.getSettings('private:10001').goal).toBe('把事情做好')
    await registry2.stop()
  })
})
