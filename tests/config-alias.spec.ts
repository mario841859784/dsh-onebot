/**
 * Deprecated config alias tests (M3-D4a): the renamed fields
 * inboundImageMaxPx / outboundImageMaxBytes / inboundFileMaxBytes keep their
 * old names as deprecated schemastery aliases for one release. Three paths:
 * legacy only (fallback + warn), new only (no warn), both (new wins + warn),
 * plus the neither-set default path and legacy-key type validation.
 * @module dsh-onebot/tests/config-alias
 */
import { describe, expect, it, vi } from 'vitest'

import { Config, resolveDeprecatedConfig } from '../src/index.js'

describe('deprecated config aliases (M3-D4a)', () => {
  it('falls back to legacy names when only they are configured, warning once per name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = resolveDeprecatedConfig(Config({
      imageMaxSize: 1024,
      maxImageBytes: 111,
      maxInboundFileBytes: 222,
    }))
    expect(config.inboundImageMaxPx).toBe(1024)
    expect(config.outboundImageMaxBytes).toBe(111)
    expect(config.inboundFileMaxBytes).toBe(222)
    // The legacy keys are consumed and never leak into the effective config.
    expect('imageMaxSize' in config).toBe(false)
    expect('maxImageBytes' in config).toBe(false)
    expect('maxInboundFileBytes' in config).toBe(false)
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining('"imageMaxSize"'),
      expect.stringContaining('"maxImageBytes"'),
      expect.stringContaining('"maxInboundFileBytes"'),
    ])
    warn.mockRestore()
  })

  it('keeps new-name config untouched and silent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = resolveDeprecatedConfig(Config({
      inboundImageMaxPx: 1024,
      outboundImageMaxBytes: 111,
      inboundFileMaxBytes: 222,
    }))
    expect(config.inboundImageMaxPx).toBe(1024)
    expect(config.outboundImageMaxBytes).toBe(111)
    expect(config.inboundFileMaxBytes).toBe(222)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('prefers the new name when both are configured and still warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = resolveDeprecatedConfig(Config({
      imageMaxSize: 1024,
      inboundImageMaxPx: 3000,
      maxImageBytes: 111,
      outboundImageMaxBytes: 5_000_000,
      maxInboundFileBytes: 222,
      inboundFileMaxBytes: 444,
    }))
    expect(config.inboundImageMaxPx).toBe(3000)
    expect(config.outboundImageMaxBytes).toBe(5_000_000)
    expect(config.inboundFileMaxBytes).toBe(444)
    expect(warn).toHaveBeenCalledTimes(3)
    warn.mockRestore()
  })

  it('leaves schema defaults in place without warnings when neither name is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = resolveDeprecatedConfig(Config({}))
    expect(config.inboundImageMaxPx).toBe(2048)
    expect(config.outboundImageMaxBytes).toBe(Config({}).outboundImageMaxBytes)
    expect(config.inboundFileMaxBytes).toBe(20 * 1024 * 1024)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('still type-validates legacy values at the schemastery layer', () => {
    expect(() => Config({ imageMaxSize: 'not-a-number' })).toThrow()
    expect(() => Config({ maxInboundFileBytes: true })).toThrow()
  })

  it('falls back to legacy when the new name sits exactly at its default value', () => {
    // The default comparison sees only the effective new value, so a new name
    // explicitly set to its default still loses to the legacy value (warned).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = resolveDeprecatedConfig(Config({
      imageMaxSize: 4096,
      inboundImageMaxPx: 2048,
    }))
    expect(config.inboundImageMaxPx).toBe(4096)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
