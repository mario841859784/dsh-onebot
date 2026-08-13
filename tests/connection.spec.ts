import { describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { OneBotConnection } from '../src/connection.js'
import type { OneBotEvent } from '../src/connection.js'

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
      const conn = new OneBotConnection(CONFIG)
      conn.onMessage = event => events.push(event)
      return conn
    })()
    connection.start()
    await vi.waitFor(() => {
      expect(connection.address()).toBeDefined()
    })
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
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

  it('fails pending calls on disconnect', async () => {
    const connection = new OneBotConnection(CONFIG)
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const pending = connection.call('get_msg', { message_id: 1 })
    client.close()
    await expect(pending).rejects.toThrow(/closed|stopped/)
    await connection.stop()
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
})
