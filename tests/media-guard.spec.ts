/**
 * Media download guards (M1-A5): SSRF fence around MediaStore.downloadUrl —
 * protocol whitelist, private/loopback address refusal (literal + resolved),
 * per-hop redirect re-checks, and the mid-stream size cap.
 *
 * Rejection paths stub global.fetch to prove it is never reached; DNS is
 * delegated through a wrapper so single tests can fake resolutions. The
 * streaming paths run a real local http server behind the allowPrivateHosts
 * escape hatch to exercise genuine body streaming. Nothing hits the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookup } from 'node:dns/promises'
import { MediaStore } from '../src/media.js'

vi.mock('node:dns/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return { ...actual, lookup: vi.fn(actual.lookup) }
})

const mockedLookup = vi.mocked(lookup)

afterEach(() => {
  vi.unstubAllGlobals()
  mockedLookup.mockReset()
})

/** Local http server on 127.0.0.1 for the real-streaming tests. */
async function listen(handler: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { base: 'http://127.0.0.1:' + port, close: () => new Promise(resolve => server.close(() => resolve())) }
}

describe('MediaStore.downloadUrl SSRF guards (M1-A5)', () => {
  const guardDir = mkdtempSync(join(tmpdir(), 'media-guard-'))
  const store = new MediaStore(guardDir)

  it('rejects non-http(s) protocols and invalid URLs before any fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(store.downloadUrl('file:///etc/passwd', '.bin')).rejects.toThrow(/protocol not allowed/)
    await expect(store.downloadUrl('ftp://mirror.example.com/x.tar.gz', '.bin')).rejects.toThrow(/protocol not allowed/)
    await expect(store.downloadUrl('data:text/plain,hi', '.bin')).rejects.toThrow(/protocol not allowed/)
    await expect(store.downloadUrl('not a url at all', '.bin')).rejects.toThrow(/invalid URL/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects private/loopback IP literals before any fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    for (const url of [
      'http://127.0.0.1/x',
      'http://10.1.2.3/x',
      'http://172.16.0.9/x',
      'http://172.31.255.255/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/x',
      'http://[::1]/x',
      'http://[fd00::1]/x',
      'http://[fe80::1]/x',
      'http://[::ffff:127.0.0.1]/x',
    ]) {
      await expect(store.downloadUrl(url, '.bin'), url).rejects.toThrow(/private\/loopback address not allowed/)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a hostname that resolves to a private address (mocked DNS)', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.9.8.7', family: 4 }])
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(store.downloadUrl('http://internal.example.com/x', '.bin')).rejects.toThrow(/resolves to a private\/loopback/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('re-checks each redirect hop and refuses one pointing at a private address', async () => {
    mockedLookup.mockImplementation(async hostname => hostname === 'internal.example.com'
      ? [{ address: '10.9.8.7', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }])
    const fetchSpy = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://internal.example.com/x' } }))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(store.downloadUrl('http://public.example.com/x', '.bin')).rejects.toThrow(/resolves to a private\/loopback/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('gives up after 3 redirect hops', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const fetchSpy = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/next' } }))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(store.downloadUrl('http://public.example.com/x', '.bin')).rejects.toThrow(/too many redirects/)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('downloads a public URL into the scratch dir (mocked fetch)', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('media-bytes', { status: 200 })))
    const target = await store.downloadUrl('http://public.example.com/photo.jpg', '.jpg')
    await expect(readFile(target)).resolves.toEqual(Buffer.from('media-bytes'))
  })

  it('allowPrivateHosts=true permits local targets (real local server)', async () => {
    const local = new MediaStore(mkdtempSync(join(tmpdir(), 'media-guard-local-')), 6, 0, { allowPrivateHosts: true })
    const { base, close } = await listen((_req, res) => {
      res.end('local-bytes')
    })
    try {
      const target = await local.downloadUrl(base + '/file.bin', '.bin')
      await expect(readFile(target)).resolves.toEqual(Buffer.from('local-bytes'))
    } finally {
      await close()
    }
  })

  it('aborts the stream mid-flight beyond maxBytes while the server never finishes', async () => {
    const local = new MediaStore(mkdtempSync(join(tmpdir(), 'media-guard-cap-')), 6, 0, { allowPrivateHosts: true })
    let clientGone = false
    const { base, close } = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': String(1024 * 1024) })
      // Far more than the 1KB cap, then hold the socket open: a whole-buffer
      // implementation would hang on arrayBuffer() instead of aborting here.
      res.write(Buffer.alloc(64 * 1024, 0x41))
      res.on('close', () => {
        clientGone = true
      })
    })
    try {
      await expect(local.downloadUrl(base + '/big.bin', '.bin', 1024)).rejects.toThrow(/exceeds 1024/)
      await vi.waitFor(() => expect(clientGone).toBe(true), { timeout: 2000 })
    } finally {
      await close()
    }
  })

  it('resolveInner applies the constructor maxBytes to both URL call sites', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const capped = new MediaStore(mkdtempSync(join(tmpdir(), 'media-guard-inner-')), 6, 0, { maxBytes: 8 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('0123456789abcdef', { status: 200 })))
    const unresolve = async () => undefined
    // Direct URL ref.
    await expect(capped.resolve({ kind: 'image', url: 'http://public.example.com/a.jpg' }, unresolve)).resolves.toBeUndefined()
    // Hash ref whose resolveHash answers with a URL.
    await expect(capped.resolve({ kind: 'image', file: 'hash1' }, async () => ({ url: 'http://public.example.com/b.jpg' }))).resolves.toBeUndefined()
  })
})

