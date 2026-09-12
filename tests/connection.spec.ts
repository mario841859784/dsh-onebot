import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { OneBotConnection } from '../src/connection.js'
import type { OneBotEvent } from '../src/connection.js'
import { Config, logMetaEvent } from '../src/index.js'

const CONFIG = {
  mode: 'reverse' as const,
  host: '127.0.0.1',
  port: 0,
  url: 'ws://127.0.0.1:3001',
  accessToken: '',
  callTimeoutMs: 3_000,
}

describe('reverse server', () => {
  it('accepts a dial-in client and correlates action calls', async () => {
    const events: OneBotEvent[] = []
    const connection = (() => {
      const conn = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
      conn.onMessage = event => events.push(event)
      return conn
    })()
    connection.start()
    await vi.waitFor(() => {
      expect(connection.address()).toBeDefined()
    })
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    const sentFrames: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      sentFrames.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: frame.echo }))
      }
    })

    const result = await connection.call('send_msg', { user_id: 123, message: [{ type: 'text', data: { text: 'hi' } }] })
    expect(result).toEqual({ message_id: 42 })
    expect(sentFrames[0].action).toBe('send_msg')
    expect(connection.connected).toBe(true)

    // Inbound event dispatch.
    client.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message: 'hi' }))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0].user_id).toBe(10001)
    expect(connection.selfId).toBe('10002')
    client.close()
    await connection.stop()
  })

  it('rejects clients with a bad access token', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'secret' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await new Promise(resolve => {
      client.on('close', (code) => {
        expect(code).toBe(4401)
        resolve(undefined)
      })
      client.on('open', () => undefined)
    })
    await connection.stop()
  })

  it('refuses to start in reverse mode with an empty access token (fail-closed)', () => {
    expect(() => new OneBotConnection(CONFIG).start()).toThrow('reverse mode requires a non-empty accessToken')
  })

  it('rejects clients with a wrong but present access token (constant-time compare)', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    // Same length as the real token, so the length check passes and timingSafeEqual decides.
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tox' } })
    await new Promise(resolve => {
      client.on('close', (code) => {
        expect(code).toBe(4401)
        resolve(undefined)
      })
    })
    await connection.stop()
  })

  it('fails pending calls on disconnect', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const pending = connection.call('get_msg', { message_id: 1 })
    client.close()
    await expect(pending).rejects.toThrow(/closed|stopped/)
    await connection.stop()
  })

  it('keeps the new connection healthy when a replaced socket closes late', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const dial = (): WebSocket => new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    const first = dial()
    await vi.waitFor(() => expect(connection.connected).toBe(true))
    const second = dial()
    await vi.waitFor(() => expect(first.readyState).toBe(WebSocket.CLOSED)) // replaced with code 4000
    // The stale server-side socket's 'close' event lands asynchronously after the new attach.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(connection.connected).toBe(true)
    expect((connection as unknown as { heartbeatTimer?: unknown }).heartbeatTimer).toBeDefined()
    const pending = connection.call('get_msg', { message_id: 1 })
    second.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      if (typeof frame.echo === 'string') {
        second.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
      }
    })
    await expect(pending).resolves.toEqual({ message_id: 1 }) // not failed by the stale close
    second.close()
    await connection.stop()
  })

  it('does not log raw message events', async () => {
    const events: OneBotEvent[] = []
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.onMessage = event => events.push(event)
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const logSpy = vi.spyOn(console, 'log') // attached after the 'listening' log
    client.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 1, message: 'hi' }))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(logSpy).not.toHaveBeenCalled()
    logSpy.mockRestore()
    client.close()
    await connection.stop()
  })
})

describe('config schema', () => {
  it('defaults the reverse host to loopback', () => {
    expect(Config({}).host).toBe('127.0.0.1')
  })
})

