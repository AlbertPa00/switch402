import { randomBytes } from 'node:crypto'
import { nanoToUsd, usdToNano } from '../protocol/index.mjs'

/**
 * Hardened Live WebSocket Seller Registry, Score-Based Router, TTFT Auto-Failover & 1% Canary Slashing Engine.
 */
export class SellerRouter {
  /**
   * @param {object} opts
   * @param {import('./ledger.mjs').NanoLedger} opts.ledger
   * @param {import('./upstream.mjs').HouseUpstream} opts.house
   * @param {number} [opts.ttftTimeoutMs=1500]
   * @param {number} [opts.jobHardTimeoutMs=45000]
   * @param {number} [opts.canarySampleRate=0.01]
   */
  constructor({
    ledger,
    house,
    ttftTimeoutMs = 1500,
    jobHardTimeoutMs = 45_000,
    canarySampleRate = 0.01,
  }) {
    this.ledger = ledger
    this.house = house
    this.ttftTimeoutMs = ttftTimeoutMs
    this.jobHardTimeoutMs = jobHardTimeoutMs
    this.canarySampleRate = canarySampleRate

    /** @type {Map<string, any>} sessionId -> WorkerSession */
    this.sessions = new Map()
    /** @type {Map<string, Set<string>>} capability -> Set<sessionId> */
    this.capIndex = new Map()

    this._pingTimer = setInterval(() => this._heartbeat(), 20_000)
    this._pingTimer.unref()
  }

  close() {
    clearInterval(this._pingTimer)
    for (const s of this.sessions.values()) {
      s.ws.close(1001, 'Server shutting down')
    }
    this.sessions.clear()
    this.capIndex.clear()
  }

  /**
   * Attach an upgraded RFC 6455 WebSocket connection from a Seller Worker.
   */
  handleWorkerConnection(ws) {
    const sessionId = `ws_${randomBytes(6).toString('hex')}`
    let authenticated = false

    const authTimeout = setTimeout(() => {
      if (!authenticated) ws.close(4001, 'HELLO authentication timeout')
    }, 8_000)
    authTimeout.unref()

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        ws.close(4002, 'Malformed JSON frame')
        return
      }

      if (!authenticated) {
        if (msg.type !== 'HELLO') {
          ws.close(4001, 'Expected HELLO frame first')
          return
        }
        clearTimeout(authTimeout)
        const ok = this._registerWorkerSession(sessionId, ws, msg)
        if (ok) authenticated = true
        return
      }

