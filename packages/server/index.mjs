import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { acceptWebSocketUpgrade, nanoToUsd, usdToNano } from '../protocol/index.mjs'
import { NanoLedger } from './ledger.mjs'
import { HouseUpstream } from './upstream.mjs'
import { SellerRouter } from './router.mjs'
import { PaymentEngine } from './payments.mjs'
import { HeartbeatBuyer } from './heartbeat.mjs'
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
    defaultSandboxCalls: Number(opts.defaultSandboxCalls ?? process.env.SANDBOX_FREE_CALLS ?? 10),
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

  const heartbeat = new HeartbeatBuyer({
    ledger,
    router,
    enabled:
      opts.heartbeatEnabled ??
      (process.env.HEARTBEAT_ENABLED === 'true' || process.env.NODE_ENV === 'production'),
    intervalMs: Number(opts.heartbeatIntervalMs ?? process.env.HEARTBEAT_INTERVAL_MS ?? 300_000),
    dailyBudgetUsd: String(opts.heartbeatDailyUsd ?? process.env.HEARTBEAT_DAILY_USD ?? '0.14'),
  })
  router.onSessionRegistered = (sessionId) => heartbeat.scheduleWelcomePing(sessionId)

  /** @type {Map<string, number[]>} clientIp -> registration timestamps in last hour */
  const regRateLimits = new Map()
  const maxRegistrationsPerIpPerHour = Number(
    opts.maxRegistrationsPerIpPerHour ?? process.env.MAX_REG_PER_IP_HOUR ?? 100
  )

  const server = http.createServer((req, res) => {
    handleHttpRequest(req, res, {
      ledger,
      house,
      router,
      payments,
      heartbeat,
      regRateLimits,
      maxRegistrationsPerIpPerHour,
      publicOrigin,
    }).catch((err) => {
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
    heartbeat,
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
      heartbeat.close()
      router.close()
      payments.close()
      await new Promise((resolve) => server.close(() => resolve()))
      ledger.close()
    },
  }
}

async function handleHttpRequest(req, res, ctx) {
  const { ledger, house, router, payments, heartbeat, regRateLimits, maxRegistrationsPerIpPerHour } = ctx
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
      mcpHttp: `${origin}/mcp`,
      leaderboard: `${origin}/v1/leaderboard`,
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

  if (method === 'GET' && (pathname === '/.well-known/agent.json' || pathname === '/.well-known/agent-card.json')) {
    sendJson(res, 200, buildAgentManifest(origin, payments.payToEvm))
    return
  }

  if (method === 'GET' && pathname === '/v1/leaderboard') {
    sendJson(res, 200, heartbeat.getSnapshot())
    return
  }

  if (method === 'POST' && pathname === '/mcp') {
    await handleRemoteMcp(req, res, { ledger, house, router, payments, heartbeat, origin })
    return
  }

  if (method === 'GET' && pathname === '/.well-known/mcp-registry-auth') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end('v=MCPv1; k=ed25519; p=ujSTzdO+991z3DJAygtAy/THVcu7LkO3zaFhaXs1jW4=')
    return
  }

  if (method === 'GET' && pathname === '/.well-known/x402') {
    const snap = router.getMarketSnapshot()
    const resources = snap.houseFallbackBook
      .filter((x) => x.kind === 'act')
      .map((x) => `${origin}/v1/act/${x.skill}`)
    sendJson(res, 200, {
      x402Version: 2,
      version: 1,
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

  if (method === 'GET' && pathname === '/favicon.ico') {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#080c14"/><text x="32" y="42" font-size="28" text-anchor="middle" fill="#4ade80" font-family="monospace" font-weight="bold">402</text></svg>'
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
    res.end(svg)
    return
  }

  if (method === 'GET' && pathname === '/v1/market') {
    sendJson(res, 200, {
      ...router.getMarketSnapshot(),
      heartbeat: heartbeat.getSnapshot(),
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
    const clientIp =
      String(req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
        .split(',')[0]
        .trim()
    const now = Date.now()
    const recent = (regRateLimits.get(clientIp) || []).filter((ts) => now - ts < 3_600_000)
    if (recent.length >= maxRegistrationsPerIpPerHour) {
      sendJson(res, 429, { error: 'Registration rate limit exceeded for this IP (try again later)' })
      return
    }
    recent.push(now)
    regRateLimits.set(clientIp, recent)

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

  // Discovery probes (x402dash et al.) issue GET — answer with the POST challenge so the
  // endpoint registers as a valid x402 resource instead of a bare 404.
  if (method === 'GET' && pathname === '/v1/chat/completions') {
    const reserveNano = router.estimateBuyerReserveNano('llm:switch402/instant-test', {})
    const challengeNano = reserveNano < 1_000n ? 1_000n : ((reserveNano + 999n) / 1000n) * 1000n
    const challenge = payments.buildX402Challenge({
      pathAndQuery: pathname + url.search,
      name: 'chat_switch402/instant-test',
      method: 'POST',
      requiredNano: challengeNano,
    })
    sendJson(res, 402, challenge.body, challenge.headers)
    return
  }

  // 4. OpenAI-Compatible Inference Endpoint (`POST /v1/chat/completions`)
  if (method === 'POST' && pathname === '/v1/chat/completions') {
    const body = await readJsonBody(req)
    const model = String(body.model || 'switch402/instant-test')
    const capability = `llm:${model}`
    const isStream = Boolean(body.stream)
    const abortCtrl = createResponseAbortController(res)

    // Zero-friction onboarding: 10 free sandbox calls on `switch402/instant-test` per registered agent
    const bearerAgent = authenticateBearer(req, ledger)
    const hasPaymentSig = Boolean(req.headers['payment-signature'] || req.headers['x-payment'])
    if (
      model === 'switch402/instant-test' &&
      bearerAgent &&
      !bearerAgent.banned &&
      !hasPaymentSig &&
      (bearerAgent.sandboxCallsRemaining || 0) > 0
    ) {
      const startedAt = Date.now()
      try {
        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          })
          await house.executeChat(model, body, {
            signal: abortCtrl.signal,
            onSseChunk: (chunk) => {
              if (!res.writableEnded && !res.destroyed) res.write(chunk)
            },
          })
          const sbx = ledger.consumeSandboxCall(bearerAgent.id, capability, Date.now() - startedAt)
          if (!res.writableEnded && !res.destroyed) {
            res.write(
              `: switch402-receipt=${sbx?.receiptId || 'sbx'} mode=sandbox_free cost_usd=0.000000 sandbox_remaining=${sbx?.remainingSandboxCalls ?? 0}\n\n`
            )
            res.end()
          }
          return
        }

        const houseRes = await house.executeChat(model, body, { signal: abortCtrl.signal })
        const sbx = ledger.consumeSandboxCall(bearerAgent.id, capability, Date.now() - startedAt)
        sendJson(res, 200, houseRes.responseObj, {
          'X-Switch402-Receipt': sbx?.receiptId || 'sbx',
          'X-Switch402-Mode': 'sandbox_free',
          'X-Switch402-Provider': 'switch402_sandbox',
          'X-Switch402-Cost-Usd': '0.000000',
          'X-Switch402-Sandbox-Remaining': String(sbx?.remainingSandboxCalls ?? 0),
        })
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 502, { error: { message: err.message, type: 'sandbox_error' } })
        } else if (!res.writableEnded) {
          res.end()
        }
      }
      return
    }

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
        ...(authResult.paymentResponseHeader
          ? { 'PAYMENT-RESPONSE': authResult.paymentResponseHeader }
          : {}),
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
      inputSchema: house.skillMeta?.[skill]?.inputSchema || null,
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
          ...(authResult.paymentResponseHeader
            ? { 'PAYMENT-RESPONSE': authResult.paymentResponseHeader }
            : {}),
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
  inputSchema = null,
}) {
  // Round x402 challenge up to nearest whole USDC atomic unit (1,000 nanoUSD = $0.000001)
  const challengeNano =
    reserveNano < 1_000n ? 1_000n : ((reserveNano + 999n) / 1000n) * 1000n

  const challenge = payments.buildX402Challenge({
    pathAndQuery,
    name: capabilityName,
    method,
    requiredNano: challengeNano,
    inputSchema,
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
      paymentResponseHeader: credit.paymentResponseHeader || null,
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

/**
 * Stateless Remote Streamable HTTP MCP Endpoint (`POST /mcp`).
 * Allows web/remote MCP clients to discover and call Switch402 tools without running `npx`.
 */
async function handleRemoteMcp(req, res, { ledger, house, router, payments, heartbeat, origin }) {
  let msg
  try {
    msg = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  // Notifications have no id -> acknowledge with 202
  if (msg.id === undefined || msg.id === null) {
    res.writeHead(202)
    res.end()
    return
  }

  const tools = [
    {
      name: 'find_capability',
      description:
        'Discover live P2P & House LLM models and atomic JSON capabilities on Switch402 with floor prices and latency.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional keyword filter (e.g. "fetch_markdown", "qwen", "verify")' },
        },
      },
    },
    {
      name: 'describe_capability',
      description: 'Get exact inputSchema, example payload, and live pricing for a specific Switch402 capability.',
      inputSchema: {
        type: 'object',
        properties: { capability: { type: 'string', description: 'Skill or model name (e.g. "web.fetch_markdown")' } },
        required: ['capability'],
      },
    },
    {
      name: 'list_unmet_demand',
      description: 'Inspect capabilities hitting House Fallback so you can spin up a P2P seller worker and keep 95%.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'leaderboard',
      description: 'View live P2P seller speed leaderboard and Heartbeat Benchmark status.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'wallet_status',
      description: 'View your Switch402 balance, free sandbox calls remaining, $2.00 Quality Bond, and referral earnings.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'chat_inference',
      description:
        'Run chat completion on Switch402 (every registered agent gets 10 free sandbox calls on "switch402/instant-test").',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model ID (e.g. "switch402/instant-test", "qwen/qwen3-32b")' },
          prompt: { type: 'string', description: 'User prompt' },
          system: { type: 'string', description: 'Optional system instruction' },
        },
        required: ['model', 'prompt'],
      },
    },
    {
      name: 'act',
      description: 'Execute an atomic JSON capability (e.g. "web.search", "web.fetch_markdown", "chain.token_report", "web.verify_url", "util.sha256").',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill name without act: prefix' },
          input: { type: 'object', description: 'JSON input payload' },
        },
        required: ['skill'],
      },
    },
  ]

  const resources = [
    {
      uri: 'switch402://market',
      name: 'Live Market Orderbook',
      description: 'Live P2P capabilities, House fallback prices, and unmet demand arbitrage feed',
      mimeType: 'application/json',
    },
    {
      uri: 'switch402://leaderboard',
      name: 'P2P Speed Leaderboard',
      description: 'Live latency rankings for P2P Switch402 sellers',
      mimeType: 'application/json',
    },
  ]

  if (msg.method === 'initialize') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'switch402-remote-mcp', version: '0.1.3' },
      },
    })
    return
  }

  if (msg.method === 'ping') {
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }

  if (msg.method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools } })
    return
  }

  if (msg.method === 'resources/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { resources } })
    return
  }

  if (msg.method === 'resources/read') {
    const uri = msg.params?.uri
    if (uri === 'switch402://market') {
      const data = { ...router.getMarketSnapshot(), ledger: ledger.summary() }
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] },
      })
      return
    }
    if (uri === 'switch402://leaderboard') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(heartbeat.getSnapshot(), null, 2) }],
        },
      })
      return
    }
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32602, message: `Unknown resource URI: ${uri}` },
    })
    return
  }

  if (msg.method === 'tools/call') {
    const toolName = msg.params?.name
    const toolArgs = msg.params?.arguments || {}
    const snap = router.getMarketSnapshot()
    const agent = authenticateBearer(req, ledger)

    const okResult = (obj) =>
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] },
      })

    try {
      if (toolName === 'find_capability') {
        const q = String(toolArgs.query || '').toLowerCase().trim()
        const match = (item) =>
          !q ||
          item.capability.toLowerCase().includes(q) ||
          String(item.description || '').toLowerCase().includes(q)
        return okResult({
          onlineWorkers: snap.onlineWorkers,
          p2pCapabilities: snap.p2pBook.filter(match),
          houseCapabilities: snap.houseFallbackBook.filter(match),
        })
      }

      if (toolName === 'describe_capability') {
        const target = String(toolArgs.capability || '').trim()
        const all = [...snap.p2pBook, ...snap.houseFallbackBook]
        const found = all.find(
          (x) => x.capability === target || x.skill === target || x.model === target || x.capability === `act:${target}` || x.capability === `llm:${target}`
        )
        return okResult(
          found || {
            error: `Capability "${target}" not found`,
            available: all.map((x) => x.capability),
          }
        )
      }

      if (toolName === 'list_unmet_demand') {
        return okResult({
          unmetDemandFeed: snap.unmetDemandFeed,
          tip: `Run \`npx switch402 serve --server ${origin} --model <id> --price <suggestedUndercutUsd>\` to earn 95%.`,
        })
      }

      if (toolName === 'leaderboard') {
        return okResult(heartbeat.getSnapshot())
      }

      if (toolName === 'wallet_status') {
        if (!agent) {
          return okResult({
            authenticated: false,
            hint: `Pass Authorization: Bearer <ag_live_key> or register free (includes 10 free sandbox calls) via POST ${origin}/v1/agents/register`,
          })
        }
        return okResult(ledger.serializeAccount(agent.id))
      }

      if (toolName === 'chat_inference') {
        if (!agent) {
          return okResult({
            error: 'Authentication required',
            hint: `Register keyless via POST ${origin}/v1/agents/register (includes 10 free calls on switch402/instant-test) and pass Authorization: Bearer <ag_live_key>.`,
          })
        }
        const model = String(toolArgs.model || 'switch402/instant-test')
        const messages = []
        if (toolArgs.system) messages.push({ role: 'system', content: String(toolArgs.system) })
        messages.push({ role: 'user', content: String(toolArgs.prompt || '') })
        const body = { model, messages, stream: false }

        if (model === 'switch402/instant-test' && !agent.banned && (agent.sandboxCallsRemaining || 0) > 0) {
          const startedAt = Date.now()
          const houseRes = await house.executeChat(model, body)
          const sbx = ledger.consumeSandboxCall(agent.id, `llm:${model}`, Date.now() - startedAt)
          return okResult({
            mode: 'sandbox_free',
            receiptId: sbx?.receiptId,
            costUsd: '0.000000',
            sandboxCallsRemaining: sbx?.remainingSandboxCalls ?? 0,
            reply: houseRes.responseObj?.choices?.[0]?.message?.content ?? houseRes.responseObj,
          })
        }

        const reserveNano = router.estimateBuyerReserveNano(`llm:${model}`, body)
        const reservationId = ledger.reserve(agent.id, reserveNano, 'call')
        if (!reservationId) {
          return okResult({
            error: 'Payment required (insufficient balance)',
            spendableUsd: nanoToUsd(agent.spendableNano),
            requiredReserveUsd: nanoToUsd(reserveNano),
            topupOptions: {
              x402: `POST ${origin}/v1/wallet/topup/x402?amountUsd=1.00`,
              lightning: `POST ${origin}/v1/wallet/deposit/lightning`,
              earnFree: `npx switch402 serve --server ${origin} --auto-ollama`,
            },
          })
        }
        const out = await router.routeChat({ buyerId: agent.id, reservationId, model, body })
        return okResult({
          mode: out.mode,
          receiptId: out.settlement.receiptId,
          costUsd: nanoToUsd(out.settlement.grossNano, 6),
          reply: out.responseObj?.choices?.[0]?.message?.content ?? out.responseObj,
        })
      }

      if (toolName === 'act') {
        if (!agent) {
          return okResult({
            error: 'Authentication required',
            hint: `Register keyless via POST ${origin}/v1/agents/register or call POST ${origin}/v1/act/${encodeURIComponent(String(toolArgs.skill || ''))} with x402 PAYMENT-SIGNATURE.`,
          })
        }
        const skill = String(toolArgs.skill || '').replace(/^act:/, '')
        const input = toolArgs.input || {}
        const reserveNano = router.estimateBuyerReserveNano(`act:${skill}`, input)
        const reservationId = ledger.reserve(agent.id, reserveNano, 'call')
        if (!reservationId) {
          return okResult({
            error: 'Payment required (insufficient balance)',
            spendableUsd: nanoToUsd(agent.spendableNano),
            requiredReserveUsd: nanoToUsd(reserveNano),
            topupOptions: {
              x402: `POST ${origin}/v1/wallet/topup/x402?amountUsd=1.00`,
              lightning: `POST ${origin}/v1/wallet/deposit/lightning`,
              earnFree: `npx switch402 serve --server ${origin} --auto-ollama`,
            },
          })
        }
        const out = await router.routeAct({ buyerId: agent.id, reservationId, skill, input })
        return okResult({
          ok: true,
          mode: out.mode,
          receiptId: out.settlement.receiptId,
          costUsd: nanoToUsd(out.settlement.grossNano, 6),
          output: out.output,
        })
      }

      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      })
    } catch (err) {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        result: { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] },
      })
    }
    return
  }

  sendJson(res, 200, {
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  })
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
    console.log(`[Switch402] Remote MCP HTTP: ${url}/mcp`)
    console.log(`[Switch402] Seller WS hub:   ${url.replace(/^http/, 'ws')}/ws/worker`)
  })

  let shuttingDown = false
  const shutdown = async (sig) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[Switch402] Received ${sig}, compacting WAL and closing cleanly...`)
    try {
      app.ledger.compactSnapshot()
    } catch {
      // ignore compaction errors during shutdown
    }
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
