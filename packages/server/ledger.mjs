import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  computeHouseSplit,
  computeP2PSplit,
  generateApiKey,
  hashApiKey,
  jwkThumbprint,
  nanoToUsd,
  usdToNano,
} from '../protocol/index.mjs'

/**
 * Hardened in-RAM BigInt Double-Entry Nano-USD Ledger with crash-safe WAL persistence.
 *
 * Conservation Law (always holds):
 *   totalDepositedNano ===
 *     sum_agents(spendableNano + bondedNano + reservedNano)
 *     + treasuryNano
 *     + wholesalePayableNano
 *     + totalWithdrawnNano
 */
export class NanoLedger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dataDir]
   * @param {number} [opts.platformFeeBps=500]
   * @param {number} [opts.referrerShareBps=1500]
   * @param {number} [opts.houseMarginBps=1000]
   * @param {bigint} [opts.earnedBondTargetNano]
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || null
    this.platformFeeBps = opts.platformFeeBps ?? 500
    this.referrerShareBps = opts.referrerShareBps ?? 1500
    this.houseMarginBps = opts.houseMarginBps ?? 1000
    this.earnedBondTargetNano = opts.earnedBondTargetNano ?? usdToNano('2.00')
    this.defaultSandboxCalls = opts.defaultSandboxCalls ?? 10
    this.walCompactThreshold = opts.walCompactThreshold ?? 5000
    this._walEventsSinceCompact = 0

    /** @type {Map<string, any>} agentId -> Account */
    this.accounts = new Map()
    /** @type {Map<string, string>} apiKeyHash -> agentId */
    this.apiKeyIndex = new Map()
    /** @type {Map<string, string>} keyThumbprint -> agentId */
    this.pubkeyIndex = new Map()
    /** @type {Map<string, { agentId: string, amountNano: bigint, kind: string, createdAt: number }>} */
    this.reservations = new Map()
    /** @type {Set<string>} idempotency keys for external deposits/txs */
    this.processedTxIds = new Set()

    this.treasuryNano = 0n
    this.wholesalePayableNano = 0n
    this.totalDepositedNano = 0n
    this.totalWithdrawnNano = 0n
    this.totalVolumeNano = 0n
    this.totalSettledCalls = 0

    /** @type {Array<any>} recent receipts ring buffer (last 200 in RAM) */
    this.recentReceipts = []
    /** @type {Map<string, Array<{ ts: number, amountNano: bigint }>>} agentId -> withdrawals */
    this.withdrawHistory = new Map()

    this._walFd = null
    if (this.dataDir) {
      fs.mkdirSync(this.dataDir, { recursive: true })
      this._loadFromDisk()
      this._walFd = fs.openSync(path.join(this.dataDir, 'ledger.wal.jsonl'), 'a')
    }

    this._reapTimer = setInterval(() => this.reapStaleReservations(300_000), 60_000)
    this._reapTimer.unref()
  }

  close() {
    clearInterval(this._reapTimer)
    if (this._walFd !== null) {
      try {
        fs.fsyncSync(this._walFd)
        fs.closeSync(this._walFd)
      } catch {
        // ignore already closed
      }
      this._walFd = null
    }
  }

  /**
   * Ensure a deterministic internal system account exists without duplicating on restarts.
   */
  ensureSystemAccount(fixedAgentId, name) {
    const existing = this.accounts.get(fixedAgentId)
    if (existing) return existing
    const event = {
      type: 'REGISTER',
      ts: Date.now(),
      agentId: fixedAgentId,
      name,
      publicJwk: null,
      thumbprint: null,
      apiKeyHash: null,
      referredBy: null,
      evmAddress: null,
      lightningAddress: null,
    }
    this._applyEvent(event)
    this._appendWal(event)
    return this.accounts.get(fixedAgentId)
  }

  /**
   * Keyless self-registration for buyers, sellers, and referrers.
   */
  registerAgent({
    name = '',
    publicJwk = null,
    referredBy = null,
    evmAddress = null,
    lightningAddress = null,
  } = {}) {
    let thumbprint = null
    if (publicJwk) {
      thumbprint = jwkThumbprint(publicJwk)
      const existingId = this.pubkeyIndex.get(thumbprint)
      if (existingId) {
        throw new Error(`Public key already registered to agent ${existingId}`)
      }
    }

    const agentId = `ag_${randomBytes(6).toString('hex')}`
    const apiKey = generateApiKey('ag_live_')
    const apiKeyHash = hashApiKey(apiKey)

    const refAcct = referredBy && referredBy !== agentId ? this.accounts.get(referredBy) : null
    const validReferrer = refAcct && !refAcct.banned ? referredBy : null

    const event = {
      type: 'REGISTER',
      ts: Date.now(),
      agentId,
      name: String(name || '').slice(0, 64),
      publicJwk,
      thumbprint,
      apiKeyHash,
      referredBy: validReferrer,
      evmAddress: evmAddress ? String(evmAddress).slice(0, 64) : null,
      lightningAddress: lightningAddress ? String(lightningAddress).slice(0, 120) : null,
      sandboxCallsRemaining: this.defaultSandboxCalls,
    }

    this._applyEvent(event)
    this._appendWal(event)

    return {
      agentId,
      apiKey,
      keyThumbprint: thumbprint,
      referredBy: validReferrer,
      referralUrlParam: `?ref=${agentId}`,
      sandboxCallsRemaining: this.defaultSandboxCalls,
    }
  }

  /**
   * Consume 1 free sandbox call on `switch402/instant-test` (zero financial liability, preserves conservation law).
   */
  consumeSandboxCall(agentId, capability = 'llm:switch402/instant-test', latencyMs = 0) {
    const acct = this.accounts.get(agentId)
    if (!acct || acct.banned || (acct.sandboxCallsRemaining || 0) <= 0) return null
    const receiptId = `rcpt_sbx_${randomBytes(5).toString('hex')}`
    const event = {
      type: 'SANDBOX_USE',
      ts: Date.now(),
      receiptId,
      agentId,
      capability,
      latencyMs,
    }
    this._applyEvent(event)
    this._appendWal(event)
    return {
      receiptId,
      mode: 'sandbox_free',
      grossNano: 0n,
      remainingSandboxCalls: acct.sandboxCallsRemaining,
    }
  }

  getAgentByApiKey(apiKey) {
    if (!apiKey) return null
    const id = this.apiKeyIndex.get(hashApiKey(apiKey))
    return id ? this.accounts.get(id) || null : null
  }

  getAgent(agentId) {
    return this.accounts.get(agentId) || null
  }

  /**
   * Credit verified external deposit (x402 USDC, Lightning invoice, or admin seed).
   * Idempotent by txId.
   */
  deposit({ agentId, amountNano, rail = 'x402_base_usdc', txId }) {
    const amt = BigInt(amountNano)
    if (amt <= 0n) throw new Error('Deposit amount must be positive')
    if (!txId) throw new Error('Deposit requires unique txId')
    if (this.processedTxIds.has(txId)) {
      return { duplicate: true, account: this.serializeAccount(agentId) }
    }
    const acct = this.accounts.get(agentId)
    if (!acct) throw new Error(`Unknown agent: ${agentId}`)

    const event = {
      type: 'DEPOSIT',
      ts: Date.now(),
      agentId,
      amountNano: amt.toString(),
      rail,
      txId,
    }
    this._applyEvent(event)
    this._appendWal(event)
    return { duplicate: false, account: this.serializeAccount(agentId) }
  }

  /**
   * Reserve spendable balance in RAM before streaming an execution call or withdrawal.
   */
  reserve(agentId, maxCostNano, kind = 'call') {
    const amt = BigInt(maxCostNano)
    if (amt < 0n) throw new Error('Negative reservation')
    const acct = this.accounts.get(agentId)
    if (!acct) throw new Error(`Unknown agent: ${agentId}`)
    if (acct.spendableNano < amt) {
      return null
    }
    acct.spendableNano -= amt
    acct.reservedNano += amt
    const reservationId = `rsv_${randomBytes(8).toString('hex')}`
    this.reservations.set(reservationId, {
      agentId,
      amountNano: amt,
      kind,
      createdAt: Date.now(),
    })
    return reservationId
  }

  getReservation(reservationId) {
    return reservationId ? this.reservations.get(reservationId) || null : null
  }

  /**
   * Release unused reservation cleanly (e.g. upstream error or failed payout -> 100% refunded to spendableNano).
   */
  releaseReservation(reservationId) {
    const rsv = this.reservations.get(reservationId)
    if (!rsv) return false
    const acct = this.accounts.get(rsv.agentId)
    if (acct) {
      acct.reservedNano -= rsv.amountNano
      acct.spendableNano += rsv.amountNano
    }
    this.reservations.delete(reservationId)
    return true
  }

  /**
   * Reap orphaned call reservations older than `maxAgeMs` (never reaps in-flight `withdraw` locks automatically).
   */
  reapStaleReservations(maxAgeMs = 300_000) {
    const cutoff = Date.now() - maxAgeMs
    let reaped = 0
    for (const [id, rsv] of this.reservations.entries()) {
      if (rsv.kind === 'call' && rsv.createdAt < cutoff) {
        this.releaseReservation(id)
        reaped += 1
      }
    }
    return reaped
  }

  /**
   * Sweep leftover fractional nano-USD from the keyless x402 omnibus account into Treasury
   * so concurrent keyless callers can never snipe each other's residual dust.
   */
  sweepAccountSpendableToTreasury(agentId, maxSweepNano = null) {
    const acct = this.accounts.get(agentId)
    if (!acct || acct.spendableNano <= 0n) return 0n
    const amt =
      maxSweepNano !== null && BigInt(maxSweepNano) < acct.spendableNano
        ? BigInt(maxSweepNano)
        : acct.spendableNano
    if (amt <= 0n) return 0n

    const event = {
      type: 'SWEEP_DUST',
      ts: Date.now(),
      agentId,
      amountNano: amt.toString(),
    }
    this._applyEvent(event)
    this._appendWal(event)
    return amt
  }

  /**
   * Reinvest collected Platform Treasury fees into the internal Heartbeat Benchmark Buyer
   * (zero change in total platform assets -> preserves double-entry conservation!).
   */
  reinvestTreasuryToBuyer(buyerAgentId, amountNano) {
    const amt = BigInt(amountNano)
    if (amt <= 0n || this.treasuryNano < amt) return 0n
    const acct = this.accounts.get(buyerAgentId)
    if (!acct) return 0n

    const event = {
      type: 'REINVEST_TREASURY',
      ts: Date.now(),
      agentId: buyerAgentId,
      amountNano: amt.toString(),
    }
    this._applyEvent(event)
    this._appendWal(event)
    return amt
  }

  /**
   * Atomically settle a P2P execution call from a reservation (strictly capped to reservation ceiling).
   */
  settleP2P({
    reservationId = null,
    buyerId,
    sellerId,
    capability,
    grossNano,
    units = 1,
    latencyMs = 0,
  }) {
    const buyer = this.accounts.get(buyerId)
    const seller = this.accounts.get(sellerId)
    if (!buyer) throw new Error(`Unknown buyer: ${buyerId}`)
    if (!seller) throw new Error(`Unknown seller: ${sellerId}`)
    if (buyerId === sellerId) throw new Error('Self-dealing prohibited')

    const gross = this._consumeBuyerFunds(buyer, BigInt(grossNano), reservationId)

    // Third-party referrer only (blocks 2-wallet buyer<->seller wash-rebate loops)
    const candidateRef = buyer.referredBy || seller.referredBy || null
    const referrerId =
      candidateRef &&
      candidateRef !== buyerId &&
      candidateRef !== sellerId &&
      this.accounts.has(candidateRef) &&
      !this.accounts.get(candidateRef).banned
        ? candidateRef
        : null

    const split = computeP2PSplit(gross, {
      platformFeeBps: this.platformFeeBps,
      referrerShareBps: this.referrerShareBps,
      hasReferrer: Boolean(referrerId),
    })

    const bondDeficit =
      seller.bondedNano < this.earnedBondTargetNano
        ? this.earnedBondTargetNano - seller.bondedNano
        : 0n
    const toBondNano = split.sellerNano <= bondDeficit ? split.sellerNano : bondDeficit
    const toSpendableNano = split.sellerNano - toBondNano

    const receiptId = `rcpt_${randomBytes(6).toString('hex')}`
    const event = {
      type: 'SETTLE_P2P',
      ts: Date.now(),
      receiptId,
      buyerId,
      sellerId,
      referrerId,
      capability,
      units,
      latencyMs,
      grossNano: split.grossNano.toString(),
      sellerToBondNano: toBondNano.toString(),
      sellerToSpendableNano: toSpendableNano.toString(),
      platformNano: split.platformNano.toString(),
      referrerNano: split.referrerNano.toString(),
    }

    this._applyEvent(event)
    this._appendWal(event)
    return {
      receiptId,
      mode: 'p2p',
      grossNano: split.grossNano,
      sellerNano: split.sellerNano,
      platformNano: split.platformNano,
      referrerNano: split.referrerNano,
    }
  }

  /**
   * Atomically settle a House Fallback Upstream call (+10% margin over wholesale).
   */
  settleHouse({
    reservationId = null,
    buyerId,
    capability,
    wholesaleNano,
    units = 1,
    latencyMs = 0,
  }) {
    const buyer = this.accounts.get(buyerId)
    if (!buyer) throw new Error(`Unknown buyer: ${buyerId}`)

    const referrerId =
      buyer.referredBy &&
      buyer.referredBy !== buyerId &&
      this.accounts.has(buyer.referredBy) &&
      !this.accounts.get(buyer.referredBy).banned
        ? buyer.referredBy
        : null

    let wholesale = BigInt(wholesaleNano)
    const rsv = reservationId ? this.reservations.get(reservationId) : null
    if (rsv) {
      // Ensure buyerTotal never exceeds reserved ceiling even on huge completion bursts
      const maxWholesale = (rsv.amountNano * 10000n) / BigInt(10000 + this.houseMarginBps)
      if (wholesale > maxWholesale) wholesale = maxWholesale
    }

    const split = computeHouseSplit(wholesale, {
      marginBps: this.houseMarginBps,
      referrerShareBps: this.referrerShareBps,
      hasReferrer: Boolean(referrerId),
    })

    this._consumeBuyerFunds(buyer, split.buyerTotalNano, reservationId)

    const receiptId = `rcpt_${randomBytes(6).toString('hex')}`
    const event = {
      type: 'SETTLE_HOUSE',
      ts: Date.now(),
      receiptId,
      buyerId,
      referrerId,
      capability,
      units,
      latencyMs,
      buyerTotalNano: split.buyerTotalNano.toString(),
      wholesaleNano: split.wholesaleNano.toString(),
      platformNetMarginNano: split.platformNetMarginNano.toString(),
      referrerNano: split.referrerNano.toString(),
    }

    this._applyEvent(event)
    this._appendWal(event)
    return {
      receiptId,
      mode: 'house_fallback',
      grossNano: split.buyerTotalNano,
      wholesaleNano: split.wholesaleNano,
      platformNano: split.platformNetMarginNano,
      referrerNano: split.referrerNano,
    }
  }

  /**
   * Slash a fraudulent/spoofing seller's Earned Quality Bond into Platform Treasury & persist ban.
   */
  slashSellerBond({ sellerId, reason = 'canary_failed', amountNano = null }) {
    const seller = this.accounts.get(sellerId)
    if (!seller) throw new Error(`Unknown seller: ${sellerId}`)
    const maxSlash = seller.bondedNano
    const slashAmt =
      amountNano !== null && BigInt(amountNano) < maxSlash ? BigInt(amountNano) : maxSlash

    const event = {
      type: 'SLASH_BOND',
      ts: Date.now(),
      sellerId,
      slashedNano: slashAmt.toString(),
      banned: true,
      reason: String(reason).slice(0, 160),
    }
    this._applyEvent(event)
    this._appendWal(event)
    return { sellerId, slashedNano: slashAmt, remainingBondNano: seller.bondedNano }
  }

  /**
   * Phase 1 of Two-Phase Atomic Withdrawal: validate guardrails and lock funds in `reservedNano`.
   */
  beginWithdrawal({
    agentId,
    amountNano,
    maxHourlyWithdrawNano = usdToNano('100.00'),
    requireFullBondIfSeller = true,
  }) {
    const amt = BigInt(amountNano)
    if (amt <= 0n) throw new Error('Withdrawal amount must be positive')
    const acct = this.accounts.get(agentId)
    if (!acct) throw new Error(`Unknown agent: ${agentId}`)
    if (acct.banned) {
      throw new Error('Account is suspended due to failed canary verification / slashing')
    }

    if (
      requireFullBondIfSeller &&
      acct.stats.callsServed > 0 &&
      acct.bondedNano < this.earnedBondTargetNano
    ) {
      throw new Error(
        `Seller Quality Bond incomplete (${nanoToUsd(acct.bondedNano, 2)} / ${nanoToUsd(this.earnedBondTargetNano, 2)} USD). Earn remaining bond before withdrawing, or spend balance directly on Switch402 calls.`
      )
    }

    if (acct.spendableNano < amt) {
      throw new Error(
        `Insufficient withdrawable balance: have ${nanoToUsd(acct.spendableNano)}, requested ${nanoToUsd(amt)}`
      )
    }

    // Check rolling 1-hour velocity cap (completed + in-flight withdraw reservations)
    const oneHourAgo = Date.now() - 3600_000
    const hist = (this.withdrawHistory.get(agentId) || []).filter((w) => w.ts >= oneHourAgo)
    this.withdrawHistory.set(agentId, hist)
    let rollingSum = hist.reduce((acc, w) => acc + w.amountNano, 0n)
    for (const rsv of this.reservations.values()) {
      if (rsv.agentId === agentId && rsv.kind === 'withdraw') {
        rollingSum += rsv.amountNano
      }
    }
    if (rollingSum + amt > BigInt(maxHourlyWithdrawNano)) {
      throw new Error('Hourly withdrawal velocity limit exceeded')
    }

    const reservationId = this.reserve(agentId, amt, 'withdraw')
    if (!reservationId) throw new Error('Failed to reserve withdrawal funds')
    return reservationId
  }

  /**
   * Phase 2 of Two-Phase Atomic Withdrawal: commit locked withdrawal after external payout succeeds.
   */
  commitWithdrawal({ reservationId, rail = 'lightning', destination, externalTxId = null }) {
    const rsv = this.reservations.get(reservationId)
    if (!rsv || rsv.kind !== 'withdraw') {
      throw new Error('Invalid withdrawal reservation')
    }
    const acct = this.accounts.get(rsv.agentId)
    this.reservations.delete(reservationId)
    acct.reservedNano -= rsv.amountNano

    const withdrawalId = `wd_${randomBytes(6).toString('hex')}`
    const event = {
      type: 'WITHDRAW',
      ts: Date.now(),
      withdrawalId,
      agentId: rsv.agentId,
      amountNano: rsv.amountNano.toString(),
      rail,
      destination: String(destination || '').slice(0, 200),
      externalTxId,
    }
    this._applyEvent(event)
    this._appendWal(event)

    return {
      withdrawalId,
      amountNano: rsv.amountNano.toString(),
      amountUsd: nanoToUsd(rsv.amountNano),
      rail,
      destination,
      externalTxId,
      remainingSpendableUsd: nanoToUsd(acct.spendableNano),
    }
  }

  /**
   * Convenience single-step local withdrawal (uses begin + commit atomically).
   */
  withdraw(opts) {
    const reservationId = this.beginWithdrawal(opts)
    return this.commitWithdrawal({
      reservationId,
      rail: opts.rail,
      destination: opts.destination,
    })
  }

  /**
   * Verify mathematical double-entry conservation of value across the entire ledger.
   */
  verifyInvariant() {
    let agentTotal = 0n
    for (const acct of this.accounts.values()) {
      agentTotal += acct.spendableNano + acct.bondedNano + acct.reservedNano
    }
    const rightSide =
      agentTotal + this.treasuryNano + this.wholesalePayableNano + this.totalWithdrawnNano
    const balanced = this.totalDepositedNano === rightSide
    return {
      balanced,
      totalDepositedNano: this.totalDepositedNano,
      accountedTotalNano: rightSide,
      driftNano: this.totalDepositedNano - rightSide,
      treasuryNano: this.treasuryNano,
      wholesalePayableNano: this.wholesalePayableNano,
      totalWithdrawnNano: this.totalWithdrawnNano,
      agentTotalNano: agentTotal,
    }
  }

  /**
   * Compact WAL into an atomic JSON snapshot on disk.
   */
  compactSnapshot() {
    if (!this.dataDir) return
    const snapPath = path.join(this.dataDir, 'ledger.snapshot.json')
    const tmpPath = `${snapPath}.tmp`
    const walPath = path.join(this.dataDir, 'ledger.wal.jsonl')

    const snapshot = {
      version: 1,
      ts: Date.now(),
      treasuryNano: this.treasuryNano.toString(),
      wholesalePayableNano: this.wholesalePayableNano.toString(),
      totalDepositedNano: this.totalDepositedNano.toString(),
      totalWithdrawnNano: this.totalWithdrawnNano.toString(),
      totalVolumeNano: this.totalVolumeNano.toString(),
      totalSettledCalls: this.totalSettledCalls,
      processedTxIds: Array.from(this.processedTxIds),
      accounts: Array.from(this.accounts.values()).map((a) => ({
        ...a,
        spendableNano: (a.spendableNano + a.reservedNano).toString(),
        bondedNano: a.bondedNano.toString(),
        reservedNano: '0',
        stats: {
          ...a.stats,
          earnedNano: a.stats.earnedNano.toString(),
          spentNano: a.stats.spentNano.toString(),
          referralEarnedNano: a.stats.referralEarnedNano.toString(),
        },
      })),
    }

    fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8')
    fs.renameSync(tmpPath, snapPath)

    if (this._walFd !== null) {
      fs.closeSync(this._walFd)
    }
    fs.writeFileSync(walPath, '', 'utf8')
    this._walFd = fs.openSync(walPath, 'a')
  }

  serializeAccount(agentId) {
    const a = this.accounts.get(agentId)
    if (!a) return null
    return {
      id: a.id,
      name: a.name,
      banned: Boolean(a.banned),
      referredBy: a.referredBy,
      evmAddress: a.evmAddress,
      lightningAddress: a.lightningAddress,
      spendableNano: a.spendableNano.toString(),
      spendableUsd: nanoToUsd(a.spendableNano),
      bondedNano: a.bondedNano.toString(),
      bondedUsd: nanoToUsd(a.bondedNano),
      bondTargetUsd: nanoToUsd(this.earnedBondTargetNano),
      bondComplete: a.bondedNano >= this.earnedBondTargetNano,
      reservedNano: a.reservedNano.toString(),
      sandboxCallsRemaining: a.sandboxCallsRemaining ?? 0,
      stats: {
        callsServed: a.stats.callsServed,
        callsBought: a.stats.callsBought,
        slashedCount: a.stats.slashedCount,
        earnedUsd: nanoToUsd(a.stats.earnedNano),
        spentUsd: nanoToUsd(a.stats.spentNano),
        referralEarnedUsd: nanoToUsd(a.stats.referralEarnedNano),
      },
    }
  }

  summary() {
    let realAgents = 0
    for (const a of this.accounts.values()) {
      if (a.apiKeyHash) realAgents += 1
    }
    return {
      agentsRegistered: realAgents,
      totalSettledCalls: this.totalSettledCalls,
      totalVolumeUsd: nanoToUsd(this.totalVolumeNano, 4),
      treasuryNetRevenueUsd: nanoToUsd(this.treasuryNano, 6),
      wholesalePayableUsd: nanoToUsd(this.wholesalePayableNano, 6),
      totalDepositedUsd: nanoToUsd(this.totalDepositedNano, 4),
      totalWithdrawnUsd: nanoToUsd(this.totalWithdrawnNano, 4),
    }
  }

  /**
   * Consume buyer funds strictly capped to the upfront reservation if `reservationId` is provided.
   * Returns the exact `BigInt` gross amount consumed.
   */
  _consumeBuyerFunds(buyer, requestedCostNano, reservationId) {
    if (reservationId) {
      const rsv = this.reservations.get(reservationId)
      if (!rsv || rsv.agentId !== buyer.id) {
        throw new Error('Invalid reservationId for buyer')
      }
      // Strict cap: a seller or upstream call can NEVER charge above the buyer's upfront reservation!
      const finalCost = requestedCostNano > rsv.amountNano ? rsv.amountNano : requestedCostNano
      const refund = rsv.amountNano - finalCost
      this.reservations.delete(reservationId)
      buyer.reservedNano -= rsv.amountNano
      buyer.spendableNano += refund
      return finalCost
    }

    if (buyer.spendableNano < requestedCostNano) {
      throw new Error('Insufficient buyer spendable balance')
    }
    buyer.spendableNano -= requestedCostNano
    return requestedCostNano
  }

  _applyEvent(ev) {
    switch (ev.type) {
      case 'REGISTER': {
        const acct = {
          id: ev.agentId,
          name: ev.name || '',
          banned: false,
          publicJwk: ev.publicJwk || null,
          thumbprint: ev.thumbprint || null,
          apiKeyHash: ev.apiKeyHash || null,
          referredBy: ev.referredBy || null,
          evmAddress: ev.evmAddress || null,
          lightningAddress: ev.lightningAddress || null,
          createdAt: ev.ts,
          spendableNano: 0n,
          bondedNano: 0n,
          reservedNano: 0n,
          sandboxCallsRemaining: ev.sandboxCallsRemaining ?? 0,
          stats: {
            earnedNano: 0n,
            spentNano: 0n,
            referralEarnedNano: 0n,
            slashedCount: 0,
            callsServed: 0,
            callsBought: 0,
          },
        }
        this.accounts.set(acct.id, acct)
        if (acct.apiKeyHash) this.apiKeyIndex.set(acct.apiKeyHash, acct.id)
        if (acct.thumbprint) this.pubkeyIndex.set(acct.thumbprint, acct.id)
        break
      }

      case 'DEPOSIT': {
        const amt = BigInt(ev.amountNano)
        const acct = this.accounts.get(ev.agentId)
        acct.spendableNano += amt
        this.totalDepositedNano += amt
        this.processedTxIds.add(ev.txId)
        break
      }

      case 'SWEEP_DUST': {
        const amt = BigInt(ev.amountNano)
        const acct = this.accounts.get(ev.agentId)
        acct.spendableNano -= amt
        this.treasuryNano += amt
        break
      }

      case 'REINVEST_TREASURY': {
        const amt = BigInt(ev.amountNano)
        const acct = this.accounts.get(ev.agentId)
        this.treasuryNano -= amt
        acct.spendableNano += amt
        break
      }

      case 'SETTLE_P2P': {
        const gross = BigInt(ev.grossNano)
        const toBond = BigInt(ev.sellerToBondNano)
        const toSpend = BigInt(ev.sellerToSpendableNano)
        const plat = BigInt(ev.platformNano)
        const ref = BigInt(ev.referrerNano)

        const buyer = this.accounts.get(ev.buyerId)
        const seller = this.accounts.get(ev.sellerId)
        buyer.stats.spentNano += gross
        buyer.stats.callsBought += 1

        seller.bondedNano += toBond
        seller.spendableNano += toSpend
        seller.stats.earnedNano += toBond + toSpend
        seller.stats.callsServed += 1

        if (ev.referrerId && ref > 0n) {
          const referrer = this.accounts.get(ev.referrerId)
          referrer.spendableNano += ref
          referrer.stats.referralEarnedNano += ref
        }
        this.treasuryNano += plat
        this.totalVolumeNano += gross
        this.totalSettledCalls += 1
        this._pushReceipt(ev)
        break
      }

      case 'SETTLE_HOUSE': {
        const total = BigInt(ev.buyerTotalNano)
        const wholesale = BigInt(ev.wholesaleNano)
        const platMargin = BigInt(ev.platformNetMarginNano)
        const ref = BigInt(ev.referrerNano)

        const buyer = this.accounts.get(ev.buyerId)
        buyer.stats.spentNano += total
        buyer.stats.callsBought += 1

        if (ev.referrerId && ref > 0n) {
          const referrer = this.accounts.get(ev.referrerId)
          referrer.spendableNano += ref
          referrer.stats.referralEarnedNano += ref
        }
        this.wholesalePayableNano += wholesale
        this.treasuryNano += platMargin
        this.totalVolumeNano += total
        this.totalSettledCalls += 1
        this._pushReceipt(ev)
        break
      }

      case 'SLASH_BOND': {
        const amt = BigInt(ev.slashedNano)
        const seller = this.accounts.get(ev.sellerId)
        seller.bondedNano -= amt
        seller.stats.slashedCount += 1
        if (ev.banned !== false) seller.banned = true
        this.treasuryNano += amt
        break
      }

      case 'WITHDRAW': {
        const amt = BigInt(ev.amountNano)
        this.totalWithdrawnNano += amt
        const hist = this.withdrawHistory.get(ev.agentId) || []
        hist.push({ ts: ev.ts, amountNano: amt })
        this.withdrawHistory.set(ev.agentId, hist)
        break
      }

      case 'SANDBOX_USE': {
        const acct = this.accounts.get(ev.agentId)
        if (acct) {
          acct.sandboxCallsRemaining = Math.max((acct.sandboxCallsRemaining || 0) - 1, 0)
          acct.stats.callsBought += 1
        }
        this.totalSettledCalls += 1
        this._pushReceipt({
          receiptId: ev.receiptId,
          ts: ev.ts,
          type: 'SANDBOX_USE',
          capability: ev.capability,
          buyerId: ev.agentId,
          sellerId: 'switch402_sandbox',
          grossNano: '0',
          latencyMs: ev.latencyMs || 0,
        })
        break
      }
    }
  }

  _pushReceipt(ev) {
    this.recentReceipts.push({
      receiptId: ev.receiptId,
      ts: ev.ts,
      mode:
        ev.type === 'SETTLE_P2P'
          ? 'p2p'
          : ev.type === 'SANDBOX_USE'
            ? 'sandbox'
            : 'house',
      capability: ev.capability,
      buyerId: ev.buyerId,
      sellerId: ev.sellerId || 'house_upstream',
      grossUsd: nanoToUsd(ev.grossNano || ev.buyerTotalNano || '0', 6),
      latencyMs: ev.latencyMs,
    })
    if (this.recentReceipts.length > 200) {
      this.recentReceipts.shift()
    }
  }

  _appendWal(ev) {
    if (this._walFd === null) return
    fs.writeSync(this._walFd, `${JSON.stringify(ev)}\n`)
    this._walEventsSinceCompact += 1
    if (this.walCompactThreshold > 0 && this._walEventsSinceCompact >= this.walCompactThreshold) {
      this._walEventsSinceCompact = 0
      try {
        this.compactSnapshot()
      } catch {
        // Best-effort auto-compaction
      }
    }
  }

  _loadFromDisk() {
    const snapPath = path.join(this.dataDir, 'ledger.snapshot.json')
    if (fs.existsSync(snapPath)) {
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
      this.treasuryNano = BigInt(snap.treasuryNano)
      this.wholesalePayableNano = BigInt(snap.wholesalePayableNano)
      this.totalDepositedNano = BigInt(snap.totalDepositedNano)
      this.totalWithdrawnNano = BigInt(snap.totalWithdrawnNano)
      this.totalVolumeNano = BigInt(snap.totalVolumeNano || '0')
      this.totalSettledCalls = snap.totalSettledCalls || 0
      this.processedTxIds = new Set(snap.processedTxIds || [])
      for (const raw of snap.accounts || []) {
        const acct = {
          ...raw,
          banned: Boolean(raw.banned),
          spendableNano: BigInt(raw.spendableNano),
          bondedNano: BigInt(raw.bondedNano),
          reservedNano: 0n,
          stats: {
            ...raw.stats,
            earnedNano: BigInt(raw.stats.earnedNano),
            spentNano: BigInt(raw.stats.spentNano),
            referralEarnedNano: BigInt(raw.stats.referralEarnedNano),
          },
        }
        this.accounts.set(acct.id, acct)
        if (acct.apiKeyHash) this.apiKeyIndex.set(acct.apiKeyHash, acct.id)
        if (acct.thumbprint) this.pubkeyIndex.set(acct.thumbprint, acct.id)
      }
    }

    const walPath = path.join(this.dataDir, 'ledger.wal.jsonl')
    if (fs.existsSync(walPath)) {
      const lines = fs.readFileSync(walPath, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch (err) {
          // Tolerate a torn/partial last line after an abrupt power loss or OOM kill
          if (i === lines.length - 1 || lines.slice(i + 1).every((l) => !l.trim())) {
            break
          }
          throw err
        }
        // Replay balances mutated via reservation consumption in live runtime
        if (ev.type === 'SETTLE_P2P') {
          const buyer = this.accounts.get(ev.buyerId)
          buyer.spendableNano -= BigInt(ev.grossNano)
        } else if (ev.type === 'SETTLE_HOUSE') {
          const buyer = this.accounts.get(ev.buyerId)
          buyer.spendableNano -= BigInt(ev.buyerTotalNano)
        } else if (ev.type === 'WITHDRAW') {
          const acct = this.accounts.get(ev.agentId)
          acct.spendableNano -= BigInt(ev.amountNano)
        }
        this._applyEvent(ev)
      }
    }
  }
}
