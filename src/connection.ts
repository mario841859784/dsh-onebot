/**
 * OneBot 11 WebSocket transport: reverse server (NapCat ws-reverse dials in)
 * and forward client (we dial NapCat's ws server), frame handling, echo
 * correlation for action calls, heartbeat, and reconnect-with-backoff.
 * Ported from the Hermes OneBotAdapter connection half.
 * @module dsh-onebot/connection
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'

/** OneBot 11 event payload (loose: implementations vary). */
export interface OneBotEvent {
  post_type?: string
  message_type?: string
  notice_type?: string
  request_type?: string
  user_id?: number | string
  group_id?: number | string
  self_id?: number | string
  message_id?: number | string
  message?: unknown
  raw_message?: string
  sender?: { user_id?: number | string; nickname?: string; card?: string; role?: string }
  [key: string]: unknown
}

/** Action-call result from the OneBot endpoint. */
export interface ActionResult {
  status: string
  retcode: number
  data: unknown
  wording?: string
}

/** Connection mode. */
export type OneBotMode = 'reverse' | 'forward'

/** Transport configuration. */
export interface ConnectionConfig {
  mode: OneBotMode
  host: string
  port: number
  url: string
  accessToken: string
  /** Per-action call timeout in ms. */
  callTimeoutMs: number
  /**
   * Forward-mode reconnect attempt limit before giving up with a recovery
   * hint. Undefined keeps the built-in default (100); 0 retries forever (the
   * backoff ladder still caps the delay at its last value).
   */
  reconnectMaxAttempts?: number
}

/** Reconnect backoff ladder (seconds); the last value repeats. */
const RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
const MAX_RECONNECT_ATTEMPTS = 100
const HEARTBEAT_MS = 30_000
/**
 * Per-frame byte cap for both directions. ws defaults to 100MiB, letting a
 * token holder pin memory with a single giant frame. 64MiB keeps ample
 * headroom over the 20MiB maxInboundFileBytes default: a get_file response
 * carrying a max-size file is ~27MiB as base64 plus JSON framing.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024
/**
 * Reverse churn guard: at most CHURN_MAX_REPLACES replacements of a healthy
 * dial-in within CHURN_WINDOW_MS; further dial-ins are rejected so rapid
 * re-dials cannot endlessly squeeze out the legitimate NapCat.
 */
const CHURN_WINDOW_MS = 60_000
const CHURN_MAX_REPLACES = 5
/** Error thrown for action calls that fail or time out. */
export class OneBotActionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OneBotActionError'
  }
}

/** Error thrown when the transport is not connected. */
export class OneBotNotConnectedError extends Error {
  constructor(message = 'OneBot WebSocket not connected') {
    super(message)
    this.name = 'OneBotNotConnectedError'
  }
}

