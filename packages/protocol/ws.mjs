import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/**
 * Hardened zero-dependency RFC 6455 WebSocket connection wrapper.
 * - Enforces client-to-server masking & control-frame invariants (RFC 6455 §5.1 / §5.5)
 * - Releases underlying Buffer slabs when drained to prevent V8 memory retention under high throughput
 * - Supports fragmented frames, 16/64-bit lengths, ping/pong keepalives, and safe JSON serialization
 */
export class WsConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{ isServer: boolean, maxPayloadBytes?: number }} opts
   */
  constructor(socket, { isServer, maxPayloadBytes = 8 * 1024 * 1024 }) {
    super()
    this.socket = socket
    this.isServer = isServer
    this.maxPayloadBytes = maxPayloadBytes
    this.readyState = 1 // OPEN
    this._buffer = Buffer.alloc(0)
    this._fragments = []
    this._fragmentOpcode = 0
    this._fragmentBytes = 0

    socket.setNoDelay(true)

    socket.on('data', (chunk) => this._onData(chunk))
    socket.on('end', () => this._handleClose(1000, ''))
    socket.on('close', () => this._handleClose(1006, ''))
    socket.on('error', (err) => {
      this.emit('error', err)
      this._handleClose(1006, err.message)
    })
  }

  send(data) {
    if (this.readyState !== 1) return false
    const isString = typeof data === 'string'
    const payload = isString ? Buffer.from(data, 'utf8') : Buffer.from(data)
    const opcode = isString ? OPCODE_TEXT : OPCODE_BINARY
    return this._writeFrame(opcode, payload)
  }

  sendJson(obj) {
    return this.send(
      JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    )
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState !== 1) return false
    const buf = Buffer.from(payload)
    if (buf.length > 125) throw new Error('PING payload must be <= 125 bytes')
    return this._writeFrame(OPCODE_PING, buf)
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return
    this.readyState = 2 // CLOSING
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8')
    const payload = Buffer.alloc(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    this._writeFrame(OPCODE_CLOSE, payload)
    setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy()
    }, 250).unref()
  }

  _writeFrame(opcode, payload) {
    const maskBit = this.isServer ? 0 : 0x80
    const len = payload.length
    let headerLen = 2
    if (len >= 126 && len <= 65535) headerLen += 2
    else if (len > 65535) headerLen += 8

    const maskKey = this.isServer ? null : randomBytes(4)
    const totalLen = headerLen + (maskKey ? 4 : 0) + len
    const frame = Buffer.allocUnsafe(totalLen)

    frame[0] = 0x80 | (opcode & 0x0f) // FIN = 1
    let offset = 2
    if (len < 126) {
      frame[1] = maskBit | len
    } else if (len <= 65535) {
      frame[1] = maskBit | 126
      frame.writeUInt16BE(len, 2)
      offset = 4
    } else {
      frame[1] = maskBit | 127
      frame.writeBigUInt64BE(BigInt(len), 2)
      offset = 10
    }

    if (maskKey) {
      maskKey.copy(frame, offset)
      offset += 4
      for (let i = 0; i < len; i++) {
        frame[offset + i] = payload[i] ^ maskKey[i & 3]
      }
    } else {
      payload.copy(frame, offset)
    }

    try {
      return this.socket.write(frame)
    } catch {
      return false
    }
  }

  _protocolViolation(code, reason) {
    this.close(code, reason)
    this._buffer = Buffer.alloc(0)
    this.socket.destroy()
  }

  _onData(chunk) {
    if (this.readyState >= 2) return
    if (this._buffer.length + chunk.length > this.maxPayloadBytes + 16384) {
      this._protocolViolation(1009, 'Inbound buffer exceeded maxPayloadBytes')
      return
    }
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk])

    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0]
      const b1 = this._buffer[1]
      const rsv = b0 & 0x70
      if (rsv !== 0) {
        this._protocolViolation(1002, 'RSV bits must be 0')
        return
      }

      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0

      // RFC 6455 §5.1: client->server frames MUST be masked; server->client MUST NOT be masked
      if (this.isServer && !masked) {
        this._protocolViolation(1002, 'Client frames must be masked')
        return
      }
      if (!this.isServer && masked) {
        this._protocolViolation(1002, 'Server frames must not be masked')
        return
      }

      const isControl = (opcode & 0x08) !== 0
      let payloadLen = b1 & 0x7f
      if (isControl && (!fin || payloadLen > 125)) {
        this._protocolViolation(1002, 'Invalid control frame')
        return
      }

      let offset = 2
      if (payloadLen === 126) {
        if (this._buffer.length < 4) return
        payloadLen = this._buffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return
        const bigLen = this._buffer.readBigUInt64BE(2)
        if (bigLen > BigInt(this.maxPayloadBytes)) {
          this._protocolViolation(1009, 'Payload too large')
          return
        }
        payloadLen = Number(bigLen)
        offset = 10
      }

      if (payloadLen > this.maxPayloadBytes) {
        this._protocolViolation(1009, 'Payload too large')
        return
      }

      const maskLen = masked ? 4 : 0
      const frameTotal = offset + maskLen + payloadLen
      if (this._buffer.length < frameTotal) return

      let payload = this._buffer.subarray(offset + maskLen, frameTotal)
      if (masked) {
        const maskKey = this._buffer.subarray(offset, offset + 4)
        const unmasked = Buffer.allocUnsafe(payloadLen)
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i & 3]
        }
        payload = unmasked
      } else {
        payload = Buffer.from(payload)
      }

      // Release slab reference completely when buffer is fully consumed
      if (this._buffer.length === frameTotal) {
        this._buffer = Buffer.alloc(0)
      } else {
        this._buffer = Buffer.from(this._buffer.subarray(frameTotal))
      }

      this._dispatchFrame(fin, opcode, payload)
      if (this.readyState >= 2) break
    }
  }

  _dispatchFrame(fin, opcode, payload) {
    if (opcode === OPCODE_PING) {
      if (this.readyState === 1) this._writeFrame(OPCODE_PONG, payload)
      this.emit('ping', payload)
      return
    }
    if (opcode === OPCODE_PONG) {
      this.emit('pong', payload)
      return
    }
    if (opcode === OPCODE_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
      if (this.readyState === 1) {
        this.readyState = 2
        this._writeFrame(OPCODE_CLOSE, payload.subarray(0, Math.min(payload.length, 122)))
      }
      this.socket.end()
      this._handleClose(code, reason)
      return
    }

    if (opcode === OPCODE_CONTINUATION) {
      if (this._fragmentOpcode === 0) {
        this._protocolViolation(1002, 'Unexpected continuation frame')
        return
      }
      this._fragmentBytes += payload.length
      if (this._fragmentBytes > this.maxPayloadBytes) {
        this._protocolViolation(1009, 'Fragmented message too large')
        return
      }
      this._fragments.push(payload)
      if (fin) {
        const full = Buffer.concat(this._fragments)
        const origOpcode = this._fragmentOpcode
        this._fragments = []
        this._fragmentBytes = 0
        this._fragmentOpcode = 0
        this._emitMessage(origOpcode, full)
      }
      return
    }

    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      if (this._fragmentOpcode !== 0) {
        this._protocolViolation(1002, 'Unfinished fragmented message')
        return
      }
      if (fin) {
        this._emitMessage(opcode, payload)
      } else {
        this._fragmentOpcode = opcode
        this._fragments = [payload]
        this._fragmentBytes = payload.length
      }
      return
    }

    this._protocolViolation(1002, `Unsupported opcode: ${opcode}`)
  }

  _emitMessage(opcode, buffer) {
    if (opcode === OPCODE_TEXT) {
      this.emit('message', buffer.toString('utf8'), false)
    } else {
      this.emit('message', buffer, true)
    }
  }

  _handleClose(code, reason) {
    if (this.readyState === 3) return
    this.readyState = 3 // CLOSED
    this._buffer = Buffer.alloc(0)
    this._fragments = []
    this.emit('close', code, reason)
  }
}