describe('forward client', () => {
  it('dials the server, sends Authorization, and reconnects', async () => {
    const frames: Array<Record<string, unknown>> = []
    const makeServer = (port: number): WebSocketServer => {
      const server = new WebSocketServer({ host: '127.0.0.1', port })
      server.on('connection', socket => {
        socket.on('message', data => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>
          frames.push(frame)
          if (typeof frame.echo === 'string') {
            socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { ok: true }, echo: frame.echo }))
          }
        })
      })
      return server
    }

    let server = makeServer(0)
    await new Promise<void>(resolve => {
      server.on('listening', () => resolve())
    })
    const port = (server.address() as { port: number }).port
    const connection = new OneBotConnection({
      ...CONFIG, mode: 'forward', url: 'ws://127.0.0.1:' + port, accessToken: 'tok',
    })
    const statuses: boolean[] = []
    connection.onStatus = (connected: boolean) => statuses.push(connected)
    connection.start()
    await vi.waitFor(() => expect(connection.connected).toBe(true))
    expect(connection.selfId).toBe('')
    await connection.call('get_login_info', {})
    expect(frames[0].action).toBe('get_login_info')

    // Kill the server; the client should reconnect when a new one appears.
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await vi.waitFor(() => expect(connection.connected).toBe(false))
    server = makeServer(port)
    await vi.waitFor(() => expect(connection.connected).toBe(true), { timeout: 8_000 })
    await connection.call('get_login_info', {})
    expect(frames.filter(f => f.action === 'get_login_info')).toHaveLength(2)
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await connection.stop()
  })

  it('still starts in forward mode with an empty access token', async () => {
    // Grab a port that is definitely not listening, so the dial fails and settles.
    const probe = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => probe.on('listening', resolve))
    const deadPort = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const connection = new OneBotConnection({ ...CONFIG, mode: 'forward', url: 'ws://127.0.0.1:' + deadPort })
    expect(() => connection.start()).not.toThrow()
    await vi.waitFor(() => expect((connection as unknown as { socket?: unknown }).socket).toBeUndefined())
    await connection.stop()
  })
})

describe('heartbeat pong watchdog', () => {
  interface HeartbeatView {
    socket: unknown
    lastPongAt: number
    attachSocket(socket: unknown): void
    startHeartbeat(): void
  }
  const expose = (connection: OneBotConnection): HeartbeatView => connection as unknown as HeartbeatView

  interface FakeSocket {
    readyState: number
    on(event: string, listener: (...args: unknown[]) => void): void
    removeAllListeners(): void
    close: (...args: unknown[]) => void
    ping: () => void
    terminate: () => void
    emit(event: string, ...args: unknown[]): void
  }

  /** Minimal ws-like test double: records listeners so tests can emit socket events. */
  const makeFakeSocket = (): FakeSocket => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    return {
      readyState: WebSocket.OPEN,
      on(event, listener) {
        const existing = listeners.get(event) ?? []
        existing.push(listener)
        listeners.set(event, existing)
      },
      removeAllListeners() {
        listeners.clear()
      },
      close: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
      emit(event, ...args) {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
      },
    }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('terminates after two heartbeat periods without pong, but not before', () => {
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    const privateConnection = expose(connection)
    const socket = makeFakeSocket()
    privateConnection.socket = socket
    privateConnection.startHeartbeat()
    // Pretend the last pong arrived 15s ago, so the first tick sees 1.5 stale periods.
    privateConnection.lastPongAt = Date.now() - 15_000
    const warnSpy = vi.spyOn(console, 'warn')

    vi.advanceTimersByTime(30_000)
    expect(socket.ping).toHaveBeenCalledTimes(1)
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(30_000)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    expect(socket.ping).toHaveBeenCalledTimes(1) // the stale tick terminates instead of pinging again
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('mode=reverse')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('75000ms')
    warnSpy.mockRestore()
  })

  it('ignores pong from a replaced socket and refreshes from the current one', () => {
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    const privateConnection = expose(connection)
    const stale = makeFakeSocket()
    const current = makeFakeSocket()
    privateConnection.attachSocket(stale)
    const atAttach = privateConnection.lastPongAt
    privateConnection.attachSocket(current) // last-wins: the stale dial-in gets replaced
    expect(stale.close).toHaveBeenCalledWith(4000, 'replaced')
    vi.setSystemTime(atAttach + 5_000) // move the clock so a wrong refresh would be visible

    stale.emit('pong')
    expect(privateConnection.lastPongAt).toBe(atAttach) // stale pong must not refresh the new connection

    current.emit('pong')
    expect(privateConnection.lastPongAt).toBe(atAttach + 5_000) // the current socket does refresh
  })
})

