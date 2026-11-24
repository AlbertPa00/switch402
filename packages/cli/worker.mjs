import { EventEmitter } from 'node:events'
import { connectWebSocket } from './lib.mjs'

/**
 * Outbound WebSocket Seller Worker Daemon.
 * Standalone, zero-dependency, supports real-time `JOB_CANCEL` GPU abort propagation.
 */
export class SwitchWorker extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.serverUrl
   * @param {string} opts.apiKey
   * @param {Array<any>} opts.capabilities
   * @param {Record<string, (payload: any, ctx: { stream: boolean, sendChunk: (s: string) => void, signal: AbortSignal, jobId: string }) => Promise<any>>} [opts.handlers]
   * @param {string} [opts.localOpenAiUrl]
   * @param {string} [opts.localOpenAiKey]
   * @param {number} [opts.maxConcurrency=8]
   * @param {boolean} [opts.autoReconnect=true]
   */
  constructor(opts) {
    super()
    this.wsUrl = toWsUrl(opts.serverUrl)
    this.apiKey = opts.apiKey
    this.capabilities = opts.capabilities || []
    this.handlers = opts.handlers || {}
    this.localOpenAiUrl = (opts.localOpenAiUrl || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '')
    this.localOpenAiKey = opts.localOpenAiKey || 'ollama'
    this.maxConcurrency = opts.maxConcurrency ?? 8
    this.autoReconnect = opts.autoReconnect ?? true

    this.ws = null
    this.sessionId = null
    this.agentId = null
    this._stopped = false
    this._reconnectTimer = null
    /** @type {Map<string, AbortController>} jobId -> AbortController */
    this.activeJobs = new Map()
  }

  async start() {
    this._stopped = false
    return this._connectOnce()
  }

  stop() {
    this._stopped = true
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    for (const ctrl of this.activeJobs.values()) {
      ctrl.abort()
    }
    this.activeJobs.clear()
    if (this.ws) {
      this.ws.close(1000, 'Worker stopped')
      this.ws = null
    }
  }

  async _connectOnce() {
    const ws = await connectWebSocket(this.wsUrl)
    this.ws = ws

    return new Promise((resolve, reject) => {
      let welcomed = false

      ws.on('message', (raw, isBinary) => {
        if (isBinary) return
        let msg
        try {
          msg = JSON.parse(raw)
        } catch {
          return
        }

        if (msg.type === 'WELCOME') {
          welcomed = true
          this.sessionId = msg.sessionId
          this.agentId = msg.agentId
          this.emit('ready', msg)
          resolve(msg)
          return
        }

        if (msg.type === 'ERROR' && !welcomed) {
          reject(new Error(msg.error || 'Worker handshake failed'))
          return
        }

        if (msg.type === 'SLASHED') {
          this._stopped = true
          this.emit('slashed', msg)
          return
        }

        if (msg.type === 'JOB_CANCEL' && msg.jobId) {
          const ctrl = this.activeJobs.get(msg.jobId)
          if (ctrl) {
            ctrl.abort()
            this.activeJobs.delete(msg.jobId)
            this.emit('job_cancelled', { jobId: msg.jobId, reason: msg.reason })
          }
          return
        }

        if (msg.type === 'JOB_START') {
          this._executeJob(msg).catch(() => {})
        }
      })

      ws.on('close', (code, reason) => {
        for (const ctrl of this.activeJobs.values()) ctrl.abort()
        this.activeJobs.clear()
        this.emit('disconnected', { code, reason })
        if (!welcomed) {
          reject(new Error(`Socket closed before WELCOME (${code}): ${reason}`))
          return
        }
        if (!this._stopped && this.autoReconnect) {
          this._reconnectTimer = setTimeout(() => {
            this._connectOnce().catch((err) => this.emit('error', err))
          }, 1500)
          this._reconnectTimer.unref()
        }
      })

      ws.on('error', (err) => {
        this.emit('error', err)
      })

      ws.sendJson({
        type: 'HELLO',
        apiKey: this.apiKey,
        capabilities: this.capabilities,
        maxConcurrency: this.maxConcurrency,
      })
    })
  }

  async _executeJob(msg) {
    const { jobId, capability, stream, payload } = msg
    const ctrl = new AbortController()
    this.activeJobs.set(jobId, ctrl)

    const sendChunk = (dataStr) => {
      if (!ctrl.signal.aborted && this.ws?.readyState === 1) {
        this.ws.sendJson({ type: 'JOB_CHUNK', jobId, data: dataStr })
      }
    }

    try {
      const customHandler = this.handlers[capability]
      if (customHandler) {
        const out = await customHandler(payload, {
          stream,
          sendChunk,
          signal: ctrl.signal,
          jobId,
        })
        if (ctrl.signal.aborted) return
        if (stream) {
          this.ws?.sendJson({
            type: 'JOB_DONE',
            jobId,
            usage: out?.usage || null,
          })
        } else {
          this.ws?.sendJson({
            type: 'JOB_RESULT',
            jobId,
            result: out?.result !== undefined ? out.result : out,
            usage: out?.usage || null,
          })
        }
        this.emit('job_completed', { jobId, capability })
        return
      }

      if (capability.startsWith('llm:')) {
        await this._proxyLocalOpenAi(jobId, capability.slice(4), payload, stream, sendChunk, ctrl.signal)
        if (!ctrl.signal.aborted) {
          this.emit('job_completed', { jobId, capability })
        }
        return
      }

      throw new Error(`No local handler configured for ${capability}`)
    } catch (err) {
      if (!ctrl.signal.aborted) {
        this.ws?.sendJson({
          type: 'JOB_ERROR',
          jobId,
          error: err.message || String(err),
        })
        this.emit('job_failed', { jobId, capability, error: err })
      }
    } finally {
      this.activeJobs.delete(jobId)
    }
  }

  async _proxyLocalOpenAi(jobId, model, payload, stream, sendChunk, signal) {
    const resp = await fetch(`${this.localOpenAiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.localOpenAiKey}`,
      },
      body: JSON.stringify({ ...payload, model, stream: Boolean(stream) }),
      signal,
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Local inference HTTP ${resp.status}: ${text.slice(0, 160)}`)
    }

    if (!stream) {
      const json = await resp.json()
      if (signal.aborted) return
      this.ws?.sendJson({
        type: 'JOB_RESULT',
        jobId,
        result: json,
        usage: { totalTokens: json?.usage?.total_tokens || 0 },
      })
      return
    }

    const decoder = new TextDecoder()
    let chars = 0
    for await (const chunk of resp.body) {
      if (signal.aborted) return
      const str = decoder.decode(chunk, { stream: true })
      chars += str.length
      sendChunk(str)
    }
    if (!signal.aborted) {
      this.ws?.sendJson({
        type: 'JOB_DONE',
        jobId,
        usage: { totalTokens: Math.max(Math.ceil(chars / 16), 1) },
      })
    }
  }
}

function toWsUrl(origin) {
  const clean = String(origin).replace(/\/+$/, '')
  if (clean.startsWith('ws://') || clean.startsWith('wss://')) {
    return clean.endsWith('/ws/worker') ? clean : `${clean}/ws/worker`
  }
  if (clean.startsWith('https://')) return `wss://${clean.slice(8)}/ws/worker`
  if (clean.startsWith('http://')) return `ws://${clean.slice(7)}/ws/worker`
  return `ws://${clean}/ws/worker`
}