      this._handleWorkerMessage(sessionId, msg)
    })

    ws.on('close', () => {
      clearTimeout(authTimeout)
      this._evictSession(sessionId, 'Worker WebSocket disconnected')
    })

    ws.on('error', () => {
      clearTimeout(authTimeout)
      this._evictSession(sessionId, 'Worker WebSocket error')
    })
  }

  _registerWorkerSession(sessionId, ws, msg) {
    const acct = this.ledger.getAgentByApiKey(msg.apiKey)
    if (!acct) {
      ws.sendJson({ type: 'ERROR', error: 'Invalid apiKey in HELLO' })
      ws.close(4001, 'Invalid apiKey')
      return false
    }
    if (acct.banned) {
      ws.sendJson({ type: 'ERROR', error: 'Agent permanently banned due to failed canary / spoofing' })
      ws.close(4003, 'Agent banned')
      return false
    }

    const rawCaps = Array.isArray(msg.capabilities) ? msg.capabilities : []
    if (rawCaps.length === 0 || rawCaps.length > 64) {
      ws.sendJson({ type: 'ERROR', error: 'Provide 1..64 capabilities in HELLO' })
      ws.close(4002, 'Invalid capabilities list')
      return false
    }

    const capsMap = new Map()
    for (const c of rawCaps) {
      const capName = String(c.capability || '').trim()
      if (!/^(llm|act):[a-zA-Z0-9._/-]{2,80}$/.test(capName)) continue
      const kind = capName.startsWith('llm:') ? 'chat' : 'act'
      const priceUsdStr =
        kind === 'chat'
          ? String(c.pricePer1MUsd || '0.15')
          : String(c.pricePerCallUsd || '0.0005')

      let priceNano
      try {
        priceNano = usdToNano(priceUsdStr)
      } catch {
        continue
      }
      // Enforce sane price bounds ($0.000001 .. $100.00)
      if (priceNano <= 0n || priceNano > usdToNano('100.00')) continue

      capsMap.set(capName, {
        capability: capName,
        kind,
        priceUsd: Number(priceUsdStr),
        priceNano,
        description: String(c.description || '').slice(0, 240),
        inputSchema: c.inputSchema || null,
        outputSchema: c.outputSchema || null,
        canaryVector: c.canaryVector || null,
      })
    }

    if (capsMap.size === 0) {
      ws.sendJson({ type: 'ERROR', error: 'No valid llm:* or act:* capabilities advertised' })
      ws.close(4002, 'No valid capabilities')
      return false
    }

    const session = {
      sessionId,
      agentId: acct.id,
      agentName: acct.name || acct.id,
      ws,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
      maxConcurrency: Math.min(Math.max(Number(msg.maxConcurrency || 8), 1), 128),
      inFlight: 0,
      emaSuccess: 0.98,
      emaLatencyMs: 250,
      capabilities: capsMap,
      /** @type {Map<string, any>} jobId -> PendingJob */
      pendingJobs: new Map(),
    }

    ws.on('pong', () => {
      session.lastPongAt = Date.now()
    })

    this.sessions.set(sessionId, session)
    for (const capName of capsMap.keys()) {
      let set = this.capIndex.get(capName)
      if (!set) {
        set = new Set()
        this.capIndex.set(capName, set)
      }
      set.add(sessionId)
    }

    ws.sendJson({
      type: 'WELCOME',
      sessionId,
      agentId: acct.id,
      registeredCapabilities: Array.from(capsMap.keys()),
    })
    if (this.onSessionRegistered) {
      try {
        this.onSessionRegistered(sessionId)
      } catch {
        // ignore hook error
      }
    }
    return true
  }

  _evictSession(sessionId, reason) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    for (const capName of session.capabilities.keys()) {
      const set = this.capIndex.get(capName)
      if (set) {
        set.delete(sessionId)
        if (set.size === 0) this.capIndex.delete(capName)
      }
    }
    for (const job of session.pendingJobs.values()) {
      job.fail(new Error(reason))
    }
    session.pendingJobs.clear()
  }

  /**
   * Rank available online Seller sessions for a capability.
   */
  rankCandidates(capability, { excludeAgents = new Set(), maxPriceUsd = Infinity } = {}) {
    const sessionIds = this.capIndex.get(capability)
    if (!sessionIds || sessionIds.size === 0) return []

    const candidates = []
    for (const sid of sessionIds) {
      const s = this.sessions.get(sid)
      if (!s || s.ws.readyState !== 1) continue
      if (s.inFlight >= s.maxConcurrency) continue
      if (excludeAgents.has(s.agentId)) continue
      const acct = this.ledger.getAgent(s.agentId)
      if (!acct || acct.banned) continue

      const cap = s.capabilities.get(capability)
      if (!cap || cap.priceUsd > maxPriceUsd) continue

      const score =
        Math.pow(Math.max(s.emaSuccess, 0.05), 3) /
        (Math.max(cap.priceUsd, 0.000001) * (1 + s.emaLatencyMs / 1000))
      candidates.push({ session: s, cap, score })
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates
  }

  /**
   * Estimate maximum cost in nanoUSD to reserve from Buyer before running a call
   * (covers top 3 failover candidates + House fallback so failover never under-reserves).
   */
  estimateBuyerReserveNano(capability, body = {}, maxPriceUsd = Infinity) {
    const ranked = this.rankCandidates(capability, { maxPriceUsd })
    let maxP2pNano = 0n
    for (const item of ranked.slice(0, 3)) {
      const est = this._estimateSellerChargeNano(item.cap, body)
      if (est > maxP2pNano) maxP2pNano = est
    }
    const houseNano = this.house.canFulfill(capability)
      ? (this.house.estimateMaxWholesaleNano(capability, body) * 11500n) / 10000n
      : 0n
    const maxNano = maxP2pNano > houseNano ? maxP2pNano : houseNano
    return maxNano > 0n ? maxNano : usdToNano('0.002')
  }

  _estimateSellerChargeNano(cap, body = {}) {
    if (cap.kind === 'act') return cap.priceNano
    const maxTokens = Math.min(Math.max(Number(body.max_tokens || 1024), 64), 16384)
    const promptBytes = Buffer.byteLength(JSON.stringify(body.messages || []), 'utf8')
    const estTokens = BigInt(Math.ceil(promptBytes / 2) + maxTokens + 64)
    const est = (estTokens * cap.priceNano) / 1_000_000n
    return est > 1_000n ? est : 1_000n
  }

  /**
   * Measure plausible token ceiling from actual UTF-8 bytes observed by the Switch router.
   * Defeats malicious sellers reporting `usage.totalTokens: 999999999` on tiny replies!
   */
  _computeVerifiedTokens({ body, result, streamedChars, rawReportedTokens }) {
    const promptBytes = Buffer.byteLength(JSON.stringify(body.messages || []), 'utf8')
    const completionContent =
      result?.choices
        ?.map((c) => String(c?.message?.content || ''))
        .join('') || ''
    // For SSE streams, extract rough content length (~1/4 of SSE JSON envelope chars)
    const completionBytes =
      streamedChars > 0
        ? Math.ceil(streamedChars / 3)
        : Buffer.byteLength(completionContent, 'utf8')

    // Generous router-verified ceiling: at most 1 token per 2 UTF-8 bytes + 32 framing tokens
    const routerCeiling = Math.max(Math.ceil((promptBytes + completionBytes) / 2) + 32, 8)
    const routerEstimate = Math.max(Math.ceil((promptBytes + completionBytes) / 4), 1)

    const reported = Number(rawReportedTokens || 0)
    if (!Number.isFinite(reported) || reported <= 0) {
      return routerEstimate
    }
    return Math.min(Math.round(reported), routerCeiling)
  }

  /**
   * Route an OpenAI-compatible Chat Completion (`POST /v1/chat/completions`).
   */
  async routeChat({ buyerId, reservationId, model, body, onSseChunk, signal }) {
    const capability = `llm:${model}`
    const candidates = this.rankCandidates(capability, {
      excludeAgents: new Set([buyerId]),
    })

    const startedAt = Date.now()
    let firstByteSent = false

    for (const { session, cap } of candidates) {
      if (Math.random() < this.canarySampleRate) {
        this.runCanaryProbe(session.sessionId, capability).catch(() => {})
      }

      try {
        const res = await this._dispatchWorkerJob(session, cap, body, {
          stream: Boolean(body.stream),
          signal,
          onChunk: (chunkStr) => {
            firstByteSent = true
            if (onSseChunk) onSseChunk(chunkStr)
          },
        })

        const latencyMs = Date.now() - startedAt
        const verifiedTokens = this._computeVerifiedTokens({
          body,
          result: res.result,
          streamedChars: res.streamedChars,
          rawReportedTokens:
            res.usage?.totalTokens ?? res.usage?.total_tokens ?? res.result?.usage?.total_tokens,
        })

        const rawGross = (BigInt(verifiedTokens) * cap.priceNano) / 1_000_000n
        const rsv = this.ledger.getReservation(reservationId)
        let grossNano = rawGross > 1_000n ? rawGross : 1_000n
        if (rsv && grossNano > rsv.amountNano) {
          grossNano = rsv.amountNano
        }

        const settlement = this.ledger.settleP2P({
          reservationId,
          buyerId,
          sellerId: session.agentId,
          capability,
          grossNano,
          units: verifiedTokens,
          latencyMs,
        })

        return {
          provider: session.agentId,
          mode: 'p2p',
          responseObj: res.result || null,
          settlement,
          latencyMs,
        }
      } catch (err) {
        session.emaSuccess = session.emaSuccess * 0.7
        if (firstByteSent || signal?.aborted) {
          this.ledger.releaseReservation(reservationId)
          throw err
        }
      }
    }

    if (!this.house.canFulfill(capability)) {
      this.ledger.releaseReservation(reservationId)
      throw new Error(`No online P2P seller or House fallback available for ${capability}`)
    }

    try {
      const houseRes = await this.house.executeChat(model, body, { onSseChunk, signal })
      const latencyMs = Date.now() - startedAt
      const settlement = this.ledger.settleHouse({
        reservationId,
        buyerId,
        capability,
        wholesaleNano: houseRes.wholesaleNano,
        units: houseRes.totalTokens,
        latencyMs,
      })
      return {
        provider: 'house_upstream',
        mode: 'house_fallback',
        responseObj: houseRes.responseObj,
        settlement,
        latencyMs,
      }
    } catch (err) {
      this.ledger.releaseReservation(reservationId)
      throw err
    }
  }

  /**
   * Route an atomic JSON capability (`POST /v1/act/:skill`).
   */
  async routeAct({ buyerId, reservationId, skill, input, maxPriceUsd = Infinity, signal }) {
    const capability = `act:${skill}`
    const candidates = this.rankCandidates(capability, {
      excludeAgents: new Set([buyerId]),
      maxPriceUsd,
    })

    const startedAt = Date.now()

    for (const { session, cap } of candidates) {
      if (Math.random() < this.canarySampleRate) {
        this.runCanaryProbe(session.sessionId, capability).catch(() => {})
      }

      try {
        const res = await this._dispatchWorkerJob(session, cap, input, { stream: false, signal })
        if (!this._validateOutputSchema(cap.outputSchema, res.result)) {
          session.emaSuccess *= 0.6
          throw new Error('Seller response failed outputSchema validation')
        }

        const latencyMs = Date.now() - startedAt
        const rsv = this.ledger.getReservation(reservationId)
        const grossNano = rsv && cap.priceNano > rsv.amountNano ? rsv.amountNano : cap.priceNano

        const settlement = this.ledger.settleP2P({
          reservationId,
          buyerId,
          sellerId: session.agentId,
          capability,
          grossNano,
          units: 1,
          latencyMs,
        })

        return {
          provider: session.agentId,
          mode: 'p2p',
          output: res.result,
          settlement,
          latencyMs,
        }
      } catch (err) {
        session.emaSuccess *= 0.7
        if (signal?.aborted) {
          this.ledger.releaseReservation(reservationId)
          throw err
        }
      }
    }

    if (!this.house.canFulfill(capability)) {
      this.ledger.releaseReservation(reservationId)
      throw new Error(`No online seller or House fallback for ${capability}`)
    }

    try {
      const houseRes = await this.house.executeSkill(skill, input)
      const latencyMs = Date.now() - startedAt
      const settlement = this.ledger.settleHouse({
        reservationId,
        buyerId,
        capability,
        wholesaleNano: houseRes.wholesaleNano,
        units: 1,
        latencyMs,
      })
      return {
        provider: 'house_upstream',
        mode: 'house_fallback',
        output: houseRes.output,
        settlement,
        latencyMs,
      }
    } catch (err) {
      this.ledger.releaseReservation(reservationId)
      throw err
    }
  }

  /**
   * Run a stealth randomized canary probe indistinguishable from real buyer traffic.
   */
  async runCanaryProbe(sessionId, capability) {
    const session = this.sessions.get(sessionId)
    if (!session || session.ws.readyState !== 1) return { skipped: true }
    const cap = session.capabilities.get(capability)
    if (!cap) return { skipped: true }

    if (cap.kind === 'chat') {
      // Randomize operands per probe so static lookup tables can't hardcode a single canary answer!
      const primes = [29, 31, 37, 41, 43, 47, 53, 59, 61, 67]
      const a = primes[randomBytes(1)[0] % primes.length]
      const b = primes[randomBytes(1)[0] % primes.length]
      const expected = String(a * b)
      const model = capability.slice(4)
      const payload = {
        model,
        temperature: 0,
        max_tokens: 16,
        stream: false,
        messages: [
          {
            role: 'user',
            content: `Compute ${a} * ${b}. Reply with ONLY the exact integer digits.`,
          },
        ],
      }

      try {
        const res = await this._dispatchWorkerJob(session, cap, payload, { stream: false })
        const text = String(res.result?.choices?.[0]?.message?.content || '')
        if (!text.includes(expected)) {
          return this._slashAndBan(
            session,
            `Canary math trap failed on ${capability}: expected ${expected}, got "${text.slice(0, 40)}"`
          )
        }
        return { passed: true, capability }
      } catch (err) {
        session.emaSuccess *= 0.8
        return { passed: false, timeout: true, error: err.message }
      }
    }

    if (capability === 'act:util.sha256') {
      const probe = 'switch402-canary-probe'
      const expectedSha = 'b18a72b285a080f12412c0932eb5f9e0a6ebfb8c1258e5e6fd0508ab79eb2440'
      const res = await this._dispatchWorkerJob(session, cap, { text: probe }, { stream: false })
      if (res.result?.sha256 !== expectedSha) {
        return this._slashAndBan(
          session,
          `Canary sha256 mismatch on ${capability}: got ${res.result?.sha256}`
        )
      }
      return { passed: true, capability }
    }

    if (cap.canaryVector?.input && cap.canaryVector?.expectedSubset) {
      const res = await this._dispatchWorkerJob(session, cap, cap.canaryVector.input, {
        stream: false,
      })
      for (const [k, v] of Object.entries(cap.canaryVector.expectedSubset)) {
        if (res.result?.[k] !== v) {
          return this._slashAndBan(session, `Canary vector mismatch on key "${k}"`)
        }
      }
      return { passed: true, capability }
    }

    return { skipped: true }
  }

  _slashAndBan(session, reason) {
    const slashResult = this.ledger.slashSellerBond({
      sellerId: session.agentId,
      reason,
    })
    session.ws.sendJson({
      type: 'SLASHED',
      reason,
      slashedUsd: nanoToUsd(slashResult.slashedNano),
    })
    session.ws.close(4003, 'Slashed for canary verification failure')
    this._evictSession(session.sessionId, reason)
    return {
      passed: false,
      slashed: true,
      sellerId: session.agentId,
      slashedNano: slashResult.slashedNano,
      reason,
    }
  }

  _dispatchWorkerJob(session, cap, payload, { stream = false, onChunk = null, signal = null }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Caller aborted request'))
        return
      }

      const jobId = `job_${randomBytes(8).toString('hex')}`
      const startedAt = Date.now()
      let gotFirstByte = false
      let streamedChars = 0
      let finished = false

      const onCallerAbort = () => {
        if (finished) return
        cleanup()
        session.ws.sendJson({ type: 'JOB_CANCEL', jobId, reason: 'caller_disconnected' })
        reject(new Error('Caller disconnected'))
      }

      const cleanup = () => {
        if (finished) return
        finished = true
        clearTimeout(ttftTimer)
        clearTimeout(hardTimer)
        if (signal) signal.removeEventListener('abort', onCallerAbort)
        session.pendingJobs.delete(jobId)
        session.inFlight = Math.max(session.inFlight - 1, 0)
      }

      if (signal) signal.addEventListener('abort', onCallerAbort, { once: true })

      const ttftTimer = setTimeout(() => {
        if (!gotFirstByte && !finished) {
          cleanup()
          session.ws.sendJson({ type: 'JOB_CANCEL', jobId, reason: 'ttft_timeout' })
          reject(
            new Error(`Worker ${session.agentId} exceeded TTFT timeout (${this.ttftTimeoutMs}ms)`)
          )
        }
      }, this.ttftTimeoutMs)
      ttftTimer.unref()

      const hardTimer = setTimeout(() => {
        if (!finished) {
          cleanup()
          session.ws.sendJson({ type: 'JOB_CANCEL', jobId, reason: 'hard_timeout' })
          reject(new Error(`Worker ${session.agentId} exceeded hard job timeout`))
        }
      }, this.jobHardTimeoutMs)
      hardTimer.unref()

      session.inFlight += 1
      session.pendingJobs.set(jobId, {
        onChunk: (dataStr) => {
          gotFirstByte = true
          clearTimeout(ttftTimer)
          streamedChars += dataStr.length
          if (onChunk) onChunk(dataStr)
        },
        complete: (result, usage) => {
          gotFirstByte = true
          const rtt = Date.now() - startedAt
          session.emaLatencyMs = Math.round(session.emaLatencyMs * 0.8 + rtt * 0.2)
          session.emaSuccess = Math.min(session.emaSuccess * 0.9 + 0.1, 0.999)
          cleanup()
          resolve({ result, usage, streamedChars })
        },
        fail: (err) => {
          cleanup()
          reject(err)
        },
      })

      const sent = session.ws.sendJson({
        type: 'JOB_START',
        jobId,
        capability: cap.capability,
        stream,
        payload,
      })
      if (!sent) {
        cleanup()
        reject(new Error('Failed to write JOB_START to worker socket'))
      }
    })
  }

  _handleWorkerMessage(sessionId, msg) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const job = msg.jobId ? session.pendingJobs.get(msg.jobId) : null
    if (!job) return

    switch (msg.type) {
      case 'JOB_CHUNK':
        job.onChunk(String(msg.data || ''))
        break
      case 'JOB_DONE':
        job.complete(null, msg.usage || null)
        break
      case 'JOB_RESULT':
        job.complete(msg.result, msg.usage || null)
        break
      case 'JOB_ERROR':
        job.fail(new Error(String(msg.error || 'Worker reported JOB_ERROR')))
        break
    }
  }

  _validateOutputSchema(schema, value) {
    if (!schema || typeof schema !== 'object') return true
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      if (Array.isArray(schema.required)) {
        for (const reqKey of schema.required) {
          if (value[reqKey] === undefined) return false
        }
      }
    }
    return true
  }

  _heartbeat() {
    const now = Date.now()
    for (const s of Array.from(this.sessions.values())) {
      if (now - (s.lastPongAt || s.connectedAt) > 50_000) {
        s.ws.close(1001, 'Heartbeat pong timeout')
        this._evictSession(s.sessionId, 'Worker heartbeat pong timeout')
        continue
      }
      if (s.ws.readyState === 1) s.ws.ping()
    }
  }

  getMarketSnapshot() {
    const p2pMap = new Map()
    for (const [capName, sessionIds] of this.capIndex.entries()) {
      let minPrice = Infinity
      let bestLatency = Infinity
      let sellersOnline = 0
      let description = ''
      const kind = capName.startsWith('llm:') ? 'chat' : 'act'

      for (const sid of sessionIds) {
        const s = this.sessions.get(sid)
        if (!s || s.ws.readyState !== 1) continue
        const acct = this.ledger.getAgent(s.agentId)
        if (!acct || acct.banned) continue
        const c = s.capabilities.get(capName)
        if (!c) continue
        sellersOnline += 1
        if (c.priceUsd < minPrice) minPrice = c.priceUsd
        if (s.emaLatencyMs < bestLatency) bestLatency = s.emaLatencyMs
        if (!description && c.description) description = c.description
      }

      if (sellersOnline > 0) {
        p2pMap.set(capName, {
          capability: capName,
          kind,
          sellersOnline,
          floorPriceUsd: minPrice,
          priceUnit: kind === 'chat' ? 'per_1m_tokens' : 'per_call',
          bestEmaLatencyMs: bestLatency,
          description,
          source: 'p2p_live',
        })
      }
    }

    const houseList = this.house.listAvailableCapabilities()
    const unmetDemand = []
    for (const [capName, stats] of this.house.unmetDemandTracker.entries()) {
      if (!p2pMap.has(capName)) {
        const houseItem = houseList.find((h) => h.capability === capName)
        unmetDemand.push({
          capability: capName,
          houseCallsServed: stats.calls,
          lastCallAt: stats.lastCallAt,
          suggestedUndercutUsd: houseItem
            ? Number(
                (Number(houseItem.houseBuyerPer1MUsd || houseItem.houseBuyerUsd) * 0.85).toFixed(6)
              )
            : 0.0008,
        })
      }
    }
    unmetDemand.sort((a, b) => b.houseCallsServed - a.houseCallsServed)

    return {
      onlineWorkers: this.sessions.size,
      p2pBook: Array.from(p2pMap.values()),
      houseFallbackBook: houseList,
      unmetDemandFeed: unmetDemand,
    }
  }
}