describe('meta event logging', () => {
  it('keeps heartbeat meta silent but still logs other meta events', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.onMeta = event => logMetaEvent(connection.selfId, event)
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const logSpy = vi.spyOn(console, 'log') // attached after the 'listening' log

    client.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 10002 }))
    await vi.waitFor(() => expect(connection.selfId).toBe('10002')) // the frame reached the real dispatch
    expect(logSpy).not.toHaveBeenCalled()

    client.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'life_cycle', self_id: 10002 }))
    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledTimes(1))
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('life_cycle')
    logSpy.mockRestore()
    client.close()
    await connection.stop()
  })
})

describe('reconnect policy and port conflict (M1-B5)', () => {
  interface ReconnectInternals {
    socket?: unknown
    server?: unknown
    reconnectTimer?: unknown
    reconnectPromise?: unknown
    reconnectAttempts: number
  }
  const internals = (connection: OneBotConnection): ReconnectInternals => connection as unknown as ReconnectInternals

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Dead loopback port: bind once, read the port, release it. */
  const getDeadPort = async (): Promise<number> => {
    const probe = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => probe.on('listening', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    return port
  }

  /** Advance fake timers in 100ms steps until the predicate holds; real I/O settles between ticks. */
  const advanceUntil = async (predicate: () => boolean, budgetMs: number): Promise<void> => {
    for (let advanced = 0; advanced <= budgetMs && !predicate(); advanced += 100) {
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(predicate()).toBe(true)
  }

  it('gives up after reconnectMaxAttempts retries with recovery guidance and stops scheduling', async () => {
    const deadPort = await getDeadPort()
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, mode: 'forward', url: 'ws://127.0.0.1:' + deadPort, reconnectMaxAttempts: 2 })
    const internal = internals(connection)
    const errorSpy = vi.spyOn(console, 'error')
    const warnSpy = vi.spyOn(console, 'warn')
    connection.start()
    // Initial dial fails -> retry #1 scheduled on the 2s rung.
    await advanceUntil(() => internal.reconnectTimer !== undefined, 2_000)
    expect(internal.reconnectAttempts).toBe(1)
    // Retry #1 dials and fails -> retry #2 scheduled on the 5s rung.
    await advanceUntil(() => internal.reconnectAttempts === 2 && internal.reconnectTimer !== undefined, 6_000)
    // Retry #2 dials and fails -> the limit is exceeded -> give up.
    await advanceUntil(() => internal.reconnectTimer === undefined && internal.reconnectPromise === undefined && errorSpy.mock.calls.length > 0, 6_000)
    const giveUp = errorSpy.mock.calls.map(call => call.map(String).join(' ')).find(text => text.includes('giving up'))
    expect(giveUp).toBeDefined()
    expect(giveUp).toContain('reconnectMaxAttempts=2')
    expect(giveUp).toContain('restart the plugin or reload the dsh-onebot channel')
    // Exactly 3 dials happened (initial + 2 retries): one 'forward WS error' warn each.
    expect(warnSpy.mock.calls.filter(call => String(call[0]).includes('forward WS error'))).toHaveLength(3)
    // Nothing stays scheduled, and more fake time does not resurrect a dial.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(internal.reconnectAttempts).toBe(3)
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    await connection.stop()
  })

  it('retries forever when reconnectMaxAttempts is 0', async () => {
    const deadPort = await getDeadPort()
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, mode: 'forward', url: 'ws://127.0.0.1:' + deadPort, reconnectMaxAttempts: 0 })
    const internal = internals(connection)
    const errorSpy = vi.spyOn(console, 'error')
    connection.start()
    // Walk the 2/5/10/30s rungs until the ladder caps at 60s (attempt 5 onwards).
    await advanceUntil(() => internal.reconnectAttempts >= 5, 60_000)
    // 110 capped cycles, far beyond the default limit of 100.
    for (let i = 0; i < 110; i++) {
      await advanceUntil(() => internal.reconnectTimer !== undefined, 65_000)
      expect(vi.getTimerCount()).toBe(1) // exactly one pending reconnect timer at every step
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(errorSpy).not.toHaveBeenCalled() // never gave up
    expect(internal.reconnectAttempts).toBe(115) // 5 ladder rungs + 110 capped retries
    errorSpy.mockRestore()
    await connection.stop()
  })

  it('stop clears the pending reconnect timer and the dial guard', async () => {
    const deadPort = await getDeadPort()
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, mode: 'forward', url: 'ws://127.0.0.1:' + deadPort })
    const internal = internals(connection)
    connection.start()
    await advanceUntil(() => internal.reconnectTimer !== undefined, 5_000)
    expect(vi.getTimerCount()).toBe(1)
    await connection.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(internal.reconnectTimer).toBeUndefined()
    expect(internal.reconnectPromise).toBeUndefined()
    // No ghost dial afterwards either.
    const warnSpy = vi.spyOn(console, 'warn')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(internal.reconnectTimer).toBeUndefined()
    warnSpy.mockRestore()
  })

  it('survives 50 rapid stop/start cycles without ghost timers or duplicate dials', async () => {
    const deadPort = await getDeadPort()
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, mode: 'forward', url: 'ws://127.0.0.1:' + deadPort })
    const internal = internals(connection)
    const warnSpy = vi.spyOn(console, 'warn')
    for (let i = 0; i < 50; i++) {
      connection.start()
      // The fresh dial fails and exactly one reconnect timer gets scheduled.
      await advanceUntil(() => internal.reconnectTimer !== undefined, 5_000)
      expect(vi.getTimerCount()).toBe(1)
      await connection.stop()
      // stop() must wipe every trace: no ghost timer, no dial guard left.
      expect(vi.getTimerCount()).toBe(0)
      expect(internal.reconnectTimer).toBeUndefined()
      expect(internal.reconnectPromise).toBeUndefined()
    }
    // Dial-count metric: every failed dial logs exactly one 'forward WS error'
    // warn and every start() dials exactly once, so 50 cycles -> 50 warns.
    expect(warnSpy.mock.calls.filter(call => String(call[0]).includes('forward WS error'))).toHaveLength(50)
    expect(internal.reconnectAttempts).toBe(50) // cross-check: one scheduleReconnect per failed dial
    warnSpy.mockRestore()
  })

  it('reverse server logs the port and guidance on EADDRINUSE', async () => {
    const occupier = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => occupier.on('listening', resolve))
    const occupiedPort = (occupier.address() as { port: number }).port
    const connection = new OneBotConnection({ ...CONFIG, port: occupiedPort, accessToken: 'tok' })
    const errorSpy = vi.spyOn(console, 'error')
    connection.start()
    await vi.waitFor(() => {
      const logged = errorSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n')
      expect(logged).toContain(String(occupiedPort))
      expect(logged).toContain('already in use')
      expect(logged).toContain('config.port')
    })
    errorSpy.mockRestore()
    await connection.stop()
    await new Promise<void>(resolve => occupier.close(() => resolve()))
  })
})

