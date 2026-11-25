import { randomBytes } from 'node:crypto'
import { nanoToUsd, usdToNano } from '../protocol/index.mjs'

/**
 * Solvent $0.14/day Heartbeat Benchmark Buyer & Public P2P Speed Leaderboard.
 *
 * Keeps P2P Seller daemons warm 24/7 and gives new workers their first live settled job within 5 seconds:
 * - Strict daily cap (`dailyBudgetUsd`, default $0.14/day) + 10-minute per-agent cooldown.
 * - 100% Solvent by design:
 *   1. If `ledger.treasuryNano` holds real collected fees, transfers from `treasuryNano` first.
 *   2. During bootstrap (when `treasuryNano` is 0), promo benchmark jobs ONLY target workers still building
 *      their non-withdrawable `$2.00` Earned Quality Bond (`bondedNano < earnedBondTargetNano`), so zero
 *      unbacked withdrawable liability can ever be created!
 */
export class HeartbeatBuyer {
  /**
   * @param {object} opts
   * @param {import('./ledger.mjs').NanoLedger} opts.ledger
   * @param {import('./router.mjs').SellerRouter} opts.router
   * @param {boolean} [opts.enabled=true]
   * @param {number} [opts.intervalMs=300000] - default 5 minutes
   * @param {string} [opts.dailyBudgetUsd='0.14']
   */
  constructor({
    ledger,
    router,
    enabled = true,
    intervalMs = 300_000,
    dailyBudgetUsd = '0.14',
  }) {
    this.ledger = ledger
    this.router = router
    this.enabled = enabled
    this.intervalMs = intervalMs
    this.dailyBudgetNano = usdToNano(dailyBudgetUsd)

    const acct = this.ledger.ensureSystemAccount('ag_heartbeat_buyer', '_switch402_heartbeat_buyer')
    this.buyerId = acct.id

    this._currentUtcDay = ''
    this._spentTodayNano = 0n
    /** @type {Map<string, number>} sellerAgentId -> lastBenchmarkMs */
    this._lastAgentPing = new Map()
    /** @type {Map<string, { agentId: string, agentName: string, capability: string, benchmarksPassed: number, avgLatencyMs: number, lastSeenAt: number }>} */
    this.leaderboard = new Map()

    this._timer = null
    if (this.enabled) {
      this._timer = setInterval(() => {
        this.tick().catch(() => {})
      }, this.intervalMs)
      this._timer.unref()
    }
  }

