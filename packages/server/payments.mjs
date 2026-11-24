import { createHmac, randomBytes } from 'node:crypto'
import {
  canonicalAuthMessage,
  nanoToUsd,
  nanoToUsdcAtomic,
  safeEqualHex,
  sha256Hex,
  usdcAtomicToNano,
  usdToNano,
  verifyEd25519,
} from '../protocol/index.mjs'

const DEFAULT_USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/**
 * Hardened Multi-Rail Payment & Settlement Engine:
 * 1. HTTP 402 (`x402Version: 2`) Base USDC (`eip155:8453`) with `/verify` + `/settle`, in-flight replay mutex, and Bazaar schema.
 * 2. Bitcoin Lightning (`bolt11`) deposits & strict HMAC-authenticated webhooks (disabled by default until secret is configured).
 * 3. Two-phase atomic withdrawals (`reserve` -> external payout -> `commit` or `rollback` on payout failure).
 */
export class PaymentEngine {
  /**
   * @param {object} opts
   * @param {import('./ledger.mjs').NanoLedger} opts.ledger
   * @param {string} [opts.publicOrigin='http://localhost:4020']
   * @param {string} [opts.payToEvm]
   * @param {string} [opts.usdcBaseAddress]
   * @param {string} [opts.facilitatorUrl='https://facilitator.x402.rs']
   * @param {(sig: string, reqObj: any) => Promise<{ isValid: boolean, settled?: boolean, txHash?: string, invalidReason?: string }>} [opts.customX402Verifier]
   * @param {(wd: { agentId: string, amountUsd: string, sats: number, rail: string, destination: string }) => Promise<{ txId: string }>} [opts.customPayoutExecutor]
   * @param {string} [opts.coinosApiUrl='https://coinos.io/api']
   * @param {string} [opts.coinosApiToken='']
   * @param {string} [opts.webhookSecret='']
   * @param {number} [opts.btcUsdRate=95000]
   * @param {bigint} [opts.maxHourlyWithdrawNano]
   */
  constructor(opts) {
    this.ledger = opts.ledger
    this.publicOrigin = (opts.publicOrigin || 'http://localhost:4020').replace(/\/+$/, '')
    this.payToEvm = opts.payToEvm || '0xeDC5e77f1f0a2dd9Ab919687d54af2f312387A63'
    this.usdcBaseAddress = opts.usdcBaseAddress || DEFAULT_USDC_BASE
    this.facilitatorUrl = (
      opts.facilitatorUrl || 'https://facilitator.payai.network'
    ).replace(/\/+$/, '')
    this.customX402Verifier = opts.customX402Verifier || null
    this.customPayoutExecutor = opts.customPayoutExecutor || null
    this.coinosApiUrl = (opts.coinosApiUrl || 'https://coinos.io/api').replace(/\/+$/, '')
    this.coinosApiToken = opts.coinosApiToken || ''
    this.webhookSecret = opts.webhookSecret || ''
    this.btcUsdRate = opts.btcUsdRate || 95_000
    this._btcRateFetchedAt = 0
    this.enableLiveBtcRate = opts.enableLiveBtcRate ?? Boolean(opts.coinosApiToken)
    this.maxHourlyWithdrawNano = opts.maxHourlyWithdrawNano || usdToNano('100.00')

    /** @type {Map<string, any>} invoiceId -> PendingInvoice */
    this.pendingInvoices = new Map()
    /** @type {Map<string, number>} nonceKey -> usedAtMs (TTL-pruned) */
    this.usedNonces = new Map()
    /** @type {Set<string>} in-flight x402 payment header hashes (blocks concurrent race replays) */
    this.inFlightPayments = new Set()

    const guest = this.ledger.ensureSystemAccount('ag_x402_omnibus', '_x402_guest_omnibus')
    this.x402OmnibusAgentId = guest.id

    this._cleanupTimer = setInterval(() => this.pruneExpiredState(), 60_000)
    this._cleanupTimer.unref()
  }

