#!/usr/bin/env node
// Fake NapCat for the dsh-onebot E2E: dials the plugin's reverse WS server,
// answers action echoes, sends a sequence of private messages (argv), prints
// every outbound send_msg text, and exits after a quiet window.
import WebSocket from 'ws'

const URL = process.argv[2] ?? 'ws://127.0.0.1:18643/ws'
const TOKEN = process.argv[3] ?? 'e2etest'
const ADMIN = process.argv[4] ?? '123456789'
const MESSAGES = process.argv.slice(5)
const QUIET_MS = Number(process.env.PEER_QUIET_MS ?? '20000')

const ws = new WebSocket(URL, { headers: { Authorization: 'Bearer ' + TOKEN } })
const replies = []
let lastActivity = Date.now()
let sent = 0
let finished = false

function sendMessage(text) {
  ws.send(JSON.stringify({
    post_type: 'message', message_type: 'private', user_id: Number(ADMIN), self_id: 100002,
    message_id: 9000 + sent, message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: Number(ADMIN), nickname: 'E2E测试员' },
  }))
  sent += 1
  lastActivity = Date.now()
  console.log('[peer] >> ' + text)
}

ws.on('open', () => {
  console.log('[peer] connected')
  ws.send(JSON.stringify({
    post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect',
    time: Math.floor(Date.now() / 1000), self_id: 100002,
  }))
  if (MESSAGES.length > 0) sendMessage(MESSAGES[0])
})

ws.on('message', data => {
  const frame = JSON.parse(data.toString())
  lastActivity = Date.now()
  if (frame.action) {
    if (frame.action === 'send_msg') {
      const segments = frame.params?.message ?? []
      const text = segments.map(s => s?.data?.text ?? '').join('')
      console.log('[peer] << ' + text)
      replies.push(text)
    } else {
      console.log('[peer] action: ' + frame.action)
    }
  }
  if (typeof frame.echo === 'string') {
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: frame.echo }))
    return
  }
  // Send the next scenario message 4s after the previous exchange quieted.
  if (sent < MESSAGES.length && !finished) {
    const quiet = Date.now() - lastActivity
    if (quiet > 4000) {
      setTimeout(() => sendMessage(MESSAGES[sent]), 500)
    }
  }
})

const timer = setInterval(() => {
  if (sent >= MESSAGES.length && !finished && Date.now() - lastActivity > QUIET_MS) {
    finished = true
    clearInterval(timer)
    console.log('=== E2E DONE ===')
    console.log(JSON.stringify(replies, null, 1))
    process.exit(0)
  }
}, 1000)

const deadline = setTimeout(() => {
  console.error('=== E2E TIMEOUT ===')
  process.exit(1)
}, 180_000)
timer.unref()
deadline.unref()
