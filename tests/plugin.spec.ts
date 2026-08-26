import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { apply, Config, name, defaultMediaDir } from '../src/index.js'

/** A stubbed cordis service registry carrying the injected surface. */
function makeCtx() {
  const ctx = new Context()
  const tools: Array<{ name: string }> = []
  const sections: Array<{ name: string; order?: number; text?: string }> = []
  const followups: Array<{ text: string }> = []
  const sessionIds: string[] = []
  ctx.provide('tools' as never, {
    register: (tool: { name: string }) => {
      tools.push(tool)
      return () => {
        const idx = tools.indexOf(tool)
        if (idx >= 0) tools.splice(idx, 1)
      }
    },
  } as never)
  ctx.provide('systemPrompt' as never, {
    section: (section: { name: string; order?: number; text?: string }) => {
      sections.push(section)
      return () => {
        const idx = sections.indexOf(section)
        if (idx >= 0) sections.splice(idx, 1)
      }
    },
  } as never)
  ctx.provide('agents' as never, {
    create: async (options: { sessionId: string }) => {
      sessionIds.push(String(options.sessionId))
      return {
        agent: {
          session: { id: String(options.sessionId) },
          followup: (message: { content: Array<{ type: string; text?: string }> }) => {
            followups.push({ text: message.content.map(b => b.text ?? '').join('') })
          },
          whenIdle: async () => undefined,
        },
        dispose: async () => undefined,
      }
    },
    resume: async () => { throw new Error('no persistence') },
  } as never)
  ctx.provide('sessions' as never, {
    flush: async () => undefined,
  } as never)
  ctx.provide('agentDefaultModel' as never, {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  } as never)
  return { ctx, tools, sections, followups, sessionIds }
}

describe('plugin entry', () => {
  it('validates config defaults', () => {
    const config = Config({})
    expect(config.mode).toBe('reverse')
    expect(config.port).toBe(8643)
    expect(config.splitLength).toBe(100)
    expect(config.requireMention).toBe(true)
    expect(config.sttModel).toBe('small')
  })

  it('applies, registers tools and prompt, then unwinds on disposal', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const { ctx, tools, sections } = makeCtx()
    const config = Config({
      mediaDir,
      port: 0,
      accessToken: '',
      botQQ: '10002',
      sttEnabled: false,
      sensitivePatterns: [],
    })
    // apply() registers its lifecycle via ctx.effect; capture the disposer.
    const effectSpy = vi.spyOn(ctx as { effect: (cb: () => unknown, label?: string) => unknown }, 'effect')
    apply(ctx as never, config)

    // New design (§3.24): channel tools and the platform section register per
    // agent scope (installChannelScope in bridge.ts); the plugin scope stays
    // clean so Web/local sessions never see the QQ channel surface.
    expect(tools).toHaveLength(0)
    expect(sections.some(s => s.name === 'channel:dsh-onebot')).toBe(false)

    // Teardown: run the plugin's effect disposer (stops bridge + connection).
    expect(effectSpy).toHaveBeenCalled()
    const disposer = effectSpy.mock.results[0].value as () => Promise<void>
    await disposer()
  })

  it('derives a sensible default media dir', () => {
    const dir = defaultMediaDir()
    expect(dir).toContain('.dsh')
  })
})