/** The pending-action correlation entry. */
interface PendingAction {
  resolve(data: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * OneBot 11 transport. One instance handles exactly one peer: either a
 * reverse server accepting NapCat's dial-in or a forward client dialing out.
 * All frames share the same correlation table.
 */
export class OneBotConnection {
  readonly config: ConnectionConfig

  /** Inbound message event handler; the bridge/plugin wires this. */
  onMessage: (event: OneBotEvent) => void = () => undefined
  /** Meta event handler (self_id learning). */
  onMeta: (event: OneBotEvent) => void = () => undefined
  /** Connection-state callback. */
  onStatus: (connected: boolean) => void = () => undefined

  private server: WebSocketServer | undefined
  private socket: WebSocket | undefined
  private lastPongAt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private pending = new Map<string, PendingAction>()
  private stopping = false
  private reconnectPromise: Promise<void> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  private connectedFlag = false
  /** Reverse churn guard: timestamps (ms) of recent healthy-socket replacements. */
  private reverseReplaces: number[] = []

  /** The bot's own QQ id, learned from meta events (or config botQQ). */
  selfId = ''

  constructor(config: ConnectionConfig) {
    this.config = config
  }

  /** Whether the transport currently has a live socket. */
  get connected(): boolean {
    return this.connectedFlag
  }

  /** The reverse server's bound address (for tests / diagnostics), if any. */
  address(): { host: string; port: number } | undefined {
    const address = this.server?.address()
    if (typeof address === 'object' && address !== null) {
      return { host: address.address, port: address.port }
    }
    return undefined
  }

  /** Start the transport (server or client) without blocking. */
  start(): void {
    // Reentrancy guard: a live socket/server or a pending reconnect means the
    // transport is already up (or about to dial). Restarting blindly would
    // leave a stale reconnect timer dialing into the new session (ghosts).
    if (this.socket !== undefined || this.server !== undefined || this.reconnectTimer !== undefined || this.reconnectPromise !== undefined) {
      return
    }
    this.stopping = false
    if (this.config.mode === 'reverse') this.startReverseServer()
    else void this.connectForwardOnce()
  }

  /** Stop the transport: close sockets, cancel reconnects, fail pending calls. */
  async stop(): Promise<void> {
    this.stopping = true
    // Cancel a pending reconnect dial: a stale timer firing into the next
    // start() would open a second (ghost) connection.
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.reconnectPromise = undefined
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined) {
      socket.removeAllListeners()
      try {
        socket.close()
      } catch {
        // already closing
      }
    }
    await new Promise<void>(resolve => {
      if (this.server === undefined) {
        resolve()
        return
      }
      const server = this.server
      this.server = undefined
      server.close(() => resolve())
      // Force-resolve if close hangs (open client sockets keep it open).
      setTimeout(resolve, 2_000).unref()
      for (const client of server.clients) {
        try {
          client.terminate()
        } catch {
          // ignore
        }
      }
    })
    this.failAllPending(new OneBotNotConnectedError('OneBot transport stopped'))
  }

  /**
   * Call a OneBot action and await its data payload.
   * @param action - OneBot 11 action name.
   * @param params - action parameters (plain object).
   * @returns the action data payload (object or array).
   * @throws OneBotNotConnectedError / OneBotActionError on failure or timeout.
   */
  call(action: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN || this.stopping) {
      return Promise.reject(new OneBotNotConnectedError())
    }
    const echo = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new OneBotActionError('OneBot action ' + action + ' timed out after ' + this.config.callTimeoutMs + 'ms'))
      }, this.config.callTimeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        this.pending.delete(echo)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new OneBotActionError(String(error)))
      }
    })
  }

  // ------------------------------------------------------------------ reverse

  private startReverseServer(): void {
    if (this.config.accessToken === '') {
      throw new Error('reverse mode requires a non-empty accessToken')
    }
    const server = new WebSocketServer({ host: this.config.host, port: this.config.port, maxPayload: MAX_FRAME_BYTES })
    this.server = server
    server.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') {
        console.error('[dsh-onebot] reverse WS server cannot listen on ' + this.config.host + ':' + this.config.port + ': port already in use (EADDRINUSE); stop the process occupying this port, or change config.port')
        return
      }
      console.error('[dsh-onebot] reverse WS server error:', error)
    })
    server.on('connection', (socket, request) => {
      const expected = Buffer.from('Bearer ' + this.config.accessToken, 'utf8')
      const provided = Buffer.from(request.headers.authorization ?? '', 'utf8')
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        console.warn('[dsh-onebot] rejecting reverse WS client: bad access token')
        socket.close(4401, 'unauthorized')
        return
      }
      // Last-wins: NapCat expects a single dial-in; close any older socket.
      const previous = this.socket
      if (previous !== undefined && previous.readyState < WebSocket.CLOSING) {
        // Churn guard: endlessly replacing the healthy dial-in squeezes out
        // the legitimate NapCat, so cap replacements per rolling window.
        const now = Date.now()
        this.reverseReplaces = this.reverseReplaces.filter(at => now - at < CHURN_WINDOW_MS)
        if (this.reverseReplaces.length >= CHURN_MAX_REPLACES) {
          console.warn('[dsh-onebot] rejecting reverse WS client: too many connection replacements within ' + CHURN_WINDOW_MS / 1000 + 's')
          socket.close(4000, 'too many connections')
          return
        }
        this.reverseReplaces.push(now)
        try {
          previous.close(4000, 'replaced')
        } catch {
          // ignore
        }
      }
      this.attachSocket(socket)
      this.startHeartbeat()
    })
    server.on('listening', () => {
      const address = server.address()
      const shown = typeof address === 'object' && address !== null ? address.address + ':' + address.port : String(address)
      console.log('[dsh-onebot] reverse WS server listening on ws://' + shown + ' (path /ws or /)')
    })
    server.on('close', () => {
      this.server = undefined
    })
  }

  // ------------------------------------------------------------------ forward

  private connectForwardOnce(): void {
    if (this.stopping) return
    const url = this.config.url
    const headers: Record<string, string> = {}
    if (this.config.accessToken !== '') headers.Authorization = 'Bearer ' + this.config.accessToken
    let socket: WebSocket
    try {
      socket = new WebSocket(url, { headers, handshakeTimeout: 10_000, maxPayload: MAX_FRAME_BYTES })
    } catch (error) {
      console.error('[dsh-onebot] forward WS connect failed:', error)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.on('open', () => {
      this.reconnectAttempts = 0
      this.lastPongAt = Date.now()
      this.setConnected(true)
      this.startHeartbeat()
    })
    socket.on('message', data => this.onFrame(data))
    socket.on('pong', () => {
      if (this.socket !== socket) return // stale socket: a newer dial owns the timestamps
      this.lastPongAt = Date.now()
    })
    socket.on('error', error => {
      console.warn('[dsh-onebot] forward WS error:', error instanceof Error ? error.message : String(error))
    })
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return // stale socket: a newer dial has replaced it
      this.socket = undefined
      this.stopHeartbeat()
      this.setConnected(false)
      this.failAllPending(new OneBotNotConnectedError('OneBot WS closed (code ' + code + ')'))
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectPromise !== undefined) return
    this.reconnectAttempts += 1
    // reconnectMaxAttempts: undefined -> built-in default, positive -> give up
    // once exceeded, 0 or negative -> retry forever (the ladder still caps the
    // delay at its last value).
    const max = this.config.reconnectMaxAttempts ?? MAX_RECONNECT_ATTEMPTS
    if (max > 0 && this.reconnectAttempts > max) {
      console.error('[dsh-onebot] giving up forward WS reconnect after ' + max + ' retries (reconnectMaxAttempts=' + max + '); check the NapCat ws address and network, then restart the plugin or reload the dsh-onebot channel to reconnect')
      return
    }
    const index = Math.min(this.reconnectAttempts - 1, RECONNECT_BACKOFF.length - 1)
    const delay = RECONNECT_BACKOFF[index] * 1000
    this.reconnectPromise = new Promise<void>(resolve => {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined
        this.reconnectPromise = undefined
        resolve()
        this.connectForwardOnce()
      }, delay).unref()
    })
  }

  // ------------------------------------------------------------------ shared

  private attachSocket(socket: WebSocket): void {
    const previous = this.socket
    this.socket = socket
    this.lastPongAt = Date.now()
    socket.on('message', data => this.onFrame(data))
    socket.on('pong', () => {
      if (this.socket !== socket) return // stale socket: a newer dial-in owns the timestamps
      this.lastPongAt = Date.now()
    })
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return // stale socket: a newer dial-in replaced it
      this.socket = undefined
      this.stopHeartbeat()
      this.setConnected(false)
      this.failAllPending(new OneBotNotConnectedError('OneBot WS closed (code ' + code + ')'))
      if (!this.stopping) {
        console.warn('[dsh-onebot] reverse WS client disconnected: ' + code + ' ' + reason.toString())
      }
    })
    socket.on('error', error => {
      console.warn('[dsh-onebot] reverse WS client error:', error instanceof Error ? error.message : String(error))
    })
    this.setConnected(true)
    if (previous !== undefined && previous !== socket && previous.readyState < WebSocket.CLOSING) {
      try {
        previous.close(4000, 'replaced')
      } catch {
        // ignore
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket
      if (socket === undefined) return
      if (socket.readyState !== WebSocket.OPEN) return
      const now = Date.now()
      if (now - this.lastPongAt >= 2 * HEARTBEAT_MS) {
        console.warn('[dsh-onebot] heartbeat timeout: no pong for ' + (now - this.lastPongAt) + 'ms (mode=' + this.config.mode + '); terminating socket')
        socket.terminate()
        return
      }
      try {
        socket.ping()
      } catch {
        // socket may be closing
      }
    }, HEARTBEAT_MS).unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private setConnected(connected: boolean): void {
    if (this.connectedFlag === connected) return
    this.connectedFlag = connected
    try {
      this.onStatus(connected)
    } catch (error) {
      console.error('[dsh-onebot] onStatus handler failed:', error)
    }
  }

  private failAllPending(error: Error): void {
    for (const [echo, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** One JSON frame: an action response (has echo) or an inbound event. */
  private onFrame(data: WebSocket.RawData): void {
    let payload: unknown
    try {
      payload = JSON.parse(data.toString())
    } catch {
      console.warn('[dsh-onebot] dropping non-JSON WS frame')
      return
    }
    if (typeof payload !== 'object' || payload === null) return
    const frame = payload as Record<string, unknown>

    if (typeof frame.echo === 'string' && this.pending.has(frame.echo)) {
      const pending = this.pending.get(frame.echo)
      this.pending.delete(frame.echo)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      if (frame.status === 'ok') {
        pending.resolve(frame.data ?? {})
      } else {
        const wording = typeof frame.wording === 'string' ? frame.wording : ''
        const retcode = frame.retcode ?? 'unknown'
        pending.reject(new OneBotActionError('OneBot action failed (retcode ' + retcode + ')' + (wording !== '' ? ': ' + wording : '')))
      }
      return
    }

    if (typeof frame.post_type === 'string') {
      const event = frame as unknown as OneBotEvent
      if (typeof event.self_id === 'number' || typeof event.self_id === 'string') {
        this.selfId = String(event.self_id)
      }
      if (event.post_type === 'message') {
        try {
          this.onMessage(event)
        } catch (error) {
          console.error('[dsh-onebot] onMessage handler failed:', error)
        }
        return
      }
      if (event.post_type === 'meta_event') {
        try {
          this.onMeta(event)
        } catch (error) {
          console.error('[dsh-onebot] onMeta handler failed:', error)
        }
        return
      }
      // notice / request events are intentionally ignored (v1).
    }
  }
}
