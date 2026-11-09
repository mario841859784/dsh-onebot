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
import { mkdtempSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
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
      'http://100.64.0.1/x',
      'http://100.127.255.255/x',
      'http://198.18.0.1/x',
      'http://192.0.0.1/x',
      'http://192.0.2.1/x',
      'http://[64:ff9b:1::7f00:1]/x',
      'http://240.0.0.1/x',
      'http://[::ffff:100.64.1.2]/x',
      'http://[64:ff9b::7f00:1]/x',
    ]) {
      await expect(store.downloadUrl(url, '.bin'), url).rejects.toThrow(/private\/loopback address not allowed/)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not block addresses outside the reserved subnets', async () => {
    for (const [host, address] of [
      ['192.0.1.1', '192.0.1.1'],
      ['100.63.255.255', '100.63.255.255'],
      ['100.128.0.0', '100.128.0.0'],
    ]) {
      mockedLookup.mockResolvedValue([{ address, family: 4 }])
      const fetchSpy = vi.fn(async () => new Response('x', { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)
      await expect(store.downloadUrl('http://' + host + '/x', '.bin')).resolves.toBeTruthy()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    }
  })

  it('only allows private addresses inside allowCidrs', async () => {
    const scoped = new MediaStore(guardDir, 6, 0, { allowCidrs: ['100.64.0.0/10'] })
    mockedLookup.mockResolvedValue([{ address: '100.64.1.2', family: 4 }])
    const fetchSpy = vi.fn(async () => new Response('x', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(scoped.downloadUrl('http://100.64.1.2/x', '.bin')).resolves.toBeTruthy()
    await expect(scoped.downloadUrl('http://10.0.0.1/x', '.bin')).rejects.toThrow(/private\/loopback address not allowed/)
  })

  it('supports IPv6 allowCidrs prefixes', async () => {
    const scoped = new MediaStore(guardDir, 6, 0, { allowCidrs: ['fd7a:115c:a1e0::/48'] })
    mockedLookup.mockResolvedValue([{ address: 'fd7a:115c:a1e0::1', family: 6 }])
    const fetchSpy = vi.fn(async () => new Response('x', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(scoped.downloadUrl('http://[fd7a:115c:a1e0::1]/x', '.bin')).resolves.toBeTruthy()
  })

  it('rejects a hostname with any private address outside allowCidrs', async () => {
    const scoped = new MediaStore(guardDir, 6, 0, { allowCidrs: ['100.64.0.0/10'] })
    mockedLookup.mockResolvedValue([
      { address: '100.64.1.2', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ])
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(scoped.downloadUrl('http://mixed.example.com/x', '.bin')).rejects.toThrow(/resolves to a private\/loopback/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects malformed allowCidrs entries at construction', () => {
    expect(() => new MediaStore(guardDir, 6, 0, { allowCidrs: ['not-a-cidr'] })).toThrow(/invalid allowCidrs/)
  })

  it('rejects empty/non-numeric allowCidrs prefixes that would match any address', () => {
    // Number('') === 0 / Number('+8') === 8 used to slip through and mint a
    // prefix-0 entry (matches every IPv4); '::' doubling used to parse as a
    // shorter address. All must fail construction instead.
    for (const entry of ['10.0.0.0/', '10.0.0.0/ ', '10.0.0.0/+8', '10.0.0.0/abc', '10.0.0.0/1e2', '10.0.0.0/-1', 'fe80::1::/10']) {
      expect(() => new MediaStore(guardDir, 6, 0, { allowCidrs: [entry] }), entry).toThrow(/invalid allowCidrs/)
    }
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
  // resolveContainedPath returns realpath-normalized paths; normalize the fence
  // roots up front so the expected values match on macOS, where /var is a
  // symlink to /private/var and TMPDIR paths get resolved one level deeper.
  const fence = realpathSync(mkdtempSync(join(tmpdir(), 'media-fence-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'media-fence-out-')))

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

describe('file:// refs (inbound media)', () => {
  it('only copies refs inside fileRefRoots and denies by default', async () => {
    const inside = mkdtempSync(join(tmpdir(), 'media-ref-in-'))
    const outside = mkdtempSync(join(tmpdir(), 'media-ref-out-'))
    await writeFile(join(inside, 'ok.txt'), 'ok')
    await writeFile(join(outside, 'secret.txt'), 'secret')

    const scoped = new MediaStore(inside, 6, 0, { fileRefRoots: [inside] })
    const allowed = await scoped.resolve({ kind: 'image', file: 'file://' + join(inside, 'ok.txt') }, async () => undefined)
    expect(allowed?.path).toBeTruthy()
    const denied = await scoped.resolve({ kind: 'image', file: 'file://' + join(outside, 'secret.txt') }, async () => undefined)
    expect(denied).toBeUndefined()

    const defaultStore = new MediaStore(inside, 6, 0)
    const defaultDenied = await defaultStore.resolve({ kind: 'image', file: 'file://' + join(inside, 'ok.txt') }, async () => undefined)
    expect(defaultDenied).toBeUndefined()

    await symlink(join(outside, 'secret.txt'), join(inside, 'link.txt'))
    const escaped = await scoped.resolve({ kind: 'image', file: 'file://' + join(inside, 'link.txt') }, async () => undefined)
    expect(escaped).toBeUndefined()
  })

  it('warns on both refusal branches, naming the ref and fileRefRoots (#21 review)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const inside = mkdtempSync(join(tmpdir(), 'media-ref-warn-in-'))
      const outside = mkdtempSync(join(tmpdir(), 'media-ref-warn-out-'))
      await writeFile(join(inside, 'allowed.txt'), 'ok')
      await writeFile(join(outside, 'refused.txt'), 'no')
      const scoped = new MediaStore(inside, 6, 0, { fileRefRoots: [inside] })
      const unscoped = new MediaStore(inside, 6, 0)
      const noHash = async () => undefined

      // A copied ref stays quiet, so the assertions below only count refusals.
      await expect(scoped.resolve({ kind: 'image', file: 'file://' + join(inside, 'allowed.txt') }, noHash)).resolves.toBeTruthy()
      expect(warn).not.toHaveBeenCalled()

      // Branch 1: fileRefRoots is empty, for a direct ref and for one get_image hands back.
      await expect(unscoped.resolve({ kind: 'image', file: 'file://' + join(inside, 'allowed.txt') }, noHash)).resolves.toBeUndefined()
      await expect(unscoped.resolve({ kind: 'image', file: 'hash' }, async () => ({ file: 'file://' + join(outside, 'refused.txt') }))).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn.mock.calls[0]?.[0]).toMatch(/^\[dsh-onebot\] media resolve refused: .*allowed\.txt.*fileRefRoots/)
      expect(warn.mock.calls[1]?.[0]).toMatch(/^\[dsh-onebot\] media resolve refused: .*refused\.txt.*fileRefRoots/)

      // Branch 2: outside every configured root.
      warn.mockClear()
      await expect(scoped.resolve({ kind: 'image', file: 'file://' + join(outside, 'refused.txt') }, noHash)).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(/^\[dsh-onebot\] media resolve refused: .*refused\.txt.*fileRefRoots/)

      // The ref comes from the inbound payload: line breaks and control characters stay escaped and a long ref is capped.
      warn.mockClear()
      await scoped.resolve({ kind: 'image', file: 'file://' + join(outside, 'a\nb.txt') }, noHash)
      await scoped.resolve({ kind: 'image', file: 'file://' + join(outside, 'a\u2028b\u2029c\u0085d\u009be\u007ff.txt') }, noHash)
      await scoped.resolve({ kind: 'image', file: 'file://' + 'x'.repeat(10_000) }, noHash)
      expect(warn).toHaveBeenCalledTimes(3)
      expect(warn.mock.calls[1]?.[0]).toContain('a\\u2028b\\u2029c\\u0085d\\u009be\\u007ff.txt')
      for (const [message] of warn.mock.calls) {
        expect(message).not.toMatch(/[\r\n\u007f-\u009f\u2028\u2029]/)
        expect(String(message).length).toBeLessThan(1024)
      }
    } finally {
      warn.mockRestore()
    }
  })
})

describe('local media size caps', () => {
  it('caps base64 and file:// payloads with the configured maxBytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-local-cap-'))
    const store = new MediaStore(dir, 6, 0, { maxBytes: 10 })
    const big = 'base64://' + Buffer.alloc(100, 1).toString('base64')
    await expect(store.resolve({ kind: 'image', file: big }, async () => undefined)).resolves.toBeUndefined()

    const p = join(dir, 'big.bin')
    await writeFile(p, Buffer.alloc(100, 1))
    await expect(store.resolve({ kind: 'image', file: 'file://' + p }, async () => undefined)).resolves.toBeUndefined()

    const small = 'base64://' + Buffer.alloc(5, 1).toString('base64')
    await expect(store.resolve({ kind: 'image', file: small }, async () => undefined)).resolves.toBeTruthy()
  })

  it('caps the get_record (hash-ref) base64 payload before decoding it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-hash-cap-'))
    const store = new MediaStore(dir, 6, 0, { maxBytes: 10 })
    // Oversized transcoded audio from resolveHash: refused, nothing written.
    const big = 'base64://' + Buffer.alloc(100, 1).toString('base64')
    await expect(store.resolve({ kind: 'voice', file: 'hash-big' }, async () => ({ file: big }))).resolves.toBeUndefined()
    expect((await readdir(dir)).filter(name => name.startsWith('media_'))).toEqual([])
    // Small payload: passes and is decoded verbatim.
    const small = 'base64://' + Buffer.alloc(5, 1).toString('base64')
    const ok = await store.resolve({ kind: 'voice', file: 'hash-small' }, async () => ({ file: small }))
    expect(ok?.path).toBeTruthy()
    await expect(readFile(ok!.path)).resolves.toEqual(Buffer.alloc(5, 1))
  })
})

describe('segment url that is not http(s)', () => {
  // NapCat sets a voice segment's url to the local file path when its packet
  // backend is unavailable or fetching the url failed; file still holds the
  // code get_record accepts. Paths below are synthetic and never read.
  const audio = Buffer.from('synthetic audio')
  const newStore = () => new MediaStore(mkdtempSync(join(tmpdir(), 'media-nonhttp-')))

  it.each([
    '/var/qq/nt_data/Ptt/Ori/synthetic.amr',
    'C:\\QQ\\nt_data\\Ptt\\Ori\\synthetic.amr',
  ])('falls back to get_record when url is the local path %s', async url => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const resolveHash = vi.fn(async () => ({ file: 'base64://' + audio.toString('base64') }))
    const resolved = await newStore().resolve({ kind: 'voice', url, file: 'voice-code' }, resolveHash)
    expect(resolveHash).toHaveBeenCalledTimes(1)
    expect(resolveHash).toHaveBeenCalledWith('voice', 'voice-code')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(resolved?.kind).toBe('voice')
    await expect(readFile(resolved!.path)).resolves.toEqual(audio)
  })

  it('stays unresolved when there is no file to fall back on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const resolveHash = vi.fn(async () => ({ file: 'base64://' + audio.toString('base64') }))
    await expect(newStore().resolve({ kind: 'voice', url: '/var/qq/synthetic.amr' }, resolveHash)).resolves.toBeUndefined()
    await expect(newStore().resolve({ kind: 'voice', url: '/var/qq/synthetic.amr', file: '' }, resolveHash)).resolves.toBeUndefined()
    expect(resolveHash).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('keeps the fileRefRoots fence when file is a file:// ref', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'media-nonhttp-fence-'))
    await writeFile(join(dir, 'secret.txt'), 'secret')
    const store = new MediaStore(mkdtempSync(join(tmpdir(), 'media-nonhttp-')), 6, 0, { fileRefRoots: [mkdtempSync(join(tmpdir(), 'media-nonhttp-root-'))] })
    const resolved = await store.resolve({ kind: 'voice', url: '/var/qq/synthetic.amr', file: 'file://' + join(dir, 'secret.txt') }, async () => undefined)
    expect(resolved).toBeUndefined()
  })

  it('still refuses a non-http(s) url returned by resolveHash', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const url = '/var/qq/synthetic.jpg'
    const resolveHash = vi.fn(async () => ({ url, file: url }))
    await expect(newStore().resolve({ kind: 'image', url, file: 'image-code' }, resolveHash)).resolves.toBeUndefined()
    expect(resolveHash).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('leaves http(s) urls alone: downloaded directly, no get_record even when the download is refused', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(audio, { status: 200 })))
    const resolveHash = vi.fn(async () => ({ file: 'base64://' + audio.toString('base64') }))
    const ok = await newStore().resolve({ kind: 'voice', url: 'https://public.example.com/a.amr', file: 'voice-code' }, resolveHash)
    await expect(readFile(ok!.path)).resolves.toEqual(audio)
    await expect(newStore().resolve({ kind: 'voice', url: 'http://127.0.0.1/a.amr', file: 'voice-code' }, resolveHash)).resolves.toBeUndefined()
    expect(resolveHash).not.toHaveBeenCalled()
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