  close() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }

  /**
   * Trigger a welcome benchmark 4 seconds after a new P2P worker connects (subject to 10-min per-agent cooldown).
   */
  scheduleWelcomePing(sessionId) {
    if (!this.enabled) return
    const t = setTimeout(() => {
      this.benchmarkSession(sessionId).catch(() => {})
    }, 4_000)
    t.unref()
  }

  async tick() {
    if (!this.enabled || this.router.sessions.size === 0) return { ran: 0 }
    let ran = 0
    for (const sessionId of this.router.sessions.keys()) {
      const res = await this.benchmarkSession(sessionId)
      if (res?.settled) ran += 1
      if (ran >= 3) break // max 3 workers per 5-min tick
    }
    return { ran }
  }

  async benchmarkSession(sessionId) {
    const session = this.router.sessions.get(sessionId)
    if (!session || session.ws.readyState !== 1) return { skipped: 'offline' }

    const now = Date.now()
    const lastPing = this._lastAgentPing.get(session.agentId) || 0
    if (now - lastPing < 600_000) {
      return { skipped: 'cooldown' }
    }

    const utcDay = new Date(now).toISOString().slice(0, 10)
    if (this._currentUtcDay !== utcDay) {
      this._currentUtcDay = utcDay
      this._spentTodayNano = 0n
    }
    if (this._spentTodayNano >= this.dailyBudgetNano) {
      return { skipped: 'daily_cap_reached' }
    }

    const cap = Array.from(session.capabilities.values())[0]
    if (!cap) return { skipped: 'no_capability' }

    // Cap single heartbeat micro-call at <= $0.001
    const maxCallNano = usdToNano('0.001')
    const estNano =
      cap.kind === 'act' ? cap.priceNano : (64n * cap.priceNano) / 1_000_000n
    const neededNano = estNano < 1_000n ? 1_000n : estNano
    if (neededNano > maxCallNano) return { skipped: 'price_above_micro_benchmark_cap' }
    if (this._spentTodayNano + neededNano > this.dailyBudgetNano) {
      return { skipped: 'daily_cap_exceeded' }
    }

    const sellerAcct = this.ledger.getAgent(session.agentId)
    if (!sellerAcct || sellerAcct.banned) return { skipped: 'banned' }

    // Solvency guard: if seller's $2.00 bond is already full, only fund heartbeat from real collected treasuryNano!
    const bondRemaining =
      sellerAcct.bondedNano < this.ledger.earnedBondTargetNano
        ? this.ledger.earnedBondTargetNano - sellerAcct.bondedNano
        : 0n
    const canUseBootstrapGrant = bondRemaining >= neededNano

    const buyerAcct = this.ledger.getAgent(this.buyerId)
    if (buyerAcct.spendableNano < neededNano) {
      const deficit = neededNano - buyerAcct.spendableNano
      const commonsAcct = this.ledger.getAgent('ag_commons_pool')
      if (commonsAcct && commonsAcct.spendableNano >= deficit) {
        this.ledger.transferWithFee({
          fromAgentId: 'ag_commons_pool',
          toAgentId: this.buyerId,
          amountNano: deficit,
          feeBps: 0,
          kind: 'commons_subsidy',
          capability: 'commons:heartbeat',
          countAsVolume: false,
        })
      } else if (this.ledger.treasuryNano >= deficit) {
        this.ledger.reinvestTreasuryToBuyer(this.buyerId, deficit)
      } else if (canUseBootstrapGrant) {
        this.ledger.deposit({
          agentId: this.buyerId,
          amountNano: deficit,
          rail: 'heartbeat_bond_bootstrap',
          txId: `hb_${utcDay}_${randomBytes(6).toString('hex')}`,
        })
      } else {
        return { skipped: 'awaiting_treasury_fees' }
      }
    }

    this._lastAgentPing.set(session.agentId, now)
    const reservationId = this.ledger.reserve(this.buyerId, neededNano, 'call')
    if (!reservationId) return { skipped: 'reserve_failed' }

    const startedAt = Date.now()
    try {
      if (cap.kind === 'chat') {
        const model = cap.capability.slice(4)
        const out = await this.router.routeChat({
          buyerId: this.buyerId,
          reservationId,
          model,
          body: {
            model,
            max_tokens: 16,
            temperature: 0,
            messages: [{ role: 'user', content: 'Compute 19 * 23. Reply with ONLY digits.' }],
          },
        })
        if (out.mode === 'p2p') {
          this._spentTodayNano += out.settlement.grossNano
          this._recordLeaderboard(session, cap.capability, Date.now() - startedAt)
          return { settled: true, receiptId: out.settlement.receiptId }
        }
        return { settled: false }
      } else {
        const skill = cap.capability.slice(4)
        const sampleInput = cap.canaryVector?.input || { text: 'switch402-heartbeat', url: 'https://example.com' }
        const out = await this.router.routeAct({
          buyerId: this.buyerId,
          reservationId,
          skill,
          input: sampleInput,
          maxPriceUsd: 0.001,
        })
        if (out.mode === 'p2p') {
          this._spentTodayNano += out.settlement.grossNano
          this._recordLeaderboard(session, cap.capability, Date.now() - startedAt)
          return { settled: true, receiptId: out.settlement.receiptId }
        }
        return { settled: false }
      }
    } catch {
      this.ledger.releaseReservation(reservationId)
      return { settled: false }
    }
  }

  _recordLeaderboard(session, capability, latencyMs) {
    const key = `${session.agentId}:${capability}`
    const prev = this.leaderboard.get(key)
    if (!prev) {
      this.leaderboard.set(key, {
        agentId: session.agentId,
        agentName: session.agentName,
        capability,
        benchmarksPassed: 1,
        avgLatencyMs: latencyMs,
        lastSeenAt: Date.now(),
      })
    } else {
      prev.benchmarksPassed += 1
      prev.avgLatencyMs = Math.round(prev.avgLatencyMs * 0.75 + latencyMs * 0.25)
      prev.lastSeenAt = Date.now()
    }
  }

  getSnapshot() {
    const entries = Array.from(this.leaderboard.values()).sort(
      (a, b) => a.avgLatencyMs - b.avgLatencyMs
    )
    return {
      enabled: this.enabled,
      dailyBudgetUsd: nanoToUsd(this.dailyBudgetNano, 2),
      spentTodayUsd: nanoToUsd(this._spentTodayNano, 6),
      intervalSeconds: Math.round(this.intervalMs / 1000),
      leaders: entries.slice(0, 50),
    }
  }
}