describe('frame cap and reverse churn guard (M1-A8)', () => {
  interface A8Internals {
    socket?: unknown
    reverseReplaces: number[]
  }
  const internals = (connection: OneBotConnection): A8Internals => connection as unknown as A8Internals

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Dial into the running reverse server with the valid token. */
  const dial = (port: number): WebSocket => new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { Authorization: 'Bearer tok' } })

  /** Fake-timer poll: advance in small steps (real I/O settles between ticks) until the predicate holds. */
  const advanceUntil = async (predicate: () => boolean, budgetMs = 5_000): Promise<void> => {
    for (let advanced = 0; advanced <= budgetMs && !predicate(); advanced += 50) {
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(predicate()).toBe(true)
  }

  it('closes with 1009 a frame that exceeds the 64MiB cap', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const port = connection.address()!.port
    const client = dial(port)
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    let close: { code: number; reason: string } | undefined
    client.on('close', (code, reason) => {
      close = { code, reason: reason.toString() }
    })
    // One binary frame a single byte over the cap: the server must abort it
    // instead of buffering the frame (the ws default cap is 100MiB).
    client.send(Buffer.alloc(64 * 1024 * 1024 + 1, 0x61))
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.CLOSED), { timeout: 10_000 })
    expect(close?.code).toBe(1009)
    await connection.stop()
  })

  it('dials forward with the same 64MiB frame cap', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => {
      server.on('listening', () => resolve())
    })
    const port = (server.address() as { port: number }).port
    const connection = new OneBotConnection({ ...CONFIG, mode: 'forward', url: 'ws://127.0.0.1:' + port, accessToken: 'tok' })
    connection.start()
    await vi.waitFor(() => expect(connection.connected).toBe(true))
    // The dial must carry maxPayload; ws stores it on the post-upgrade Receiver.
    const receiver = (internals(connection).socket as { _receiver?: { _maxPayload?: number } } | undefined)?._receiver
    expect(receiver?._maxPayload).toBe(64 * 1024 * 1024)
    await connection.stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('rejects the 6th healthy-socket replacement within the 60s window', async () => {
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await advanceUntil(() => connection.address() !== undefined)
    const port = connection.address()!.port
    let current = dial(port)
    await advanceUntil(() => connection.connected && current.readyState === WebSocket.OPEN)
    // Five replacements of the healthy dial-in land inside the window...
    for (let i = 0; i < 5; i++) {
      const previous = current
      current = dial(port)
      await advanceUntil(() => connection.connected && current.readyState === WebSocket.OPEN && previous.readyState === WebSocket.CLOSED)
    }
    // ...so the 6th dial-in is rejected without touching the healthy socket.
    const warnSpy = vi.spyOn(console, 'warn')
    const sixth = dial(port)
    let sixthClose: { code: number; reason: string } | undefined
    sixth.on('close', (code, reason) => {
      sixthClose = { code, reason: reason.toString() }
    })
    await advanceUntil(() => sixthClose !== undefined)
    expect(sixthClose?.code).toBe(4000)
    expect(sixthClose?.reason).toBe('too many connections')
    expect(current.readyState).toBe(WebSocket.OPEN) // the legitimate socket survives
    expect(connection.connected).toBe(true)
    expect(warnSpy.mock.calls.some(call => String(call[0]).includes('too many connection replacements'))).toBe(true)
    warnSpy.mockRestore()
    await connection.stop()
  })

  it('allows paced replacements and the drop-then-redial flow', async () => {
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await advanceUntil(() => connection.address() !== undefined)
    const port = connection.address()!.port
    let current = dial(port)
    await advanceUntil(() => connection.connected && current.readyState === WebSocket.OPEN)
    for (let i = 0; i < 2; i++) {
      const previous = current
      await vi.advanceTimersByTimeAsync(10_000) // normal redial spacing, still inside the window
      current = dial(port)
      await advanceUntil(() => connection.connected && current.readyState === WebSocket.OPEN && previous.readyState === WebSocket.CLOSED)
    }
    // NapCat drop-then-redial: the dead socket never counts as a replacement.
    current.close()
    await advanceUntil(() => !connection.connected)
    const redial = dial(port)
    await advanceUntil(() => connection.connected && redial.readyState === WebSocket.OPEN)
    expect(internals(connection).reverseReplaces).toHaveLength(2) // only the healthy replacements counted
    await connection.stop()
  })
})

describe('injected log port (M3-E3b)', () => {
  it('routes transport diagnostics through the injected log sink', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const connection = new OneBotConnection({
      ...CONFIG, accessToken: 'secret',
      log: (level, message) => logs.push({ level, message }),
    })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    // The listening info line arrives through the port, not the console.
    expect(logs.some(l => l.level === 'info' && l.message.includes('listening on ws://'))).toBe(true)
    const warnSpy = vi.spyOn(console, 'warn')
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await new Promise(resolve => {
      client.on('close', code => { expect(code).toBe(4401); resolve(undefined) })
      client.on('open', () => undefined)
    })
    // The rejection warning flows through the sink and never touches console.
    expect(logs.some(l => l.level === 'warn' && l.message.includes('bad access token'))).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
    client.close()
    await connection.stop()
  })

  it('falls back to the console when no log is injected (standalone usability)', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'secret' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer secret' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const warnSpy = vi.spyOn(console, 'warn')
    client.send('not-json')
    await vi.waitFor(() => {
      expect(warnSpy.mock.calls.some(call => String(call[0]).includes('dropping non-JSON WS frame'))).toBe(true)
    })
    warnSpy.mockRestore()
    client.close()
    await connection.stop()
  })
})