/**
 * Perform HTTP -> WebSocket server upgrade (RFC 6455).
 */
export function acceptWebSocketUpgrade(req, socket, head, opts = {}) {
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  const upgrade = (req.headers.upgrade || '').toLowerCase()
  if (!key || upgrade !== 'websocket' || (version && version !== '13')) {
    socket.write('HTTP/1.1 400 Bad Request\r\nSec-WebSocket-Version: 13\r\n\r\n')
    socket.destroy()
    return null
  }
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64')

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n')
  )

  const ws = new WsConnection(socket, { isServer: true, ...opts })
  if (head && head.length > 0) {
    ws._onData(head)
  }
  return ws
}

/**
 * Connect as an outbound WebSocket client (ws:// or wss://).
 */
export function connectWebSocket(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const isSecure = url.protocol === 'wss:' || url.protocol === 'https:'
    const transport = isSecure ? https : http
    const key = randomBytes(16).toString('base64')
    const expectedAccept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64')

    const req = transport.request({
      protocol: isSecure ? 'https:' : 'http:',
      hostname: url.hostname,
      port: url.port || (isSecure ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...(opts.headers || {}),
      },
      timeout: opts.timeoutMs ?? 10_000,
    })

    let settled = false
    req.on('upgrade', (res, socket, head) => {
      if (settled) return
      settled = true
      if (res.headers['sec-websocket-accept'] !== expectedAccept) {
        socket.destroy()
        reject(new Error('Invalid Sec-WebSocket-Accept header from server'))
        return
      }
      const ws = new WsConnection(socket, {
        isServer: false,
        maxPayloadBytes: opts.maxPayloadBytes,
      })
      if (head && head.length > 0) ws._onData(head)
      resolve(ws)
    })

    req.on('response', (res) => {
      if (settled) return
      settled = true
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        reject(new Error(`WebSocket upgrade rejected (${res.statusCode}): ${body.slice(0, 200)}`))
      })
    })

    req.on('timeout', () => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('WebSocket connection timeout'))
    })

    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })

    req.end()
  })
}
