import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import https from 'node:https'

/**
 * Self-contained Ed25519 + RFC 6455 WebSocket Client library inside `switch402` CLI package
 * so `npm pack` / `npx switch402` works standalone with zero external dependencies or parent-dir imports.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function generateAgentIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pubJwk = publicKey.export({ format: 'jwk' })
  const privJwk = privateKey.export({ format: 'jwk' })
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${pubJwk.x}"}`
  const keyId = createHash('sha256').update(canonical).digest('base64url')
  return {
    keyId,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: pubJwk.x },
    privateJwk: privJwk,
  }
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function canonicalAuthMessage({ action, agentId, timestamp, nonce, payloadHash = '' }) {
  return `switch402-v1\n${action}\n${agentId}\n${timestamp}\n${nonce}\n${payloadHash}`
}

export function signEd25519(privateJwk, message) {
  const keyObj = createPrivateKey({ key: privateJwk, format: 'jwk' })
  const buf = typeof message === 'string' ? Buffer.from(message, 'utf8') : message
  return sign(null, buf, keyObj).toString('base64url')
}

class ClientWsConnection extends EventEmitter {
  constructor(socket, { maxPayloadBytes = 8 * 1024 * 1024 } = {}) {
    super()
    this.socket = socket
    this.maxPayloadBytes = maxPayloadBytes
    this.readyState = 1
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

  sendJson(obj) {
    if (this.readyState !== 1) return false
    const str = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    return this._writeFrame(0x1, Buffer.from(str, 'utf8'))
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return
    this.readyState = 2
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8')
    const payload = Buffer.alloc(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    this._writeFrame(0x8, payload)
    setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy()
    }, 250).unref()
  }

  _writeFrame(opcode, payload) {
    const len = payload.length
    let headerLen = 2
    if (len >= 126 && len <= 65535) headerLen += 2
    else if (len > 65535) headerLen += 8

    const maskKey = randomBytes(4)
    const frame = Buffer.allocUnsafe(headerLen + 4 + len)
    frame[0] = 0x80 | (opcode & 0x0f)
    let offset = 2
    if (len < 126) {
      frame[1] = 0x80 | len
    } else if (len <= 65535) {
      frame[1] = 0x80 | 126
      frame.writeUInt16BE(len, 2)
      offset = 4
    } else {
      frame[1] = 0x80 | 127
      frame.writeBigUInt64BE(BigInt(len), 2)
      offset = 10
    }
    maskKey.copy(frame, offset)
    offset += 4
    for (let i = 0; i < len; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i & 3]
    }
    try {
      return this.socket.write(frame)
    } catch {
      return false
    }
  }

  _onData(chunk) {
    if (this.readyState >= 2) return
    if (this._buffer.length + chunk.length > this.maxPayloadBytes + 16384) {
      this.close(1009, 'Inbound buffer exceeded maxPayloadBytes')
      this.socket.destroy()
      return
    }
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk])

    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0]
      const b1 = this._buffer[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let payloadLen = b1 & 0x7f
      let offset = 2

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return
        payloadLen = this._buffer.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return
        const bigLen = this._buffer.readBigUInt64BE(2)
        if (bigLen > BigInt(this.maxPayloadBytes)) {
          this.close(1009, 'Payload too large')
          this.socket.destroy()
          return
        }
        payloadLen = Number(bigLen)
        offset = 10
      }

      const maskLen = masked ? 4 : 0
      const frameTotal = offset + maskLen + payloadLen
      if (this._buffer.length < frameTotal) return

      let payload = this._buffer.subarray(offset + maskLen, frameTotal)
      if (masked) {
        const maskKey = this._buffer.subarray(offset, offset + 4)
        const unmasked = Buffer.allocUnsafe(payloadLen)
        for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ maskKey[i & 3]
        payload = unmasked
      } else {
        payload = Buffer.from(payload)
      }

      if (this._buffer.length === frameTotal) {
        this._buffer = Buffer.alloc(0)
      } else {
        this._buffer = Buffer.from(this._buffer.subarray(frameTotal))
      }

      if (opcode === 0x9) {
        if (this.readyState === 1) this._writeFrame(0xa, payload)
      } else if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        if (this.readyState === 1) {
          this.readyState = 2
          this._writeFrame(0x8, payload.subarray(0, Math.min(payload.length, 122)))
        }
        this.socket.end()
        this._handleClose(code, reason)
        return
      } else if (opcode === 0x0) {
        this._fragmentBytes += payload.length
        this._fragments.push(payload)
        if (fin) {
          const full = Buffer.concat(this._fragments)
          const orig = this._fragmentOpcode
          this._fragments = []
          this._fragmentBytes = 0
          this._fragmentOpcode = 0
          this.emit('message', orig === 0x1 ? full.toString('utf8') : full, orig !== 0x1)
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.emit('message', opcode === 0x1 ? payload.toString('utf8') : payload, opcode !== 0x1)
        } else {
          this._fragmentOpcode = opcode
          this._fragments = [payload]
          this._fragmentBytes = payload.length
        }
      }
    }
  }

  _handleClose(code, reason) {
    if (this.readyState === 3) return
    this.readyState = 3
    this._buffer = Buffer.alloc(0)
    this._fragments = []
    this.emit('close', code, reason)
  }
}

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
        reject(new Error('Invalid Sec-WebSocket-Accept header'))
        return
      }
      const ws = new ClientWsConnection(socket, opts)
      if (head && head.length > 0) ws._onData(head)
      resolve(ws)
    })

    req.on('response', (res) => {
      if (settled) return
      settled = true
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () =>
        reject(new Error(`WebSocket upgrade rejected (${res.statusCode}): ${body.slice(0, 200)}`))
      )
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
