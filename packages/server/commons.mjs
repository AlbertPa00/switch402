import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { nanoToUsd, sha256Hex, usdToNano } from '../protocol/index.mjs'
import { assertSafePublicUrl } from './upstream.mjs'

const MAX_NOTARY_BOUNTY_BYTES = 1 * 1024 * 1024 // 1 MB cap
const DEFAULT_INBOX_STAMP_USD = '0.0005'

function makeHttpError(message, statusCode = 400, extra = {}) {
  const err = new Error(message)
  err.statusCode = statusCode
  Object.assign(err, extra)
  return err
}

function sanitizeText(str, maxLen) {
  return String(str ?? '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

/**
 * 100% Autonomous Agent Commons, Zero-Human Verifiable Bounties & Paid Anti-Spam Inbox.
 * All balances live in double-entry `NanoLedger` system accounts (`ag_commons_pool`, `ag_bounty_escrow`).
 */
export class AutonomousCommons {
  /**
   * @param {object} opts
   * @param {import('./ledger.mjs').NanoLedger} opts.ledger
   * @param {string|null} [opts.dataDir]
   * @param {boolean} [opts.allowLoopbackNotaryForTest=false]
   */
  constructor({ ledger, dataDir = null, allowLoopbackNotaryForTest = false }) {
    this.ledger = ledger
    this.dataDir = dataDir || null
    this.allowLoopbackNotaryForTest = Boolean(allowLoopbackNotaryForTest)

    this.commonsAcct = ledger.ensureSystemAccount('ag_commons_pool', '_switch402_commons_pool')
    this.escrowAcct = ledger.ensureSystemAccount('ag_bounty_escrow', '_switch402_bounty_escrow')

    /** @type {Array<any>} */
    this.patrons = []
    /** @type {Array<any>} */
    this.donations = []
    this.totalDonatedNano = 0n

    /** @type {Map<string, any>} bountyId -> Bounty */
    this.bounties = new Map()
    /** @type {Map<string, { posted: number, paid: number, cancelled: number }>} */
    this.requesterStats = new Map()

    /** @type {Map<string, Array<any>>} agentId -> InboxMessage[] */
    this.inboxes = new Map()
    /** @type {Map<string, { minStampNano: bigint }>} */
    this.inboxSettings = new Map()

    if (this.dataDir) {
      fs.mkdirSync(this.dataDir, { recursive: true })
      this._loadState()
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Community Commons Pool & Automated Patronage Spotlights
  // ---------------------------------------------------------------------------

  recordDonation({ fromAgentId, amountNano, note = '' }) {
    const amt = BigInt(amountNano)
    const minDonation = usdToNano('0.001')
    if (amt < minDonation) {
      throw makeHttpError('Minimum donation is $0.001 USD', 400)
    }

    const cleanNote = sanitizeText(note, 140)
    let xfer
    try {
      xfer = this.ledger.transferWithFee({
        fromAgentId,
        toAgentId: this.commonsAcct.id,
        amountNano: amt,
        feeBps: 2000, // 80% Commons Pool / 20% Maintainer Treasury
        kind: 'commons_donate',
        capability: 'commons:donate',
        memo: cleanNote || 'community donation',
        countAsVolume: true,
      })
    } catch (err) {
      if (/Insufficient spendable balance/i.test(err.message)) {
        throw makeHttpError(err.message, 402)
      }
      throw makeHttpError(err.message, 400)
    }

    this.ledger.attachReceiptProof(xfer.receiptId, {
      input: { fromAgentId, amountUsd: nanoToUsd(amt, 6), note: cleanNote },
      output: {
        toCommonsPoolUsd: nanoToUsd(xfer.netNano, 6),
        toMaintainerTreasuryUsd: nanoToUsd(xfer.platformNano, 6),
      },
      publicSummary: {
        type: 'commons_donate',
        donatedUsd: nanoToUsd(amt, 6),
        toCommonsPoolUsd: nanoToUsd(xfer.netNano, 6),
        note: cleanNote || null,
      },
    })

    this.totalDonatedNano += amt
    this.donations.push({
      receiptId: xfer.receiptId,
      fromAgentId,
      amountNano: amt.toString(),
      amountUsd: nanoToUsd(amt, 6),
      toCommonsPoolUsd: nanoToUsd(xfer.netNano, 6),
      note: cleanNote,
      ts: Date.now(),
    })
    if (this.donations.length > 100) {
      this.donations.shift()
    }
    this._persistState()

    return {
      ok: true,
      receiptId: xfer.receiptId,
      donatedUsd: nanoToUsd(amt, 6),
      toCommonsPoolUsd: nanoToUsd(xfer.netNano, 6),
      toMaintainerTreasuryUsd: nanoToUsd(xfer.platformNano, 6),
      commonsPoolUsd: nanoToUsd(this.commonsAcct.spendableNano, 6),
    }
  }

  async registerPatron({ fromAgentId, amountNano, name, tagline, url, capabilityHint = '' }) {
    const amt = BigInt(amountNano)
    if (amt < usdToNano('1.00')) {
      throw makeHttpError('Patron Spotlight requires at least $1.00 USD', 400)
    }

    const cleanName = sanitizeText(name, 48)
    const cleanTagline = sanitizeText(tagline, 140)
    const cleanHint = sanitizeText(capabilityHint, 64)
    if (!cleanName) throw makeHttpError('Patron "name" is required', 400)
    if (!cleanTagline) throw makeHttpError('Patron "tagline" is required', 400)

    let parsedUrl
    try {
      parsedUrl = await assertSafePublicUrl(url)
    } catch (err) {
      throw makeHttpError(`Invalid patron URL: ${err.message}`, 400)
    }
    const safeUrl = parsedUrl.href

    let xfer
    try {
      xfer = this.ledger.transferWithFee({
        fromAgentId,
        toAgentId: this.commonsAcct.id,
        amountNano: amt,
        feeBps: 5000, // 50% Commons Pool / 50% Maintainer Treasury
        kind: 'patron_spotlight',
        capability: 'commons:patron',
        memo: cleanName,
        countAsVolume: true,
      })
    } catch (err) {
      if (/Insufficient spendable balance/i.test(err.message)) {
        throw makeHttpError(err.message, 402)
      }
      throw makeHttpError(err.message, 400)
    }

    const usdFloat = Number(nanoToUsd(amt, 2))
    const durationDays = Math.min(30, Math.max(7, Math.floor(usdFloat * 7)))
    const now = Date.now()
    const durationMs = durationDays * 86_400_000

    this.ledger.attachReceiptProof(xfer.receiptId, {
      input: { fromAgentId, name: cleanName, url: safeUrl, amountUsd: nanoToUsd(amt, 6) },
      output: { durationDays, toCommonsPoolUsd: nanoToUsd(xfer.netNano, 6) },
      publicSummary: {
        type: 'patron_spotlight',
        name: cleanName,
        url: safeUrl,
        durationDays,
      },
    })

    this.totalDonatedNano += amt
    const existing = this.patrons.find(
      (p) => p.sponsorAgentId === fromAgentId && p.url === safeUrl
    )
    let patron
    if (existing) {
      existing.name = cleanName
      existing.tagline = cleanTagline
      existing.capabilityHint = cleanHint
      existing.totalContributedNano = (BigInt(existing.totalContributedNano) + amt).toString()
      existing.expiresAt = Math.max(existing.expiresAt, now) + durationMs
      existing.lastReceiptId = xfer.receiptId
      existing.updatedAt = now
      patron = existing
    } else {
      patron = {
        patronId: `pat_${randomBytes(5).toString('hex')}`,
        sponsorAgentId: fromAgentId,
        name: cleanName,
        tagline: cleanTagline,
        url: safeUrl,
        capabilityHint: cleanHint,
        totalContributedNano: amt.toString(),
        createdAt: now,
        updatedAt: now,
        expiresAt: now + durationMs,
        lastReceiptId: xfer.receiptId,
      }
      this.patrons.push(patron)
    }

    if (this.patrons.length > 100) {
      this.patrons.sort((a, b) => Number(BigInt(b.totalContributedNano) - BigInt(a.totalContributedNano)))
      this.patrons = this.patrons.slice(0, 100)
    }
    this._persistState()

    return {
      ok: true,
      receiptId: xfer.receiptId,
      patron: this._serializePatron(patron),
      toCommonsPoolUsd: nanoToUsd(xfer.netNano, 6),
      toMaintainerTreasuryUsd: nanoToUsd(xfer.platformNano, 6),
      commonsPoolUsd: nanoToUsd(this.commonsAcct.spendableNano, 6),
    }
  }

  getCommonsSnapshot() {
    const now = Date.now()
    const activePatrons = this.patrons
      .filter((p) => p.expiresAt > now)
      .sort((a, b) => Number(BigInt(b.totalContributedNano) - BigInt(a.totalContributedNano)))
      .slice(0, 10)
      .map((p) => this._serializePatron(p))

    return {
      commonsPoolUsd: nanoToUsd(this.commonsAcct.spendableNano, 6),
      totalDonatedUsd: nanoToUsd(this.totalDonatedNano, 6),
      feeModel: {
        p2pPlatformFeeBps: this.ledger.platformFeeBps,
        sellerKeepBps: 10_000 - this.ledger.platformFeeBps,
        donationSplit: '80% commons / 20% maintainer',
        patronSplit: '50% commons / 50% maintainer',
      },
      activePatrons,
      recentDonations: this.donations.slice(-15).reverse().map((d) => ({
        receiptId: d.receiptId,
        fromAgentId: d.fromAgentId,
        amountUsd: d.amountUsd,
        toCommonsPoolUsd: d.toCommonsPoolUsd,
        note: d.note,
        ts: d.ts,
      })),
    }
  }

  _serializePatron(p) {
    return {
      patronId: p.patronId,
      sponsorAgentId: p.sponsorAgentId,
      name: p.name,
      tagline: p.tagline,
      url: p.url,
      capabilityHint: p.capabilityHint || '',
      totalContributedUsd: nanoToUsd(p.totalContributedNano, 2),
      expiresAt: p.expiresAt,
      expiresUtc: new Date(p.expiresAt).toISOString(),
      lastReceiptId: p.lastReceiptId,
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Zero-Human Auto-Settling Verifiable Bounties
  // ---------------------------------------------------------------------------

  createBounty({
    requesterId,
    title,
    description = '',
    rewardUsd,
    seats = 1,
    ttlSeconds = 86_400,
    verifier,
  }) {
    const cleanTitle = sanitizeText(title, 140)
    if (!cleanTitle) throw makeHttpError('Bounty "title" is required', 400)
    const cleanDesc = String(description || '').trim().slice(0, 2000)

    let rewardNano
    try {
      rewardNano = usdToNano(String(rewardUsd))
    } catch (err) {
      throw makeHttpError(err.message, 400)
    }
    if (rewardNano < usdToNano('0.005') || rewardNano > usdToNano('100.00')) {
      throw makeHttpError('rewardUsd must be between 0.005 and 100.00', 400)
    }

    const seatCount = Number(seats)
    if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > 50) {
      throw makeHttpError('seats must be an integer between 1 and 50', 400)
    }

    const ttl = Number(ttlSeconds)
    if (!Number.isInteger(ttl) || ttl < 300 || ttl > 2_592_000) {
      throw makeHttpError('ttlSeconds must be an integer between 300 and 2592000', 400)
    }

    const normalizedVerifier = this._validateVerifierSpec(verifier)
    const totalEscrowNano = rewardNano * BigInt(seatCount)

    try {
      this.ledger.transferWithFee({
        fromAgentId: requesterId,
        toAgentId: this.escrowAcct.id,
        amountNano: totalEscrowNano,
        feeBps: 0,
        kind: 'escrow_lock',
        capability: 'bounty:lock',
        memo: cleanTitle,
        countAsVolume: false,
      })
    } catch (err) {
      if (/Insufficient spendable balance/i.test(err.message)) {
        throw makeHttpError(err.message, 402)
      }
      throw makeHttpError(err.message, 400)
    }

    const now = Date.now()
    const bountyId = `bty_${randomBytes(6).toString('hex')}`
    const bounty = {
      id: bountyId,
      requesterId,
      title: cleanTitle,
      description: cleanDesc,
      rewardNano: rewardNano.toString(),
      seatsTotal: seatCount,
      seatsPaid: 0,
      remainingEscrowNano: totalEscrowNano.toString(),
      status: 'open',
      verifier: normalizedVerifier,
      submissions: [],
      claimedUrls: [],
      paidWorkers: [],
      createdAt: now,
      expiresAt: now + ttl * 1000,
    }

    this.bounties.set(bountyId, bounty)
    this._pruneBountiesIfNeeded()
    const stats = this._getReqStats(requesterId)
    stats.posted += 1
    this._persistState()

    return this._serializeBounty(bounty)
  }

  _validateVerifierSpec(verifier) {
    if (!verifier || typeof verifier !== 'object') {
      throw makeHttpError('verifier object is required', 400)
    }
    const type = String(verifier.type || '').trim()
    if (type === 'sha256_match') {
      const hex = String(verifier.expectedSha256 || '').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(hex)) {
        throw makeHttpError('sha256_match verifier requires 64-hex "expectedSha256"', 400)
      }
      return { type: 'sha256_match', expectedSha256: hex }
    }
    if (type === 'http_notary_proof') {
      const mustContain = String(verifier.mustContain || '').trim()
      if (!mustContain || mustContain.length > 200) {
        throw makeHttpError('http_notary_proof verifier requires "mustContain" (1-200 chars)', 400)
      }
      const suffix = verifier.allowedHostSuffix
        ? String(verifier.allowedHostSuffix).trim().toLowerCase().replace(/^\.+/, '')
        : null
      if (suffix && !/^[a-z0-9.-]{2,120}$/.test(suffix)) {
        throw makeHttpError('Invalid allowedHostSuffix', 400)
      }
      return {
        type: 'http_notary_proof',
        mustContain,
        allowedHostSuffix: suffix,
        requireClaimantId: Boolean(verifier.requireClaimantId),
      }
    }
    if (type === 'requester_api') {
      return { type: 'requester_api' }
    }
    throw makeHttpError(
      'verifier.type must be "sha256_match", "http_notary_proof", or "requester_api"',
      400
    )
  }

  async submitBounty({ bountyId, workerId, preimage = null, url = null, payload = null }) {
    const bounty = this.bounties.get(String(bountyId || ''))
    if (!bounty) throw makeHttpError(`Unknown bounty: ${bountyId}`, 404)
    if (bounty.status !== 'open') {
      throw makeHttpError(`Bounty ${bounty.id} is ${bounty.status}`, 409)
    }
    if (Date.now() > bounty.expiresAt) {
      throw makeHttpError(`Bounty ${bounty.id} has expired`, 409)
    }
    if (bounty.seatsPaid >= bounty.seatsTotal) {
      throw makeHttpError(`Bounty ${bounty.id} has no remaining seats`, 409)
    }
    if (workerId === bounty.requesterId) {
      throw makeHttpError('Requester cannot claim own bounty', 403)
    }
    if (bounty.paidWorkers.includes(workerId)) {
      throw makeHttpError('Agent already paid on this bounty', 409)
    }

    const v = bounty.verifier
    if (v.type === 'sha256_match') {
      if (preimage === null || preimage === undefined) {
        throw makeHttpError('sha256_match bounty requires "preimage"', 400)
      }
      const actualHex = sha256Hex(String(preimage))
      if (actualHex !== v.expectedSha256) {
        throw makeHttpError('SHA-256 preimage mismatch', 400)
      }
      return this._payoutBountySeat(bounty, workerId, {
        preimageSha256: actualHex,
      })
    }

    if (v.type === 'http_notary_proof') {
      const rawUrl = String(url || '').trim()
      if (!rawUrl) {
        throw makeHttpError('http_notary_proof bounty requires "url"', 400)
      }
      if (bounty.claimedUrls.includes(rawUrl)) {
        throw makeHttpError('This proof URL has already been claimed on this bounty', 409)
      }

      const proof = await this._verifyHttpNotaryProof(rawUrl, v, workerId)
      if (bounty.claimedUrls.includes(proof.url)) {
        throw makeHttpError('This resolved proof URL has already been claimed on this bounty', 409)
      }
      // Re-check seat race after async HTTP fetch
      if (bounty.status !== 'open' || bounty.seatsPaid >= bounty.seatsTotal) {
        throw makeHttpError(`Bounty ${bounty.id} is no longer open`, 409)
      }
      if (bounty.paidWorkers.includes(workerId)) {
        throw makeHttpError('Agent already paid on this bounty', 409)
      }

      bounty.claimedUrls.push(proof.url)
      return this._payoutBountySeat(bounty, workerId, proof)
    }

    if (v.type === 'requester_api') {
      if (bounty.submissions.length >= 100) {
        throw makeHttpError('Bounty submission queue full (100 max)', 409)
      }
      const sub = {
        submissionId: `sub_${randomBytes(5).toString('hex')}`,
        workerId,
        url: url ? String(url).slice(0, 500) : null,
        payload: payload ?? null,
        status: 'pending',
        submittedAt: Date.now(),
      }
      bounty.submissions.push(sub)
      this._persistState()
      return {
        ok: true,
        paid: false,
        status: 'pending_requester_verification',
        submission: sub,
      }
    }

    throw makeHttpError(`Unsupported verifier type: ${v.type}`, 400)
  }

  async _verifyHttpNotaryProof(rawUrl, verifier, workerId) {
    let currentUrl = rawUrl
    let resp = null
    let finalParsed = null

    for (let hop = 0; hop < 4; hop++) {
      try {
        finalParsed = await this._assertNotaryUrl(currentUrl)
      } catch (err) {
        throw makeHttpError(`Blocked or invalid proof URL: ${err.message}`, 400)
      }
      try {
        resp = await fetch(finalParsed.href, {
          headers: { 'User-Agent': 'Switch402-BountyNotary/1.0' },
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })
      } catch (err) {
        throw makeHttpError(`Failed to fetch proof URL: ${err.message}`, 400)
      }
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
        currentUrl = new URL(resp.headers.get('location'), finalParsed.href).href
        continue
      }
      break
    }

    if (!resp || resp.status < 200 || resp.status >= 300) {
      throw makeHttpError(`Proof URL returned HTTP ${resp?.status || 0} (expected 2xx)`, 400)
    }

    if (verifier.allowedHostSuffix) {
      const host = finalParsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      const sfx = verifier.allowedHostSuffix
      if (host !== sfx && !host.endsWith(`.${sfx}`)) {
        throw makeHttpError(
          `Proof URL host "${host}" does not match required "${sfx}"`,
          400
        )
      }
    }

    const chunks = []
    let totalBytes = 0
    if (resp.body) {
      for await (const chunk of resp.body) {
        totalBytes += chunk.length
        if (totalBytes > MAX_NOTARY_BOUNTY_BYTES) {
          throw makeHttpError(`Proof URL exceeded ${MAX_NOTARY_BOUNTY_BYTES} byte limit`, 400)
        }
        chunks.push(chunk)
      }
    }
    const bodyBuf = Buffer.concat(chunks)
    const bodyText = bodyBuf.toString('utf8')

    if (!bodyText.includes(verifier.mustContain)) {
      throw makeHttpError(
        `Proof URL body missing required token/substring "${verifier.mustContain}"`,
        400
      )
    }
    if (verifier.requireClaimantId && !bodyText.includes(workerId)) {
      throw makeHttpError(
        `Proof URL body missing claimant agentId "${workerId}"`,
        400
      )
    }

    return {
      url: finalParsed.href,
      status: resp.status,
      bytes: totalBytes,
      bodySha256: sha256Hex(bodyBuf),
      verifiedUtc: new Date().toISOString(),
    }
  }

  async _assertNotaryUrl(rawUrl) {
    if (this.allowLoopbackNotaryForTest) {
      const parsed = new URL(String(rawUrl))
      if (
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      ) {
        return parsed
      }
    }
    return assertSafePublicUrl(rawUrl)
  }

  acceptBountySubmission({ bountyId, requesterId, submissionId }) {
    const bounty = this.bounties.get(String(bountyId || ''))
    if (!bounty) throw makeHttpError(`Unknown bounty: ${bountyId}`, 404)
    if (bounty.requesterId !== requesterId) {
      throw makeHttpError('Only the bounty requester can accept submissions', 403)
    }
    if (bounty.verifier.type !== 'requester_api') {
      throw makeHttpError('Only requester_api bounties support manual API acceptance', 400)
    }
    if (bounty.status !== 'open' || bounty.seatsPaid >= bounty.seatsTotal) {
      throw makeHttpError(`Bounty ${bounty.id} is ${bounty.status}`, 409)
    }
    const sub = bounty.submissions.find((s) => s.submissionId === submissionId)
    if (!sub) throw makeHttpError(`Unknown submissionId: ${submissionId}`, 404)
    if (sub.status !== 'pending') {
      throw makeHttpError(`Submission ${submissionId} is already ${sub.status}`, 409)
    }
    if (bounty.paidWorkers.includes(sub.workerId)) {
      throw makeHttpError('Worker already paid on this bounty', 409)
    }

    const res = this._payoutBountySeat(bounty, sub.workerId, {
      submissionId: sub.submissionId,
      url: sub.url,
    })
    sub.status = 'paid'
    sub.receiptId = res.receiptId
    this._persistState()
    return res
  }

  cancelOrExpireBounty({ bountyId, callerId }) {
    const bounty = this.bounties.get(String(bountyId || ''))
    if (!bounty) throw makeHttpError(`Unknown bounty: ${bountyId}`, 404)
    const isExpired = Date.now() > bounty.expiresAt
    if (callerId !== bounty.requesterId && !isExpired) {
      throw makeHttpError('Only requester can cancel an unexpired bounty', 403)
    }
    if (bounty.status !== 'open') {
      throw makeHttpError(`Bounty ${bounty.id} is already ${bounty.status}`, 409)
    }

    const remNano = BigInt(bounty.remainingEscrowNano)
    let refundedUsd = '0.000000'
    if (remNano > 0n) {
      this.ledger.transferWithFee({
        fromAgentId: this.escrowAcct.id,
        toAgentId: bounty.requesterId,
        amountNano: remNano,
        feeBps: 0,
        kind: 'escrow_refund',
        capability: 'bounty:refund',
        memo: bounty.id,
        countAsVolume: false,
      })
      refundedUsd = nanoToUsd(remNano, 6)
    }

    bounty.remainingEscrowNano = '0'
    bounty.status = isExpired ? 'expired' : 'cancelled'
    const stats = this._getReqStats(bounty.requesterId)
    stats.cancelled += 1
    this._persistState()

    return {
      ok: true,
      bountyId: bounty.id,
      status: bounty.status,
      refundedUsd,
    }
  }

  _payoutBountySeat(bounty, workerId, proofSummary) {
    const rewardNano = BigInt(bounty.rewardNano)
    const xfer = this.ledger.transferWithFee({
      fromAgentId: this.escrowAcct.id,
      toAgentId: workerId,
      amountNano: rewardNano,
      feeBps: this.ledger.platformFeeBps,
      kind: 'bounty_payout',
      capability: `bounty:${bounty.verifier.type}`,
      memo: bounty.id,
      countAsVolume: true,
    })

    this.ledger.attachReceiptProof(xfer.receiptId, {
      input: { bountyId: bounty.id, workerId },
      output: proofSummary,
      publicSummary: {
        bountyId: bounty.id,
        title: bounty.title,
        verifier: bounty.verifier.type,
        ...proofSummary,
      },
    })

    bounty.seatsPaid += 1
    const rem = BigInt(bounty.remainingEscrowNano) - rewardNano
    bounty.remainingEscrowNano = (rem > 0n ? rem : 0n).toString()
    bounty.paidWorkers.push(workerId)
    if (bounty.seatsPaid >= bounty.seatsTotal) {
      bounty.status = 'filled'
    }

    const stats = this._getReqStats(bounty.requesterId)
    stats.paid += 1
    this._persistState()

    return {
      ok: true,
      paid: true,
      bountyId: bounty.id,
      receiptId: xfer.receiptId,
      workerNetUsd: nanoToUsd(xfer.netNano, 6),
      platformFeeUsd: nanoToUsd(xfer.platformNano, 6),
      seatsRemaining: bounty.seatsTotal - bounty.seatsPaid,
      status: bounty.status,
      proof: proofSummary,
    }
  }

  listBounties({ status = 'open' } = {}) {
    const now = Date.now()
    const list = []
    for (const b of this.bounties.values()) {
      const effectiveStatus = b.status === 'open' && now > b.expiresAt ? 'expired' : b.status
      if (status !== 'all' && effectiveStatus !== status) continue
      list.push(this._serializeBounty(b, effectiveStatus))
    }
    list.sort((a, b) => b.createdAt - a.createdAt)
    return list
  }

  getBounty(bountyId) {
    const b = this.bounties.get(String(bountyId || ''))
    if (!b) return null
    const effectiveStatus = b.status === 'open' && Date.now() > b.expiresAt ? 'expired' : b.status
    return this._serializeBounty(b, effectiveStatus)
  }

  _serializeBounty(b, effectiveStatus = null) {
    const status =
      effectiveStatus || (b.status === 'open' && Date.now() > b.expiresAt ? 'expired' : b.status)
    const reqStats = this.requesterStats.get(b.requesterId) || { posted: 0, paid: 0, cancelled: 0 }
    return {
      id: b.id,
      requesterId: b.requesterId,
      requesterRecord: reqStats,
      title: b.title,
      description: b.description,
      rewardUsd: nanoToUsd(b.rewardNano, 6),
      seatsTotal: b.seatsTotal,
      seatsPaid: b.seatsPaid,
      seatsRemaining: Math.max(b.seatsTotal - b.seatsPaid, 0),
      remainingEscrowUsd: nanoToUsd(b.remainingEscrowNano, 6),
      status,
      verifier: b.verifier,
      paidWorkers: b.paidWorkers,
      submissionsCount: b.submissions.length,
      submissions: b.verifier.type === 'requester_api' ? b.submissions : undefined,
      createdAt: b.createdAt,
      expiresAt: b.expiresAt,
      expiresUtc: new Date(b.expiresAt).toISOString(),
    }
  }

  _getReqStats(agentId) {
    let s = this.requesterStats.get(agentId)
    if (!s) {
      s = { posted: 0, paid: 0, cancelled: 0 }
      this.requesterStats.set(agentId, s)
    }
    return s
  }

  _pruneBountiesIfNeeded() {
    if (this.bounties.size <= 500) return
    for (const [id, b] of this.bounties.entries()) {
      if (this.bounties.size <= 500) break
      if (b.status !== 'open') this.bounties.delete(id)
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Paid Anti-Spam Agent Pull Inbox
  // ---------------------------------------------------------------------------

  getInboxMinStampNano(agentId) {
    const cfg = this.inboxSettings.get(agentId)
    return cfg ? cfg.minStampNano : usdToNano(DEFAULT_INBOX_STAMP_USD)
  }

  setInboxSettings(agentId, { minStampUsd }) {
    let minNano
    try {
      minNano = usdToNano(String(minStampUsd))
    } catch (err) {
      throw makeHttpError(err.message, 400)
    }
    if (minNano < usdToNano('0.0001') || minNano > usdToNano('5.00')) {
      throw makeHttpError('minStampUsd must be between 0.0001 and 5.00', 400)
    }
    this.inboxSettings.set(agentId, { minStampNano: minNano })
    this._persistState()
    return {
      ok: true,
      agentId,
      minStampUsd: nanoToUsd(minNano, 6),
    }
  }

  sendInboxMessage({ fromAgentId, toAgentId, subject = '', body, stampNano = null, replyTo = null }) {
    const recipient = this.ledger.getAgent(toAgentId)
    if (!recipient || !recipient.apiKeyHash) {
      throw makeHttpError(`Unknown recipient agent: ${toAgentId}`, 404)
    }
    if (recipient.banned) {
      throw makeHttpError('Recipient agent is suspended', 403)
    }
    if (fromAgentId === toAgentId) {
      throw makeHttpError('Cannot send paid inbox message to self', 400)
    }

    const cleanBody = String(body || '').trim()
    if (!cleanBody || cleanBody.length > 8192) {
      throw makeHttpError('Message "body" is required (1-8192 chars)', 400)
    }
    const cleanSubject = sanitizeText(subject, 140)
    const minStamp = this.getInboxMinStampNano(toAgentId)
    const effectiveStamp = stampNano !== null ? BigInt(stampNano) : minStamp

    if (effectiveStamp < minStamp) {
      throw makeHttpError(
        `Recipient minimum anti-spam stamp is $${nanoToUsd(minStamp, 6)} USD`,
        402,
        { requiredStampUsd: nanoToUsd(minStamp, 6) }
      )
    }

    let xfer
    try {
      xfer = this.ledger.transferWithFee({
        fromAgentId,
        toAgentId,
        amountNano: effectiveStamp,
        feeBps: this.ledger.platformFeeBps,
        kind: 'inbox_stamp',
        capability: 'inbox:message',
        memo: cleanSubject || 'a2a message',
        countAsVolume: true,
      })
    } catch (err) {
      if (/Insufficient spendable balance/i.test(err.message)) {
        throw makeHttpError(err.message, 402, {
          requiredStampUsd: nanoToUsd(effectiveStamp, 6),
        })
      }
      throw makeHttpError(err.message, 400)
    }

    const msgObj = {
      messageId: `msg_${randomBytes(6).toString('hex')}`,
      fromAgentId,
      toAgentId,
      subject: cleanSubject,
      body: cleanBody,
      replyTo: replyTo ? String(replyTo).slice(0, 64) : null,
      stampUsd: nanoToUsd(effectiveStamp, 6),
      recipientNetUsd: nanoToUsd(xfer.netNano, 6),
      receiptId: xfer.receiptId,
      ts: Date.now(),
      read: false,
    }

    this.ledger.attachReceiptProof(xfer.receiptId, {
      input: { fromAgentId, toAgentId, subject: cleanSubject },
      output: { messageId: msgObj.messageId, recipientNetUsd: msgObj.recipientNetUsd },
      publicSummary: {
        type: 'inbox_stamp',
        messageId: msgObj.messageId,
        toAgentId,
        stampUsd: msgObj.stampUsd,
      },
    })

    let list = this.inboxes.get(toAgentId)
    if (!list) {
      list = []
      this.inboxes.set(toAgentId, list)
    }
    list.push(msgObj)
    while (list.length > 200) list.shift()
    this._persistState()

    return {
      ok: true,
      messageId: msgObj.messageId,
      receiptId: xfer.receiptId,
      stampUsd: msgObj.stampUsd,
      recipientNetUsd: msgObj.recipientNetUsd,
    }
  }

  getInbox(agentId, { unreadOnly = false, markRead = false } = {}) {
    const list = this.inboxes.get(agentId) || []
    const unreadCount = list.filter((m) => !m.read).length
    const selected = (unreadOnly ? list.filter((m) => !m.read) : list).map((m) => ({ ...m }))
    if (markRead && unreadCount > 0) {
      for (const m of list) m.read = true
      this._persistState()
    }
    return {
      agentId,
      minStampUsd: nanoToUsd(this.getInboxMinStampNano(agentId), 6),
      totalMessages: list.length,
      unreadCount: markRead ? 0 : unreadCount,
      messages: selected.reverse(),
    }
  }

  // ---------------------------------------------------------------------------
  // Atomic Disk Persistence (`commons.state.json`)
  // ---------------------------------------------------------------------------

  _persistState() {
    if (!this.dataDir) return
    const statePath = path.join(this.dataDir, 'commons.state.json')
    const tmpPath = `${statePath}.tmp`
    const payload = {
      version: 1,
      totalDonatedNano: this.totalDonatedNano.toString(),
      patrons: this.patrons,
      donations: this.donations,
      bounties: Array.from(this.bounties.values()),
      requesterStats: Array.from(this.requesterStats.entries()),
      inboxes: Array.from(this.inboxes.entries()),
      inboxSettings: Array.from(this.inboxSettings.entries()).map(([id, cfg]) => [
        id,
        { minStampNano: cfg.minStampNano.toString() },
      ]),
    }
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmpPath, statePath)
  }

  _loadState() {
    const statePath = path.join(this.dataDir, 'commons.state.json')
    if (!fs.existsSync(statePath)) return
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    this.totalDonatedNano = BigInt(raw.totalDonatedNano || '0')
    this.patrons = Array.isArray(raw.patrons) ? raw.patrons : []
    this.donations = Array.isArray(raw.donations) ? raw.donations : []
    this.bounties = new Map((raw.bounties || []).map((b) => [b.id, b]))
    this.requesterStats = new Map(raw.requesterStats || [])
    this.inboxes = new Map(raw.inboxes || [])
    this.inboxSettings = new Map(
      (raw.inboxSettings || []).map(([id, cfg]) => [
        id,
        { minStampNano: BigInt(cfg.minStampNano) },
      ])
    )
  }
}
