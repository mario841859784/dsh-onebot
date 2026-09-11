/**
 * Media download guards (M1-A5): SSRF fence around MediaStore.downloadUrl —
 * protocol whitelist, private/loopback address refusal (literal + resolved),
 * per-hop redirect re-checks, and the mid-stream size cap — plus the outbound
 * path fence (M1-A3a): resolveContainedPath / fileToBase64 allowedRoots.
 *
 * Rejection paths stub global.fetch to prove it is never reached; DNS is
 * delegated through a wrapper so single tests can fake resolutions. The
 * streaming paths run a real local http server behind the allowPrivateHosts
 * escape hatch to exercise genuine body streaming. Nothing hits the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookup } from 'node:dns/promises'
import { fileToBase64, MediaStore, resolveContainedPath } from '../src/media.js'

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

describe('resolveContainedPath fence (M1-A3a)', () => {
  const fence = mkdtempSync(join(tmpdir(), 'media-fence-'))
  const outside = mkdtempSync(join(tmpdir(), 'media-fence-out-'))

  it('accepts contained paths and returns their realpath', async () => {
    await writeFile(join(fence, 'a.txt'), 'x')
    await expect(resolveContainedPath([fence], join(fence, 'a.txt'))).resolves.toBe(join(fence, 'a.txt'))
    await expect(resolveContainedPath([fence], fence)).resolves.toBe(fence)
  })

  it('rejects paths outside every root', async () => {
    await writeFile(join(outside, 'b.txt'), 'x')
    await expect(resolveContainedPath([fence], join(outside, 'b.txt'))).resolves.toBeNull()
    await expect(resolveContainedPath([fence], '/etc/hostname')).resolves.toBeNull()
  })

  it('keeps the separator boundary: root …/foo does not contain …/foobar', async () => {
    await mkdir(join(fence, 'foo'), { recursive: true })
    await mkdir(join(fence, 'foobar'), { recursive: true })
    await writeFile(join(fence, 'foobar', 'x.txt'), 'x')
    await expect(resolveContainedPath([join(fence, 'foo')], join(fence, 'foobar', 'x.txt'))).resolves.toBeNull()
    await writeFile(join(fence, 'foo', 'y.txt'), 'x')
    await expect(resolveContainedPath([join(fence, 'foo')], join(fence, 'foo', 'y.txt'))).resolves.toBe(join(fence, 'foo', 'y.txt'))
  })

  it('rejects symlink escapes and resolves inner symlinks to the real path', async () => {
    await writeFile(join(fence, 'in.txt'), 'inner')
    await writeFile(join(outside, 'out.txt'), 'outer')
    await symlink(join(outside, 'out.txt'), join(fence, 'escape'))
    await symlink(join(fence, 'in.txt'), join(fence, 'inside'))
    await expect(resolveContainedPath([fence], join(fence, 'escape'))).resolves.toBeNull()
    await expect(resolveContainedPath([fence], join(fence, 'inside'))).resolves.toBe(join(fence, 'in.txt'))
  })

  it('rejects missing targets and tolerates missing roots', async () => {
    await expect(resolveContainedPath([fence], join(fence, 'missing.txt'))).resolves.toBeNull()
    await expect(resolveContainedPath([join(fence, 'no-such-root')], join(fence, 'a.txt'))).resolves.toBeNull()
    await expect(resolveContainedPath([join(fence, 'no-such-root'), fence], join(fence, 'a.txt'))).resolves.toBe(join(fence, 'a.txt'))
  })
})

describe('fileToBase64 allowedRoots (M1-A3a)', () => {
  it('refuses outside paths and accepts contained ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-b64-'))
    const outside = mkdtempSync(join(tmpdir(), 'media-b64-out-'))
    await writeFile(join(dir, 'ok.txt'), 'contained')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const roots = [dir]
    await expect(fileToBase64(join(outside, 'secret.txt'), 1000, roots)).rejects.toThrow(/not allowed or does not exist/)
    await expect(fileToBase64(join(dir, 'ok.txt'), 1000, roots)).resolves.toBe('base64://' + Buffer.from('contained').toString('base64'))
  })

  it('keeps the legacy uncaged behavior when allowedRoots is omitted (transition until tools wire it)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'media-b64-out2-'))
    await writeFile(join(outside, 'legacy.txt'), 'legacy')
    await expect(fileToBase64(join(outside, 'legacy.txt'), 1000)).resolves.toBe('base64://' + Buffer.from('legacy').toString('base64'))
  })
})