  close() {
    clearInterval(this._cleanupTimer)
  }

  pruneExpiredState() {
    const now = Date.now()
    for (const [k, ts] of this.usedNonces.entries()) {
      if (now - ts > 300_000) this.usedNonces.delete(k) // >5m safely outside +/-120s window
    }
    for (const [invId, inv] of this.pendingInvoices.entries()) {
      if (now - inv.createdAt > 1_200_000) this.pendingInvoices.delete(invId) // >20m
    }
  }

  /**
   * Build `x402Version: 2` 402 response body + `PAYMENT-REQUIRED` base64 header.
   */
  buildX402Challenge({
    pathAndQuery,
    name = 'switch402-act',
    method = 'POST',
    description = 'Switch402 stateless agent inference & capability router',
    requiredNano = usdToNano('0.001'),
    inputSchema = null,
    outputSchema = null,
  }) {
    const rawAtomic = nanoToUsdcAtomic(requiredNano)
    const atomicStr = (rawAtomic > 0n ? rawAtomic : 1n).toString()
    const fullUrl = `${this.publicOrigin}${pathAndQuery}`
    const upperMethod = String(method || 'GET').toUpperCase()

    const resolvedInput =
      (inputSchema && upperMethod === 'GET'
        ? { type: 'object', properties: { queryParams: inputSchema } }
        : inputSchema
          ? { type: 'object', properties: { body: inputSchema } }
          : null) ||
      (upperMethod === 'GET'
        ? {
            type: 'object',
            properties: {
              queryParams: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Input parameter for atomic skill' },
                },
              },
            },
          }
        : {
            type: 'object',
            properties: {
              body: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'JSON input payload' },
                },
              },
            },
          })

    const resolvedOutput = outputSchema || {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        capability: { type: 'string' },
        output: { type: 'object' },
        example: { ok: true, capability: `act:${name}`, mode: 'p2p', output: {} },
      },
    }

    const payload = {
      x402Version: 2,
      error:
        'Payment required — pass Authorization: Bearer <ag_live_key> OR x402 PAYMENT-SIGNATURE header',
      resource: {
        url: fullUrl,
        description,
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: atomicStr,
          payTo: this.payToEvm,
          asset: this.usdcBaseAddress,
          maxTimeoutSeconds: 60,
          extra: { name: 'USD Coin', version: '2' },
        },
      ],
      extensions: {
        bazaar: {
          info: { name, method: upperMethod },
          schema: {
            properties: {
              input: resolvedInput,
              output: resolvedOutput,
            },
          },
        },
      },
    }

    const headerB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    return {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': headerB64,
        Link: `<${this.publicOrigin}/llms.txt>; rel="service-doc"`,
      },
      body: payload,
    }
  }

  /**
   * Verify AND settle an incoming `PAYMENT-SIGNATURE` / `X-PAYMENT` header via Facilitator,
   * guarded by an in-flight mutex + ledger txId idempotency check.
   */
  async verifyAndCreditX402({ paymentHeader, challengePayload, targetAgentId = null }) {
    if (!paymentHeader) return { ok: false, error: 'Missing payment header' }

    const sigHash = sha256Hex(paymentHeader)
    if (this.inFlightPayments.has(sigHash)) {
      return { ok: false, error: 'Duplicate x402 payment verification already in flight' }
    }
    if (this.ledger.processedTxIds.has(`x402:${sigHash}`)) {
      return { ok: false, error: 'Replay detected: x402 payment already consumed' }
    }

    this.inFlightPayments.add(sigHash)
    try {
      const requirement = challengePayload.accepts[0]
      let settledTxHash = null
      let paymentResponseHeader = null

      if (this.customX402Verifier) {
        const res = await this.customX402Verifier(paymentHeader, requirement)
        if (!res?.isValid || res?.settled === false) {
          return { ok: false, error: res?.invalidReason || 'Invalid or unsettled x402 signature' }
        }
        settledTxHash = res.txHash || sigHash
        paymentResponseHeader = Buffer.from(
          JSON.stringify({ success: true, transaction: settledTxHash, network: requirement.network }),
          'utf8'
        ).toString('base64')
      } else {
        let paymentPayload
        try {
          const decoded = Buffer.from(paymentHeader, 'base64').toString('utf8')
          paymentPayload = JSON.parse(decoded)
        } catch {
          try {
            paymentPayload = JSON.parse(paymentHeader)
          } catch {
            return { ok: false, error: 'Malformed base64 JSON in PAYMENT-SIGNATURE header' }
          }
        }

        // Attach resource + bazaar extension if client omitted them so PayAI Bazaar indexes on settle!
        if (!paymentPayload.resource && challengePayload.resource) {
          paymentPayload.resource = challengePayload.resource
        }
        if (!paymentPayload.extensions && challengePayload.extensions) {
          paymentPayload.extensions = challengePayload.extensions
        }

        const facilitatorReqBody = JSON.stringify({
          x402Version: paymentPayload.x402Version || 2,
          paymentPayload,
          paymentRequirements: requirement,
        })

        // Step 1: Verify EIP-3009 authorization signature & parameters
        const verifyResp = await fetch(`${this.facilitatorUrl}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: facilitatorReqBody,
          signal: AbortSignal.timeout(15_000),
        })
        if (!verifyResp.ok) {
          const errText = await verifyResp.text().catch(() => '')
          return {
            ok: false,
            error: `Facilitator /verify HTTP ${verifyResp.status}: ${errText.slice(0, 160)}`,
          }
        }
        const verifyJson = await verifyResp.json()
        if (!verifyJson?.isValid) {
          return {
            ok: false,
            error: verifyJson?.invalidReason || 'Invalid x402 payment signature',
          }
        }

        // Step 2: Settle EIP-3009 transferWithAuthorization on Base so USDC settles on-chain & indexes in Bazaar!
        const settleResp = await fetch(`${this.facilitatorUrl}/settle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: facilitatorReqBody,
          signal: AbortSignal.timeout(30_000),
        })
        if (!settleResp.ok) {
          const errText = await settleResp.text().catch(() => '')
          return {
            ok: false,
            error: `Facilitator /settle HTTP ${settleResp.status}: ${errText.slice(0, 160)}`,
          }
        }
        const settleJson = await settleResp.json()
        if (settleJson?.success === false) {
          return {
            ok: false,
            error:
              settleJson?.error ||
              settleJson?.errorReason ||
              'x402 on-chain settlement failed',
          }
        }
        settledTxHash =
          settleJson?.transaction || settleJson?.txHash || verifyJson?.txHash || sigHash
        paymentResponseHeader = Buffer.from(JSON.stringify(settleJson), 'utf8').toString('base64')
      }

      const txKey = `x402:${settledTxHash}`
      // Also record sigHash to block replays even if facilitator returns txHash
      this.ledger.processedTxIds.add(`x402:${sigHash}`)

      const creditNano = usdcAtomicToNano(requirement.amount)
      const isKeylessOmnibus = !targetAgentId
      const agentId = targetAgentId || this.x402OmnibusAgentId

      const dep = this.ledger.deposit({
        agentId,
        amountNano: creditNano,
        rail: 'x402_base_usdc',
        txId: txKey,
      })

      if (dep.duplicate) {
        return { ok: false, error: 'Replay detected: x402 payment already consumed' }
      }

      return {
        ok: true,
        agentId,
        isKeylessOmnibus,
        creditedNano: creditNano,
        creditedUsd: nanoToUsd(creditNano),
        txId: txKey,
        paymentResponseHeader,
      }
    } finally {
      this.inFlightPayments.delete(sigHash)
    }
  }

  async getBtcUsdRate() {
    if (!this.enableLiveBtcRate) return this.btcUsdRate
    const now = Date.now()
    if (now - this._btcRateFetchedAt < 300_000) return this.btcUsdRate
    try {
      const resp = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', {
        signal: AbortSignal.timeout(4_000),
      })
      if (resp.ok) {
        const json = await resp.json()
        const spot = Number(json?.data?.amount)
        if (Number.isFinite(spot) && spot > 1_000) {
          this.btcUsdRate = spot
          this._btcRateFetchedAt = now
        }
      }
    } catch {
      // Keep last known rate on transient network error
    }
    return this.btcUsdRate
  }

  /**
   * Create a Lightning `bolt11` deposit invoice for an agent.
   */
  async createLightningDeposit({ agentId, amountUsd }) {
    const acct = this.ledger.getAgent(agentId)
    if (!acct) throw new Error(`Unknown agent: ${agentId}`)
    const usdNum = Number(amountUsd)
    if (!Number.isFinite(usdNum) || usdNum < 0.01 || usdNum > 10_000) {
      throw new Error('amountUsd must be between 0.01 and 10000')
    }

    const btcRate = await this.getBtcUsdRate()
    const creditNano = usdToNano(usdNum.toFixed(6))
    const sats = Math.max(Math.ceil((usdNum / btcRate) * 100_000_000), 1)
    const invoiceId = `lninv_${randomBytes(8).toString('hex')}`

    let bolt11 = `lnbc${sats}n1p_switch402_${invoiceId}`
    if (this.coinosApiToken) {
      const resp = await fetch(`${this.coinosApiUrl}/invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.coinosApiToken}`,
        },
        body: JSON.stringify({
          invoice: {
            amount: sats,
            type: 'lightning',
            memo: `Switch402 topup ${agentId} (${invoiceId})`,
            webhook: `${this.publicOrigin}/v1/webhooks/lightning`,
          },
        }),
        signal: AbortSignal.timeout(12_000),
      })
      if (!resp.ok) {
        throw new Error(`Coinos invoice error: HTTP ${resp.status}`)
      }
      const data = await resp.json()
      bolt11 = data.text || data.hash || bolt11
    }

    this.pendingInvoices.set(invoiceId, {
      invoiceId,
      agentId,
      sats,
      creditNano,
      bolt11,
      createdAt: Date.now(),
      settled: false,
    })

    return {
      invoiceId,
      agentId,
      sats,
      creditUsd: nanoToUsd(creditNano, 4),
      bolt11,
      expiresInSeconds: 900,
    }
  }

  /**
   * Verify HMAC signature & settle a Lightning deposit webhook idempotently.
   */
  handleLightningWebhook({ rawBody, signatureHeader, payload }) {
    if (!this.webhookSecret) {
      const err = new Error('Lightning webhook secret is not configured on server')
      err.statusCode = 503
      throw err
    }
    const expectedHmac = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex')
    if (!safeEqualHex(expectedHmac, String(signatureHeader || ''))) {
      const err = new Error('Invalid webhook HMAC signature')
      err.statusCode = 401
      throw err
    }

    const invoiceId = payload.invoiceId
    const inv = this.pendingInvoices.get(invoiceId)
    if (!inv) {
      const err = new Error(`Unknown invoiceId: ${invoiceId}`)
      err.statusCode = 404
      throw err
    }
    if (inv.settled) {
      return { duplicate: true, agentId: inv.agentId }
    }

    inv.settled = true
    const txId = `lightning:${payload.paymentHash || invoiceId}`
    const dep = this.ledger.deposit({
      agentId: inv.agentId,
      amountNano: inv.creditNano,
      rail: 'lightning',
      txId,
    })

    return {
      ok: true,
      duplicate: dep.duplicate,
      agentId: inv.agentId,
      creditedUsd: nanoToUsd(inv.creditNano, 4),
    }
  }

  /**
   * Two-Phase Atomic Withdrawal:
   * 1. Verify Ed25519 signature + freshness + replay-nonce.
   * 2. Lock `amountNano` in `reservedNano` synchronously (prevents parallel race double-withdrawals).
   * 3. Execute external payout (Coinos Lightning API or custom payout adapter).
   * 4. Commit withdrawal on success, OR release reservation back to `spendableNano` on payout failure!
   */
  async processWithdrawal({ agent, amountUsd, rail = 'lightning', destination, authProof = null }) {
    if (!destination || typeof destination !== 'string') {
      throw new Error('destination (Lightning address/bolt11 or EVM address) is required')
    }
    if (rail !== 'lightning' && rail !== 'evm_usdc') {
      throw new Error('rail must be "lightning" or "evm_usdc"')
    }

    let nonceKey = null
    if (agent.publicJwk) {
      if (!authProof || !authProof.signature || !authProof.timestamp || !authProof.nonce) {
        throw new Error(
          'Agent has a registered Ed25519 publicJwk — withdrawal requires authProof { timestamp, nonce, signature }'
        )
      }
      const nowSec = Math.floor(Date.now() / 1000)
      const ts = Number(authProof.timestamp)
      if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 120) {
        throw new Error('Withdrawal signature timestamp expired (>120s skew)')
      }
      nonceKey = `${agent.id}:${authProof.nonce}`
      if (this.usedNonces.has(nonceKey)) {
        throw new Error('Withdrawal nonce already used')
      }

      const payloadHash = sha256Hex(`${amountUsd}|${rail}|${destination}`)
      const msg = canonicalAuthMessage({
        action: 'withdraw',
        agentId: agent.id,
        timestamp: ts,
        nonce: authProof.nonce,
        payloadHash,
      })

      if (!verifyEd25519(agent.publicJwk, msg, authProof.signature)) {
        throw new Error('Invalid Ed25519 withdrawal signature')
      }
      // Lock nonce immediately before async payout
      this.usedNonces.set(nonceKey, Date.now())
    }

    const amountNano = usdToNano(String(amountUsd))
    const reservationId = this.ledger.beginWithdrawal({
      agentId: agent.id,
      amountNano,
      maxHourlyWithdrawNano: this.maxHourlyWithdrawNano,
      requireFullBondIfSeller: true,
    })

    try {
      let externalTxId = null
      const btcRate = await this.getBtcUsdRate()
      const usdFloat = Number(nanoToUsd(amountNano, 6))
      const sats = Math.max(Math.floor((usdFloat / btcRate) * 100_000_000), 1)

      if (this.customPayoutExecutor) {
        const res = await this.customPayoutExecutor({
          agentId: agent.id,
          amountUsd: nanoToUsd(amountNano, 6),
          sats,
          rail,
          destination,
        })
        externalTxId = res?.txId || null
      } else if (rail === 'lightning' && this.coinosApiToken) {
        const resp = await fetch(`${this.coinosApiUrl}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.coinosApiToken}`,
          },
          body: JSON.stringify({
            payreq: destination,
            amount: sats,
          }),
          signal: AbortSignal.timeout(20_000),
        })
        if (!resp.ok) {
          const errTxt = await resp.text().catch(() => '')
          throw new Error(`Lightning payout failed (HTTP ${resp.status}): ${errTxt.slice(0, 140)}`)
        }
        const sentData = await resp.json()
        externalTxId = sentData?.hash || sentData?.id || null
      } else {
        throw new Error(
          `Payout rail "${rail}" is not configured on this server yet. Your balance remains intact and spendable on Switch402 calls.`
        )
      }

      return this.ledger.commitWithdrawal({
        reservationId,
        rail,
        destination,
        externalTxId,
      })
    } catch (payoutErr) {
      // Roll back locked funds cleanly to spendableNano so the user never loses money on failed upstream send!
      this.ledger.releaseReservation(reservationId)
      throw payoutErr
    }
  }
}
