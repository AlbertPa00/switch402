import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { acceptWebSocketUpgrade, nanoToUsd, usdToNano } from '../protocol/index.mjs'
import { NanoLedger } from './ledger.mjs'
import { HouseUpstream } from './upstream.mjs'
import { SellerRouter } from './router.mjs'
import { PaymentEngine } from './payments.mjs'
import {
  buildAgentManifest,
  buildLlmsTxt,
  buildOpenApiSpec,
  renderDashboardHtml,
} from './docs.mjs'

/**
 * Create a complete, stateless Switch402 HTTP/SSE + WebSocket server instance.
 */
export function createSwitchServer(opts = {}) {
  const publicOrigin = (
    opts.publicOrigin ||
    process.env.PUBLIC_ORIGIN ||
    `http://localhost:${opts.port || process.env.PORT || 4020}`
  ).replace(/\/+$/, '')

  const ledger = new NanoLedger({
    dataDir: opts.dataDir ?? process.env.DATA_DIR ?? null,
    platformFeeBps: Number(opts.platformFeeBps ?? process.env.PLATFORM_FEE_BPS ?? 500),
    referrerShareBps: Number(opts.referrerShareBps ?? process.env.REFERRER_SHARE_BPS ?? 1500),
    houseMarginBps: Number(opts.houseMarginBps ?? process.env.HOUSE_MARGIN_BPS ?? 1000),
    earnedBondTargetNano: usdToNano(
      String(opts.earnedBondUsd ?? process.env.EARNED_BOND_USD ?? '2.00')
    ),
  })

  const house = new HouseUpstream({
    upstreamUrl: opts.upstreamUrl ?? process.env.HOUSE_UPSTREAM_URL ?? '',
    upstreamKey: opts.upstreamKey ?? process.env.HOUSE_UPSTREAM_KEY ?? '',
    modelPricePerMillionUsd: opts.modelPricePerMillionUsd,
  })

  const router = new SellerRouter({
    ledger,
    house,
    ttftTimeoutMs: Number(opts.ttftTimeoutMs ?? process.env.TTFT_TIMEOUT_MS ?? 1500),
    canarySampleRate: Number(opts.canarySampleRate ?? process.env.CANARY_SAMPLE_RATE ?? 0.01),
  })

  // Security: NEVER fallback to a hardcoded webhook secret; empty string disables webhooks safely!
  const payments = new PaymentEngine({
    ledger,
    publicOrigin,
    payToEvm: opts.payToEvm ?? process.env.PAYTO_EVM,
    usdcBaseAddress: opts.usdcBaseAddress ?? process.env.USDC_BASE_ADDRESS,
    facilitatorUrl: opts.facilitatorUrl ?? process.env.X402_FACILITATOR_URL,
    customX402Verifier: opts.customX402Verifier ?? null,
    customPayoutExecutor: opts.customPayoutExecutor ?? null,
    coinosApiUrl: opts.coinosApiUrl ?? process.env.COINOS_API_URL,
    coinosApiToken: opts.coinosApiToken ?? process.env.COINOS_API_TOKEN,
    webhookSecret: opts.webhookSecret ?? process.env.COINOS_WEBHOOK_SECRET ?? '',
    maxHourlyWithdrawNano: usdToNano(
      String(opts.maxHourlyWithdrawUsd ?? process.env.MAX_HOURLY_WITHDRAW_USD ?? '100.00')
    ),
  })

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, { ledger, house, router, payments, publicOrigin }).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err.message || 'Internal server error' })
      } else if (!res.writableEnded) {
        res.end()
      }
    })
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname !== '/ws/worker') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const ws = acceptWebSocketUpgrade(req, socket, head)
    if (ws) router.handleWorkerConnection(ws)
  })

  return {
    server,
    ledger,
    house,
    router,
    payments,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, 4096, resolve)
      })
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`
      if (!opts.publicOrigin && !process.env.PUBLIC_ORIGIN) {
        payments.publicOrigin = url
      }
      return { port: actualPort, url }
    },
    async close() {
      router.close()
      payments.close()
      await new Promise((resolve) => server.close(() => resolve()))
      ledger.close()
    },
  }
}

async function handleHttpRequest(req, res, ctx) {
  const { ledger, router, payments } = ctx
  const origin = payments.publicOrigin
  const url = new URL(req.url || '/', origin)
  const pathname = url.pathname
  const method = (req.method || 'GET').toUpperCase()

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, X-Webhook-Signature, X-Max-Price-Usd'
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 1. Discovery, Telemetry & Dashboard Routes
  if (method === 'GET' && pathname === '/') {
    const market = router.getMarketSnapshot()
    const summary = ledger.summary()
    const accept = String(req.headers.accept || '')
    if (accept.includes('text/html')) {
      const html = renderDashboardHtml(origin, market, summary, ledger.recentReceipts)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    sendJson(res, 200, {
      service: 'Switch402',
      status: 'live',
      docs: `${origin}/llms.txt`,
      openapi: `${origin}/openapi.json`,
      workerWs: `${origin.replace(/^http/, 'ws')}/ws/worker`,
      summary,
      onlineWorkers: market.onlineWorkers,
    })
    return
  }

  if (method === 'GET' && pathname === '/health') {
    const inv = ledger.verifyInvariant()
    sendJson(res, 200, { ok: true, ledgerBalanced: inv.balanced, summary: ledger.summary() })
    return
  }

  if (method === 'GET' && (pathname === '/llms.txt' || pathname === '/skill.md')) {
    const text = buildLlmsTxt(origin, payments.payToEvm)
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(text)
    return
  }

  if (method === 'GET' && pathname === '/.well-known/agent.json') {
    sendJson(res, 200, buildAgentManifest(origin, payments.payToEvm))
    return
  }

  if (method === 'GET' && pathname === '/.well-known/x402') {
    const snap = router.getMarketSnapshot()
    const resources = snap.houseFallbackBook
      .filter((x) => x.kind === 'act')
      .map((x) => `${origin}/v1/act/${x.skill}`)
    sendJson(res, 200, {
      x402Version: 2,
      openapi: `${origin}/openapi.json`,
      facilitator: payments.facilitatorUrl,
      payTo: payments.payToEvm,
      network: 'eip155:8453',
      resources,
    })
    return
  }

  if (method === 'GET' && pathname === '/openapi.json') {
    sendJson(res, 200, buildOpenApiSpec(origin, router.getMarketSnapshot()))
    return
  }

  if (method === 'GET' && pathname === '/v1/market') {
    sendJson(res, 200, {
      ...router.getMarketSnapshot(),
      ledger: ledger.summary(),
    })
    return
  }

  if (method === 'GET' && pathname === '/v1/models') {
    const snap = router.getMarketSnapshot()
    const modelSet = new Set()
    for (const p of snap.p2pBook) {
      if (p.capability.startsWith('llm:')) modelSet.add(p.capability.slice(4))
    }
    for (const h of snap.houseFallbackBook) {
      if (h.capability.startsWith('llm:')) modelSet.add(h.capability.slice(4))
    }
    sendJson(res, 200, {
      object: 'list',
      data: Array.from(modelSet).map((id) => ({
        id,
        object: 'model',
        created: 1735689600,
        owned_by: 'switch402-grid',
      })),
    })
    return
  }

  // 2. Agent Registration & Account Routes
  if (method === 'POST' && pathname === '/v1/agents/register') {
    const body = await readJsonBody(req)
    const ref = url.searchParams.get('ref') || body.referredBy || null
    try {
      const reg = ledger.registerAgent({
        name: body.name,
        publicJwk: body.publicJwk || null,
        referredBy: ref,
        evmAddress: body.evmAddress || null,
        lightningAddress: body.lightningAddress || null,
      })
      sendJson(res, 201, {
        ...reg,
        openaiBaseUrl: `${origin}/v1`,
        workerWsUrl: `${origin.replace(/^http/, 'ws')}/ws/worker`,
      })
    } catch (err) {
      sendJson(res, 400, { error: err.message })
    }
    return
  }

  if (method === 'GET' && pathname === '/v1/agents/me') {
    const agent = authenticateBearer(req, ledger)
    if (!agent) {
      sendJson(res, 401, { error: 'Missing or invalid Authorization: Bearer <ag_live_key>' })
      return
    }
    sendJson(res, 200, ledger.serializeAccount(agent.id))
    return
  }

  // 3. Wallet Deposit, Top-Up & Withdrawal Routes
  if (method === 'POST' && pathname === '/v1/wallet/topup/x402') {
    const agent = authenticateBearer(req, ledger)
    if (!agent) {
      sendJson(res, 401, {
        error: 'Pass Authorization: Bearer <ag_live_key> to top up your account',
      })
      return
    }
    const amountUsd = url.searchParams.get('amountUsd') || '1.00'
    let requiredNano
    try {
      requiredNano = usdToNano(amountUsd)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
      return
    }
    if (requiredNano < 1_000n) {
      sendJson(res, 400, { error: 'Minimum x402 topup is $0.000001 USD (1 USDC atomic unit)' })
      return
    }

    const challenge = payments.buildX402Challenge({
      pathAndQuery: pathname + url.search,
      name: 'switch402-wallet-topup',
      method: 'POST',
      description: `Prepaid top-up of $${amountUsd} USD into Switch402 balance`,
      requiredNano,
    })

    const sig = req.headers['payment-signature'] || req.headers['x-payment']
    if (!sig) {
      sendJson(res, 402, challenge.body, challenge.headers)
      return
    }

    const credit = await payments.verifyAndCreditX402({
      paymentHeader: String(sig),
      challengePayload: challenge.body,
      targetAgentId: agent.id,
    })
    if (!credit.ok) {
      sendJson(res, 402, { error: credit.error }, challenge.headers)
      return
    }
    sendJson(res, 200, {
      ok: true,
      creditedUsd: credit.creditedUsd,
      txId: credit.txId,
      account: ledger.serializeAccount(agent.id),
    })
    return
  }

  if (method === 'POST' && pathname === '/v1/wallet/deposit/lightning') {
    const agent = authenticateBearer(req, ledger)
    if (!agent) {
      sendJson(res, 401, { error: 'Missing or invalid Authorization: Bearer <ag_live_key>' })
      return
    }
    const body = await readJsonBody(req)
    try {
      const inv = await payments.createLightningDeposit({
        agentId: agent.id,
        amountUsd: body.amountUsd ?? 1.0,
      })
      sendJson(res, 201, inv)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
    }
    return
  }

  if (method === 'POST' && pathname === '/v1/webhooks/lightning') {
    const rawBuf = await readRawBody(req)
    let payload
    try {
      payload = JSON.parse(rawBuf.toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return
    }
    try {
      const result = payments.handleLightningWebhook({
        rawBody: rawBuf,
        signatureHeader: req.headers['x-webhook-signature'] || '',
        payload,
      })
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, err.statusCode || 401, { error: err.message })
    }
    return
  }

  if (method === 'POST' && pathname === '/v1/wallet/withdraw') {
    const agent = authenticateBearer(req, ledger)
    if (!agent) {
      sendJson(res, 401, { error: 'Missing or invalid Authorization: Bearer <ag_live_key>' })
      return
    }
    const body = await readJsonBody(req)
    try {
      const wd = await payments.processWithdrawal({
        agent,
        amountUsd: body.amountUsd,
        rail: body.rail || 'lightning',
        destination: body.destination,
        authProof: body.authProof || null,
      })
      sendJson(res, 200, wd)
    } catch (err) {
      sendJson(res, 400, { error: err.message })
    }
    return
  }

  // 4. OpenAI-Compatible Inference Endpoint (`POST /v1/chat/completions`)
  if (method === 'POST' && pathname === '/v1/chat/completions') {
    const body = await readJsonBody(req)
    const model = String(body.model || 'switch402/instant-test')
    const capability = `llm:${model}`
    const reserveNano = router.estimateBuyerReserveNano(capability, body)

    const authResult = await resolveBuyerAndReserve({
      req,
      res,
      ledger,
      payments,
      pathAndQuery: pathname + url.search,
      capabilityName: `chat_${model}`,
      method: 'POST',
      reserveNano,
    })
    if (!authResult) return

    const { buyerId, reservationId, isKeylessOmnibus } = authResult
    const isStream = Boolean(body.stream)
    const abortCtrl = createResponseAbortController(res)

    try {
      if (isStream) {
        let headersFlushed = false
        const flushSseHeader = () => {
          if (headersFlushed || res.headersSent) return
          headersFlushed = true
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          })
        }

        const out = await router.routeChat({
          buyerId,
          reservationId,
          model,
          body,
          signal: abortCtrl.signal,
          onSseChunk: (chunk) => {
            if (res.writableEnded || res.destroyed) return
            flushSseHeader()
            res.write(chunk)
          },
        })
        if (!res.writableEnded && !res.destroyed) {
          flushSseHeader()
          res.write(
            `: switch402-receipt=${out.settlement.receiptId} mode=${out.mode} cost_usd=${nanoToUsd(out.settlement.grossNano, 6)}\n\n`
          )
          res.end()
        }
        return out
      }

      const out = await router.routeChat({
        buyerId,
        reservationId,
        model,
        body,
        signal: abortCtrl.signal,
      })
      sendJson(res, 200, out.responseObj, {
        'X-Switch402-Receipt': out.settlement.receiptId,
        'X-Switch402-Mode': out.mode,
        'X-Switch402-Provider': out.provider,
        'X-Switch402-Cost-Usd': nanoToUsd(out.settlement.grossNano, 6),
      })
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 502, { error: { message: err.message, type: 'routing_error' } })
      } else if (!res.writableEnded) {
        res.end()
      }
    } finally {
      if (isKeylessOmnibus) {
        ledger.sweepAccountSpendableToTreasury(buyerId)
      }
    }
    return
  }

  // 5. Universal Atomic Action Endpoint (`POST|GET /v1/act/:skill`)
  if ((method === 'POST' || method === 'GET') && pathname.startsWith('/v1/act/')) {
    const skill = decodeURIComponent(pathname.slice('/v1/act/'.length))
    if (!skill) {
      sendJson(res, 400, { error: 'Missing skill name in /v1/act/:skill' })
      return
    }
    const input =
      method === 'POST'
        ? await readJsonBody(req)
        : Object.fromEntries(url.searchParams.entries())

    const maxPriceUsd = req.headers['x-max-price-usd']
      ? Number(req.headers['x-max-price-usd'])
      : Infinity

    const capability = `act:${skill}`
    const reserveNano = router.estimateBuyerReserveNano(capability, input, maxPriceUsd)

    const authResult = await resolveBuyerAndReserve({
      req,
      res,
      ledger,
      payments,
      pathAndQuery: pathname + url.search,
      capabilityName: skill,
      method,
      reserveNano,
    })
    if (!authResult) return

    const abortCtrl = createResponseAbortController(res)

    try {
      const out = await router.routeAct({
        buyerId: authResult.buyerId,
        reservationId: authResult.reservationId,
        skill,
        input,
        maxPriceUsd,
        signal: abortCtrl.signal,
      })
      sendJson(
        res,
        200,
        {
          ok: true,
          capability,
          mode: out.mode,
          provider: out.provider,
          receiptId: out.settlement.receiptId,
          costUsd: nanoToUsd(out.settlement.grossNano, 6),
          latencyMs: out.latencyMs,
          output: out.output,
        },
        {
          'X-Switch402-Receipt': out.settlement.receiptId,
          'X-Switch402-Mode': out.mode,
          'X-Switch402-Provider': out.provider,
          'X-Switch402-Cost-Usd': nanoToUsd(out.settlement.grossNano, 6),
        }
      )
    } catch (err) {
      sendJson(res, 502, { error: err.message })
    } finally {
      if (authResult.isKeylessOmnibus) {
        ledger.sweepAccountSpendableToTreasury(authResult.buyerId)
      }
    }
    return
  }

  sendJson(res, 404, {
    error: `Unknown route ${method} ${pathname}`,
    docs: `${origin}/llms.txt`,
  })
}

function createResponseAbortController(res) {
  const ctrl = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) ctrl.abort()
  })
  return ctrl
}

/**
 * Resolve Buyer from `Authorization: Bearer` OR keyless `PAYMENT-SIGNATURE` (`x402`).
 */
async function resolveBuyerAndReserve({
  req,
  res,
  ledger,
  payments,
  pathAndQuery,
  capabilityName,
  method,
  reserveNano,
}) {
  // Round x402 challenge up to nearest whole USDC atomic unit (1,000 nanoUSD = $0.000001)
  const challengeNano =
    reserveNano < 1_000n ? 1_000n : ((reserveNano + 999n) / 1000n) * 1000n

  const challenge = payments.buildX402Challenge({
    pathAndQuery,
    name: capabilityName,
    method,
    requiredNano: challengeNano,
  })

  const agent = authenticateBearer(req, ledger)
  if (agent?.banned) {
    sendJson(res, 403, { error: 'Agent account is suspended due to failed canary verification' })
    return null
  }

  const paymentSig = req.headers['payment-signature'] || req.headers['x-payment']

  if (agent && !paymentSig) {
    const reservationId = ledger.reserve(agent.id, reserveNano, 'call')
    if (reservationId) {
      return { buyerId: agent.id, reservationId, isKeylessOmnibus: false }
    }
    sendJson(
      res,
      402,
      {
        ...challenge.body,
        agentId: agent.id,
        spendableUsd: nanoToUsd(agent.spendableNano),
        requiredReserveUsd: nanoToUsd(reserveNano),
      },
      challenge.headers
    )
    return null
  }

  if (paymentSig) {
    const credit = await payments.verifyAndCreditX402({
      paymentHeader: String(paymentSig),
      challengePayload: challenge.body,
      targetAgentId: agent ? agent.id : null,
    })
    if (!credit.ok) {
      sendJson(res, 402, { error: credit.error }, challenge.headers)
      return null
    }
    const reservationId = ledger.reserve(credit.agentId, reserveNano, 'call')
    if (!reservationId) {
      if (credit.isKeylessOmnibus) {
        ledger.sweepAccountSpendableToTreasury(credit.agentId)
      }
      sendJson(
        res,
        402,
        { error: 'Credited x402 amount insufficient for call reserve' },
        challenge.headers
      )
      return null
    }
    return {
      buyerId: credit.agentId,
      reservationId,
      isKeylessOmnibus: credit.isKeylessOmnibus,
    }
  }

  sendJson(res, 402, challenge.body, challenge.headers)
  return null
}

function authenticateBearer(req, ledger) {
  const hdr = String(req.headers.authorization || '')
  if (!hdr.toLowerCase().startsWith('bearer ')) return null
  const token = hdr.slice(7).trim()
  return ledger.getAgentByApiKey(token)
}

async function readRawBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('Request body exceeds 2MB limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody(req) {
  const buf = await readRawBody(req)
  if (buf.length === 0) return {}
  return JSON.parse(buf.toString('utf8'))
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    'utf8'
  )
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    ...extraHeaders,
  })
  res.end(body)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const port = Number(process.env.PORT || 4020)
  const host = process.env.HOST || '0.0.0.0'
  const app = createSwitchServer({
    port,
    dataDir: process.env.DATA_DIR || './data',
  })
  app.listen(port, host).then(({ url }) => {
    console.log(`[Switch402] Live at ${url}`)
    console.log(`[Switch402] Autonomous docs: ${url}/llms.txt`)
    console.log(`[Switch402] Seller WS hub:   ${url.replace(/^http/, 'ws')}/ws/worker`)
  })
}
