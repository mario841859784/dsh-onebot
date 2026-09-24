import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

import { defaultMediaDir, dshHome } from '../src/index.js'
import { ChatRegistry } from '../src/registry.js'

// Regression tests for the 0.4.3 hotfix pair that pure fakes cannot cover:
// the dsh-home fallback chain (defect 1) and the retired-sessions save race
// (defect 2). Rename is gated so the two concurrent writers' renames settle
// in a chosen order — exactly the interleaving that made the shared `.tmp`
// name fail with ENOENT (web-3079.log line 14251).

const hoisted = vi.hoisted(() => {
  const pending: Array<{ from: string; dest: string; release: () => void }> = []
  return { pending }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const [from, to] = args
      await new Promise<void>((resolve) => hoisted.pending.push({ from: String(from), dest: String(to), release: resolve }))
      return actual.rename(from, to)
    },
  }
})

describe('hotfix 0.4.3', () => {
  it('dshHome/defaultMediaDir fall back to os.homedir(), never /tmp, when DSH_HOME and HOME are both unset', () => {
    const prevDsh = process.env.DSH_HOME
    const prevHome = process.env.HOME
    delete process.env.DSH_HOME
    delete process.env.HOME
    try {
      // The systemd host runs without HOME: the passwd-backed homedir() must
      // win so preset enumeration reads <home>/.agent-presets (web-3079.log
      // line 14429 scanned /tmp/.dsh/.agent-presets).
      expect(dshHome()).toBe(join(homedir(), '.dsh'))
      expect(dshHome().startsWith('/tmp')).toBe(false)
      expect(defaultMediaDir()).toBe(join(homedir(), '.dsh', 'media', 'onebot'))
    } finally {
      if (prevDsh !== undefined) process.env.DSH_HOME = prevDsh
      if (prevHome !== undefined) process.env.HOME = prevHome
    }
  })

  it('two concurrent retired-sessions saves rename their own unique tmp files (no shared-tmp ENOENT race)', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const logLines: string[] = []
    const registry = new ChatRegistry({
      agents: undefined as never,
      sessions: undefined as never,
      sessionPersistence: undefined,
      workspaceRegistry: undefined,
      agentPresets: undefined,
      defaultModel: undefined,
      config: {
        mediaDir, workspacePath: '', agentPreset: '', restrictedMemberPrefix: false,
        maxImageBytes: 8 * 1024 * 1024, maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        chatIdleEvictDays: 30,
      },
      log: (level, message) => { logLines.push(level + ': ' + message) },
      isStopping: () => false,
      onChatRemoved: () => undefined,
      installChannelScope: () => undefined,
    })
    const saveRetired = (): Promise<void> => (registry as unknown as { saveRetired(): Promise<void> }).saveRetired()

    registry.retiredSessionIds.add('onebot-private-10001-a')
    const first = saveRetired()
    await vi.waitFor(() => expect(hoisted.pending.length).toBe(1))

    registry.retiredSessionIds.add('onebot-private-10001-b')
    const second = saveRetired()
    await vi.waitFor(() => expect(hoisted.pending.length).toBe(2))
    // The two writers hold gated renames over DISTINCT tmp files.
    // Both writers rename onto the same final file, from DISTINCT tmp files.
    expect(hoisted.pending[0].dest).toBe(hoisted.pending[1].dest)
    expect(hoisted.pending[0].from).not.toBe(hoisted.pending[1].from)

    // The second writer's rename settles first: under the retired shared
    // `.tmp` name it consumed the only tmp file and the first writer's
    // rename then failed with ENOENT (web-3079.log line 14251).
    hoisted.pending[1].release()
    await second
    hoisted.pending[0].release()
    await first

    expect(logLines.some((line) => line.includes('retired-sessions save failed'))).toBe(false)
    // The first writer renamed last, so the durable file holds its snapshot.
    const final = JSON.parse(await readFile(join(mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
    expect(final).toEqual(['onebot-private-10001-a'])
  })
})
