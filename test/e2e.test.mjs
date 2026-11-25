import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  canonicalAuthMessage,
  generateAgentIdentity,
  sha256Hex,
  signEd25519,
  usdToNano,
  verifyEd25519,
} from '../packages/protocol/index.mjs'
import { createSwitchServer } from '../packages/server/index.mjs'
import { SwitchWorker } from '../packages/cli/worker.mjs'
import {
  parseDuckDuckGoLiteResults,
  buildTokenReport,
  computeTradeSignalFromCandles,
  normalizeMarketSymbol,
  canonicalJsonString,
} from '../packages/server/upstream.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MCP_BIN = path.join(__dirname, '..', 'packages', 'mcp', 'mcp-server.mjs')

test('1. Nano-USD double-entry math, 15% referral share, and $2.00 Earned Quality Bond lock', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw402-t1-'))
  const app = createSwitchServer({ dataDir: tmpDir, earnedBondUsd: '2.00' })
  const { url } = await app.listen(0)

  try {
    // Register Referrer, Buyer (referred by Referrer), and Seller
    const refRes = await postJson(`${url}/v1/agents/register`, { name: 'referrer-bot' })
    const buyerRes = await postJson(
      `${url}/v1/agents/register?ref=${refRes.body.agentId}`,
      { name: 'buyer-bot' }
    )
    const sellerRes = await postJson(`${url}/v1/agents/register`, { name: 'seller-gpu' })

    assert.equal(buyerRes.body.referredBy, refRes.body.agentId)

    // Fund buyer with $10.00
    app.ledger.deposit({
      agentId: buyerRes.body.agentId,
      amountNano: usdToNano('10.00'),
      txId: 'seed-buyer-10',
    })

    // Connect Seller Worker offering `act:custom.echo` at $1.00/call so 3 calls cross the $2.00 Earned Bond threshold
    const worker = new SwitchWorker({
      serverUrl: url,
      apiKey: sellerRes.body.apiKey,
      autoReconnect: false,
      capabilities: [
        {
          capability: 'act:custom.echo',
          pricePerCallUsd: '1.00',
          description: 'High-value custom echo skill',
        },
      ],
      handlers: {
        'act:custom.echo': async (input) => ({ echoed: input.msg }),
      },
    })
    await worker.start()

    // Call #1 ($1.00 gross -> Seller gets $0.95 -> 100% locked in Earned Bond, $0.00 spendable)
    const call1 = await postJson(
      `${url}/v1/act/custom.echo`,
      { msg: 'alpha' },
      { Authorization: `Bearer ${buyerRes.body.apiKey}` }
    )
    assert.equal(call1.status, 200)
    assert.equal(call1.body.mode, 'p2p')
    assert.deepEqual(call1.body.output, { echoed: 'alpha' })

    const sellerAfter1 = app.ledger.serializeAccount(sellerRes.body.agentId)
    assert.equal(sellerAfter1.bondedUsd, '0.950000')
    assert.equal(sellerAfter1.spendableUsd, '0.000000')
    assert.equal(sellerAfter1.bondComplete, false)

    // Seller tries to withdraw before completing $2.00 bond -> MUST be blocked!
    const earlyWd = await postJson(
      `${url}/v1/wallet/withdraw`,
      { amountUsd: '0.10', rail: 'lightning', destination: 'seller@coinos.io' },
      { Authorization: `Bearer ${sellerRes.body.apiKey}` }
    )
    assert.equal(earlyWd.status, 400)
    assert.match(earlyWd.body.error, /Quality Bond incomplete/)

    // Call #2 & Call #3 ($2.00 more gross -> Seller cumulative net = $2.85 -> $2.00 bonded + $0.85 spendable!)
    await postJson(
      `${url}/v1/act/custom.echo`,
      { msg: 'beta' },
      { Authorization: `Bearer ${buyerRes.body.apiKey}` }
    )
    await postJson(
      `${url}/v1/act/custom.echo`,
      { msg: 'gamma' },
      { Authorization: `Bearer ${buyerRes.body.apiKey}` }
    )

    const sellerAfter3 = app.ledger.serializeAccount(sellerRes.body.agentId)
    assert.equal(sellerAfter3.bondedUsd, '2.000000')
    assert.equal(sellerAfter3.spendableUsd, '0.850000')
    assert.equal(sellerAfter3.bondComplete, true)

    // Check Referrer earned exact 15% of the 5% fee across $3.00 volume = 0.75% of $3.00 = $0.022500!
    const refAcct = app.ledger.serializeAccount(refRes.body.agentId)
    assert.equal(refAcct.stats.referralEarnedUsd, '0.022500')

    // Earn-to-Spend: Seller immediately spends its $0.85 earned balance as a Buyer on House `util.sha256` with 0 gas!
    const sellerBuys = await postJson(
      `${url}/v1/act/util.sha256`,
      { text: 'earn-to-spend' },
      { Authorization: `Bearer ${sellerRes.body.apiKey}` }
    )
    assert.equal(sellerBuys.status, 200)
    assert.equal(sellerBuys.body.mode, 'house_fallback')
    assert.equal(sellerBuys.body.output.bytes, 13)

    assert.equal(app.ledger.verifyInvariant().balanced, true)
    worker.stop()
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('2. Real-time SSE token streaming, TTFT auto-failover, and 1% Canary Slashing', async () => {
  const app = createSwitchServer({
    ttftTimeoutMs: 120,
    canarySampleRate: 0, // trigger canary deterministically in test
    earnedBondUsd: '2.00',
  })
  const { url } = await app.listen(0)

  try {
    const buyer = (await postJson(`${url}/v1/agents/register`, { name: 'buyer' })).body
    const slowSeller = (await postJson(`${url}/v1/agents/register`, { name: 'slow-node' })).body
    const fastSeller = (await postJson(`${url}/v1/agents/register`, { name: 'fast-node' })).body
    const spoofer = (await postJson(`${url}/v1/agents/register`, { name: 'spoof-node' })).body

    app.ledger.deposit({
      agentId: buyer.agentId,
      amountNano: usdToNano('5.00'),
      txId: 'fund-buyer-5',
    })

    // Slow seller advertises slightly cheaper price ($0.08/1M) so it ranks #1 initially, EXCEPT it stalls 800ms (>120ms TTFT)!
    let slowCancelled = false
    const slowWorker = new SwitchWorker({
      serverUrl: url,
      apiKey: slowSeller.apiKey,
      autoReconnect: false,
      capabilities: [{ capability: 'llm:qwen/qwen3-32b', pricePer1MUsd: '0.08' }],
      handlers: {
        'llm:qwen/qwen3-32b': async (_payload, { signal }) => {
          signal.addEventListener('abort', () => {
            slowCancelled = true
          })
          await new Promise((r) => setTimeout(r, 800))
          return { choices: [{ message: { role: 'assistant', content: 'too late' } }] }
        },
      },
    })
    await slowWorker.start()

    // Fast seller advertises $0.12/1M and streams SSE tokens in 5ms
    const fastWorker = new SwitchWorker({
      serverUrl: url,
      apiKey: fastSeller.apiKey,
      autoReconnect: false,
      capabilities: [{ capability: 'llm:qwen/qwen3-32b', pricePer1MUsd: '0.12' }],
      handlers: {
        'llm:qwen/qwen3-32b': async (payload, { stream, sendChunk }) => {
          const prompt = payload.messages?.[0]?.content || ''
          const mathMatch = prompt.match(/Compute (\d+) \* (\d+)/)
          const answer = mathMatch
            ? String(Number(mathMatch[1]) * Number(mathMatch[2]))
            : 'Fast P2P stream works!'
          if (stream) {
            for (const tok of answer.split(' ')) {
              sendChunk(
                `data: ${JSON.stringify({
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { content: `${tok} ` } }],
                })}\n\n`
              )
            }
            sendChunk('data: [DONE]\n\n')
            return { usage: { totalTokens: 40 } }
          }
          return {
            choices: [{ index: 0, message: { role: 'assistant', content: answer } }],
            usage: { total_tokens: 40 },
          }
        },
      },
    })
    await fastWorker.start()

    // Streaming SSE request: SlowWorker times out at 120ms -> Router transparently fails over to FastWorker -> Buyer gets 200 SSE!
    const sseResp = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${buyer.apiKey}`,
      },
      body: JSON.stringify({
        model: 'qwen/qwen3-32b',
        stream: true,
        messages: [{ role: 'user', content: 'Hello grid' }],
      }),
    })
    assert.equal(sseResp.status, 200)
    const sseText = await sseResp.text()
    assert.match(sseText, /Fast/)
    assert.match(sseText, /\[DONE\]/)
    assert.match(sseText, /switch402-receipt=/)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(slowCancelled, true, 'Slow worker should receive JOB_CANCEL abort')

    // Verify FastWorker passes canary check cleanly
    const goodCanary = await app.router.runCanaryProbe(fastWorker.sessionId, 'llm:qwen/qwen3-32b')
    assert.equal(goodCanary.passed, true)

    // Now test Spoofer: give Spoofer $1.20 of Earned Quality Bond via a valid job first, then catch it spoofing a canary!
    const spoofWorker = new SwitchWorker({
      serverUrl: url,
      apiKey: spoofer.apiKey,
      autoReconnect: false,
      capabilities: [
        { capability: 'act:seed.bond', pricePerCallUsd: '1.25' },
        { capability: 'llm:claude-spoof', pricePer1MUsd: '0.50' },
      ],
      handlers: {
        'act:seed.bond': async () => ({ ok: true }),
        'llm:claude-spoof': async () => ({
          choices: [{ index: 0, message: { role: 'assistant', content: 'gibberish wrong answer 42' } }],
        }),
      },
    })
    let slashedEvent = null
    spoofWorker.on('slashed', (ev) => {
      slashedEvent = ev
    })
    await spoofWorker.start()

    // Spoofer serves 1 valid skill call -> builds $1.1875 ($1.25 * 95%) in bondedNano
    await postJson(
      `${url}/v1/act/seed.bond`,
      {},
      { Authorization: `Bearer ${buyer.apiKey}` }
    )
    assert.equal(app.ledger.serializeAccount(spoofer.agentId).bondedUsd, '1.187500')

    // Router runs stealth canary on `llm:claude-spoof` -> catches wrong math -> SLASHES entire $1.1875 bond into Treasury!
    const badCanary = await app.router.runCanaryProbe(spoofWorker.sessionId, 'llm:claude-spoof')
    assert.equal(badCanary.passed, false)
    assert.equal(badCanary.slashed, true)

    await new Promise((r) => setTimeout(r, 60))
    assert.ok(slashedEvent, 'Worker should receive SLASHED notification before disconnect')
    const spooferAfter = app.ledger.serializeAccount(spoofer.agentId)
    assert.equal(spooferAfter.bondedUsd, '0.000000')
    assert.equal(spooferAfter.stats.slashedCount, 1)
    assert.equal(app.ledger.verifyInvariant().balanced, true)

    slowWorker.stop()
    fastWorker.stop()
    spoofWorker.stop()
  } finally {
    await app.close()
  }
})

test('3. Multi-rail payments: x402 v2 keyless call, replay block, Lightning HMAC webhook & Ed25519 withdrawal', async () => {
  const webhookSecret = 'super-secret-ln-hmac'
  const app = createSwitchServer({
    webhookSecret,
    customX402Verifier: async (sig, reqObj) => {
      if (sig.startsWith('valid_sig_')) {
        return { isValid: true, txHash: `0xtx_${sig}`, amount: reqObj.amount }
      }
      return { isValid: false, invalidReason: 'bad signature' }
    },
    customPayoutExecutor: async () => ({ txId: 'ln_mock_tx_1' }),
  })
  const { url } = await app.listen(0)

  try {
    // 3A. Unauthenticated call returns x402 v2 402 challenge + PAYMENT-REQUIRED header + Bazaar schema
    const unauth = await fetch(`${url}/v1/act/util.sha256`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x402-magic' }),
    })
    assert.equal(unauth.status, 402)
    const payHeaderB64 = unauth.headers.get('payment-required')
    assert.ok(payHeaderB64, 'Missing PAYMENT-REQUIRED header')
    const decodedChallenge = JSON.parse(Buffer.from(payHeaderB64, 'base64').toString('utf8'))
    assert.equal(decodedChallenge.x402Version, 2)
    assert.equal(decodedChallenge.accepts[0].network, 'eip155:8453')
    assert.ok(decodedChallenge.extensions?.bazaar?.schema?.properties?.input)

    // 3B. Keyless caller pays per-call with PAYMENT-SIGNATURE -> 200 OK!
    const paidOnce = await fetch(`${url}/v1/act/util.sha256`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': 'valid_sig_001',
      },
      body: JSON.stringify({ text: 'x402-magic' }),
    })
    assert.equal(paidOnce.status, 200)
    const paidJson = await paidOnce.json()
    assert.equal(paidJson.output.sha256, sha256Hex('x402-magic'))

    // 3C. Replaying the exact same PAYMENT-SIGNATURE is rejected (402 Replay detected)
    const replay = await fetch(`${url}/v1/act/util.sha256`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': 'valid_sig_001',
      },
      body: JSON.stringify({ text: 'x402-magic' }),
    })
    assert.equal(replay.status, 402)

    // 3D. Register Ed25519-bound agent, deposit via Lightning HMAC webhook, and test signed withdrawal
    const id = generateAgentIdentity()
    const reg = (
      await postJson(`${url}/v1/agents/register`, {
        name: 'secure-agent',
        publicJwk: id.publicJwk,
      })
    ).body

    const inv = (
      await postJson(
        `${url}/v1/wallet/deposit/lightning`,
        { amountUsd: 5.0 },
        { Authorization: `Bearer ${reg.apiKey}` }
      )
    ).body
    assert.ok(inv.invoiceId.startsWith('lninv_'))

    const webhookBody = JSON.stringify({
      invoiceId: inv.invoiceId,
      paymentHash: 'lnhash_abc123',
    })
    // Forged HMAC must fail with 401
    const badHook = await fetch(`${url}/v1/webhooks/lightning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': 'deadbeef',
      },
      body: webhookBody,
    })
    assert.equal(badHook.status, 401)

    // Valid HMAC credits $5.00
    const goodHmac = createHmac('sha256', webhookSecret).update(webhookBody).digest('hex')
    const goodHook = await fetch(`${url}/v1/webhooks/lightning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': goodHmac,
      },
      body: webhookBody,
    })
    assert.equal(goodHook.status, 200)

    // Unsigned withdrawal must fail because agent bound an Ed25519 publicJwk!
    const unsignedWd = await postJson(
      `${url}/v1/wallet/withdraw`,
      { amountUsd: '2.00', rail: 'lightning', destination: 'alice@coinos.io' },
      { Authorization: `Bearer ${reg.apiKey}` }
    )
    assert.equal(unsignedWd.status, 400)
    assert.match(unsignedWd.body.error, /requires authProof/)

    // Signed withdrawal succeeds, and replay of same nonce fails
    const ts = Math.floor(Date.now() / 1000)
    const nonce = 'unique-wd-nonce-1'
    const payloadHash = sha256Hex('2.00|lightning|alice@coinos.io')
    const canonical = canonicalAuthMessage({
      action: 'withdraw',
      agentId: reg.agentId,
      timestamp: ts,
      nonce,
      payloadHash,
    })
    const signature = signEd25519(id.privateJwk, canonical)

    const signedWd = await postJson(
      `${url}/v1/wallet/withdraw`,
      {
        amountUsd: '2.00',
        rail: 'lightning',
        destination: 'alice@coinos.io',
        authProof: { timestamp: ts, nonce, signature },
      },
      { Authorization: `Bearer ${reg.apiKey}` }
    )
    assert.equal(signedWd.status, 200)
    assert.equal(signedWd.body.remainingSpendableUsd, '3.000000')

    const replayWd = await postJson(
      `${url}/v1/wallet/withdraw`,
      {
        amountUsd: '1.00',
        rail: 'lightning',
        destination: 'alice@coinos.io',
        authProof: { timestamp: ts, nonce, signature },
      },
      { Authorization: `Bearer ${reg.apiKey}` }
    )
    assert.equal(replayWd.status, 400)
    assert.match(replayWd.body.error, /nonce already used/)

    // Verify HTML dashboard & OpenAPI & llms.txt render properly
    const htmlRes = await fetch(url, { headers: { Accept: 'text/html' } })
    assert.equal(htmlRes.status, 200)
    assert.match(await htmlRes.text(), /Live P2P Seller Orderbook/)

    const openApiRes = await fetch(`${url}/openapi.json`)
    const openApi = await openApiRes.json()
    assert.equal(openApi.openapi, '3.1.0')
    assert.ok(openApi.paths['/v1/act/util.sha256'])
    // Discovery surface must advertise the live MCP + registration + x402 routes
    assert.ok(openApi.paths['/mcp'].post)
    assert.ok(openApi.paths['/v1/agents/register'].post)
    assert.ok(openApi.paths['/.well-known/x402'].get)
    assert.ok(openApi.paths['/.well-known/api-catalog'].get)
    const catalog = await (await fetch(`${url}/.well-known/api-catalog`)).json()
    assert.ok(Array.isArray(catalog.linkset) && catalog.linkset[0]['service-desc'])

    assert.equal(app.ledger.verifyInvariant().balanced, true)
  } finally {
    await app.close()
  }
})

test('4. Meta-MCP stdio server full JSON-RPC handshake & live capability execution', async () => {
  const tmpCfg = path.join(os.tmpdir(), `sw402-mcp-${Date.now()}.json`)
  const app = createSwitchServer()
  const { url } = await app.listen(0)

  const preReg = (await postJson(`${url}/v1/agents/register`, { name: 'mcp-host' })).body
  app.ledger.deposit({
    agentId: preReg.agentId,
    amountNano: usdToNano('1.00'),
    txId: 'mcp-seed',
  })

  const child = spawn(
    process.execPath,
    [MCP_BIN, '--server', url, '--key', preReg.apiKey, '--config', tmpCfg],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )

  try {
    const responses = []
    let buf = ''
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const l of lines) {
        if (l.trim()) responses.push(JSON.parse(l))
      }
    })

    const waitForId = async (id) => {
      for (let i = 0; i < 100; i++) {
        const hit = responses.find((r) => r.id === id)
        if (hit) return hit
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error(`Timed out waiting for MCP RPC id=${id}`)
    }

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`
    )
    const initRes = await waitForId(1)
    assert.equal(initRes.result.serverInfo.name, 'switch402-mcp')

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    const listRes = await waitForId(2)
    assert.equal(listRes.result.tools.length, 15)

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'act', arguments: { skill: 'util.sha256', input: { text: 'mcp-rocks' } } },
      })}\n`
    )
    const actRes = await waitForId(3)
    const actPayload = JSON.parse(actRes.result.content[0].text)
    assert.equal(actPayload.ok, true)
    assert.equal(actPayload.output.sha256, sha256Hex('mcp-rocks'))
  } finally {
    child.kill()
    await app.close()
    fs.rmSync(tmpCfg, { force: true })
  }
})

test('5. High-concurrency stress test (500 parallel calls) + WAL snapshot crash recovery', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw402-stress-'))
  let app = createSwitchServer({ dataDir: tmpDir, canarySampleRate: 0.02 })
  const { url } = await app.listen(0)

  try {
    const buyer = (await postJson(`${url}/v1/agents/register`, { name: 'whale-buyer' })).body
    const sellerA = (await postJson(`${url}/v1/agents/register`, { name: 'worker-a' })).body
    const sellerB = (await postJson(`${url}/v1/agents/register`, { name: 'worker-b' })).body

    app.ledger.deposit({
      agentId: buyer.agentId,
      amountNano: usdToNano('25.00'),
      txId: 'stress-deposit-25',
    })

    const makeFastWorker = (apiKey, tag) =>
      new SwitchWorker({
        serverUrl: url,
        apiKey,
        maxConcurrency: 64,
        autoReconnect: false,
        capabilities: [
          {
            capability: 'act:fast.compute',
            pricePerCallUsd: '0.002',
            canaryVector: { input: { x: 7 }, expectedSubset: { sq: 49 } },
          },
        ],
        handlers: {
          'act:fast.compute': async (inp) => ({ sq: Number(inp.x || 0) ** 2, by: tag }),
        },
      })

    const wA = makeFastWorker(sellerA.apiKey, 'A')
    const wB = makeFastWorker(sellerB.apiKey, 'B')
    await Promise.all([wA.start(), wB.start()])

    // Fire 500 concurrent requests (333 P2P over multiplexed WS + 167 House fallback)
    const jobs = []
    for (let i = 0; i < 500; i++) {
      if (i % 3 === 0) {
        jobs.push(
          postJson(
            `${url}/v1/act/util.json_validate`,
            { json: '{"ok":true}' },
            { Authorization: `Bearer ${buyer.apiKey}` }
          )
        )
      } else {
        jobs.push(
          postJson(
            `${url}/v1/act/fast.compute`,
            { x: i },
            { Authorization: `Bearer ${buyer.apiKey}` }
          )
        )
      }
    }

    const results = await Promise.all(jobs)
    const okCount = results.filter((r) => r.status === 200).length
    assert.equal(okCount, 500)

    // Compact snapshot mid-flight, then run 20 more calls into fresh WAL tail
    app.ledger.compactSnapshot()
    for (let i = 0; i < 20; i++) {
      await postJson(
        `${url}/v1/act/fast.compute`,
        { x: i },
        { Authorization: `Bearer ${buyer.apiKey}` }
      )
    }

    const preCloseInv = app.ledger.verifyInvariant()
    assert.equal(preCloseInv.balanced, true)
    assert.equal(preCloseInv.driftNano, 0n)
    const expectedTreasury = app.ledger.treasuryNano
    const expectedCalls = app.ledger.totalSettledCalls

    wA.stop()
    wB.stop()
    await app.close()

    // Reload from disk (snapshot + WAL tail) and verify 0-drift conservation!
    app = createSwitchServer({ dataDir: tmpDir })
    const postReloadInv = app.ledger.verifyInvariant()
    assert.equal(postReloadInv.balanced, true)
    assert.equal(postReloadInv.driftNano, 0n)
    assert.equal(app.ledger.treasuryNano, expectedTreasury)
    assert.equal(app.ledger.totalSettledCalls, expectedCalls)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('6. Adversarial security regressions: token-inflation cap, SSRF block, unconfigured webhook 503, payout rollback & persistent bans', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw402-sec-'))
  let payoutShouldFail = true

  let app = createSwitchServer({
    dataDir: tmpDir,
    canarySampleRate: 0,
    customPayoutExecutor: async () => {
      if (payoutShouldFail) throw new Error('Simulated Coinos upstream outage')
      return { txId: 'ln_payout_ok_1' }
    },
  })
  let { url } = await app.listen(0)

  try {
    // 6A. Default server has NO hardcoded webhook secret -> forged webhook MUST fail with 503!
    const forgedHook = await fetch(`${url}/v1/webhooks/lightning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': createHmac('sha256', 'dev-webhook-secret')
          .update('{"invoiceId":"x"}')
          .digest('hex'),
      },
      body: '{"invoiceId":"x"}',
    })
    assert.equal(forgedHook.status, 503)

    // Register Buyer and Evil Seller (where Buyer referred Evil Seller -> tests 2-wallet wash-rebate block!)
    const buyer = (await postJson(`${url}/v1/agents/register`, { name: 'victim-buyer' })).body
    const evilSeller = (
      await postJson(`${url}/v1/agents/register?ref=${buyer.agentId}`, { name: 'evil-seller' })
    ).body

    app.ledger.deposit({
      agentId: buyer.agentId,
      amountNano: usdToNano('10.00'),
      txId: 'victim-10',
    })

    // 6B. Token-Inflation Attack: Evil Seller claims 999,999,999 tokens at $1.00/1M trying to drain Buyer's $10.00!
    const evilWorker = new SwitchWorker({
      serverUrl: url,
      apiKey: evilSeller.apiKey,
      autoReconnect: false,
      capabilities: [{ capability: 'llm:inflated-model', pricePer1MUsd: '1.00' }],
      handlers: {
        'llm:inflated-model': async () => ({
          choices: [{ index: 0, message: { role: 'assistant', content: 'short' } }],
          usage: { total_tokens: 999_999_999 },
        }),
      },
    })
    await evilWorker.start()

    const chatRes = await postJson(
      `${url}/v1/chat/completions`,
      {
        model: 'inflated-model',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      },
      { Authorization: `Bearer ${buyer.apiKey}` }
    )
    assert.equal(chatRes.status, 200)

    const buyerAcct = app.ledger.serializeAccount(buyer.agentId)
    // Buyer MUST keep > $9.999 (charged ~55 tokens = $0.000055 instead of $999.99!)
    assert.ok(
      Number(buyerAcct.spendableUsd) > 9.999,
      `Expected > 9.999 USD remaining, got ${buyerAcct.spendableUsd}`
    )
    // Wash-rebate blocked: Buyer referred Evil Seller, so Buyer's referral rebate on own purchase MUST be $0!
    assert.equal(buyerAcct.stats.referralEarnedUsd, '0.000000')

    // 6C. SSRF Protection: Cloud metadata, loopback, RFC1918 & IPv4-mapped IPv6 MUST be rejected with $0 charged!
    const beforeSsrfNano = app.ledger.getAgent(buyer.agentId).spendableNano
    for (const badUrl of [
      'http://169.254.169.254/latest/meta-data/',
      `http://127.0.0.1:${new URL(url).port}/health`,
      'http://[::ffff:127.0.0.1]/',
      'http://10.0.0.1/',
      'http://localhost:4020/',
    ]) {
      const ssrfRes = await postJson(
        `${url}/v1/act/web.verify_url`,
        { url: badUrl },
        { Authorization: `Bearer ${buyer.apiKey}` }
      )
      assert.equal(ssrfRes.status, 502)
      assert.match(ssrfRes.body.error, /Blocked|internal|private|reserved/i)
    }
    assert.equal(
      app.ledger.getAgent(buyer.agentId).spendableNano,
      beforeSsrfNano,
      'Failed SSRF calls must refund 100% of buyer reservation'
    )

    // 6D. Two-Phase Withdrawal Rollback: Upstream Coinos outage restores 100% of buyer's spendable balance!
    const failedWd = await postJson(
      `${url}/v1/wallet/withdraw`,
      { amountUsd: '3.00', rail: 'lightning', destination: 'victim@coinos.io' },
      { Authorization: `Bearer ${buyer.apiKey}` }
    )
    assert.equal(failedWd.status, 400)
    assert.match(failedWd.body.error, /Simulated Coinos upstream outage/)
    assert.equal(app.ledger.getAgent(buyer.agentId).spendableNano, beforeSsrfNano)
    assert.equal(app.ledger.getAgent(buyer.agentId).reservedNano, 0n)

    // Now allow payout to succeed -> commits cleanly
    payoutShouldFail = false
    const okWd = await postJson(
      `${url}/v1/wallet/withdraw`,
      { amountUsd: '3.00', rail: 'lightning', destination: 'victim@coinos.io' },
      { Authorization: `Bearer ${buyer.apiKey}` }
    )
    assert.equal(okWd.status, 200)
    assert.equal(okWd.body.externalTxId, 'ln_payout_ok_1')

    // 6E. Persistent Slash Ban Across Server Restart!
    const canaryRes = await app.router.runCanaryProbe(evilWorker.sessionId, 'llm:inflated-model')
    assert.equal(canaryRes.slashed, true)
    evilWorker.stop()
    await app.close()

    // Restart server from disk -> Evil Seller MUST STILL BE BANNED!
    app = createSwitchServer({ dataDir: tmpDir })
    ;({ url } = await app.listen(0))

    assert.equal(app.ledger.serializeAccount(evilSeller.agentId).banned, true)
    const reconnectWorker = new SwitchWorker({
      serverUrl: url,
      apiKey: evilSeller.apiKey,
      autoReconnect: false,
      capabilities: [{ capability: 'llm:inflated-model', pricePer1MUsd: '0.10' }],
    })
    await assert.rejects(() => reconnectWorker.start(), /banned/i)

    assert.equal(app.ledger.verifyInvariant().balanced, true)
  } finally {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('7. Zero-friction onboarding & hardening: 10 free sandbox calls, fail-closed withdraw, remote /mcp, leaderboard & agent-card', async () => {
  const app = createSwitchServer({ heartbeatEnabled: false })
  const { url } = await app.listen(0)

  try {
    // 7A. Freshly registered agent with $0.00 gets 10 free sandbox calls on switch402/instant-test
    const reg = (await postJson(`${url}/v1/agents/register`, { name: 'zero-bal-agent' })).body
    assert.equal(reg.sandboxCallsRemaining, 10)

    for (let i = 1; i <= 9; i++) {
      const r = await postJson(
        `${url}/v1/chat/completions`,
        { model: 'switch402/instant-test', messages: [{ role: 'user', content: `ping ${i}` }] },
        { Authorization: `Bearer ${reg.apiKey}` }
      )
      assert.equal(r.status, 200)
      assert.equal(r.headers['x-switch402-mode'], 'sandbox_free')
      assert.equal(r.headers['x-switch402-cost-usd'], '0.000000')
      assert.equal(r.headers['x-switch402-sandbox-remaining'], String(10 - i))
    }

    // 10th call via SSE streaming also succeeds free
    const sse10 = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${reg.apiKey}`,
      },
      body: JSON.stringify({
        model: 'switch402/instant-test',
        stream: true,
        messages: [{ role: 'user', content: 'final free stream' }],
      }),
    })
    assert.equal(sse10.status, 200)
    const sseText = await sse10.text()
    assert.match(sseText, /mode=sandbox_free/)
    assert.match(sseText, /sandbox_remaining=0/)

    // 11th call MUST hit HTTP 402 Payment Required
    const call11 = await postJson(
      `${url}/v1/chat/completions`,
      { model: 'switch402/instant-test', messages: [{ role: 'user', content: 'over quota' }] },
      { Authorization: `Bearer ${reg.apiKey}` }
    )
    assert.equal(call11.status, 402)

    // 7B. Fail-closed withdrawal when no payout rail is configured (must NOT burn funds!)
    app.ledger.deposit({ agentId: reg.agentId, amountNano: usdToNano('5.00'), txId: 'dep-fc-5' })
    const failWd = await postJson(
      `${url}/v1/wallet/withdraw`,
      { amountUsd: '2.00', rail: 'evm_usdc', destination: '0x1234567890abcdef1234567890abcdef12345678' },
      { Authorization: `Bearer ${reg.apiKey}` }
    )
    assert.equal(failWd.status, 400)
    assert.match(failWd.body.error, /not configured/i)
    assert.equal(app.ledger.serializeAccount(reg.agentId).spendableUsd, '5.000000')
    assert.equal(app.ledger.getAgent(reg.agentId).reservedNano, 0n)

    // 7C. Remote Streamable HTTP MCP (`POST /mcp`) + `/.well-known/agent-card.json` + `/v1/leaderboard`
    const mcpInit = await postJson(`${url}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    assert.equal(mcpInit.status, 200)
    assert.equal(mcpInit.body.result.serverInfo.name, 'switch402-remote-mcp')

    const mcpDesc = await postJson(`${url}/mcp`, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'describe_capability', arguments: { capability: 'web.fetch_markdown' } },
    })
    assert.equal(mcpDesc.status, 200)
    const descObj = JSON.parse(mcpDesc.body.result.content[0].text)
    assert.equal(descObj.capability, 'act:web.fetch_markdown')
    assert.ok(descObj.inputSchema?.properties?.url)

    const cardRes = await fetch(`${url}/.well-known/agent-card.json`)
    assert.equal(cardRes.status, 200)
    const card = await cardRes.json()
    assert.equal(card.sandbox.freeCallsOnRegister, 10)
    assert.equal(card.mcpHttpUrl, `${url}/mcp`)

    const lbRes = await fetch(`${url}/v1/leaderboard`)
    assert.equal(lbRes.status, 200)
    const lb = await lbRes.json()
    assert.ok(Array.isArray(lb.leaders))

    assert.equal(app.ledger.verifyInvariant().balanced, true)
  } finally {
    await app.close()
  }
})

test('8. House skills: web.search + chain.token_report pricing, validation & offline parsers', async () => {
  const app = createSwitchServer({ heartbeatEnabled: false })
  const { url } = await app.listen(0)

  try {
    // 8A. New skills advertised in the House book at real-margin buyer prices
    const market = await (await fetch(`${url}/v1/market`)).json()
    const search = market.houseFallbackBook.find((x) => x.skill === 'web.search')
    const report = market.houseFallbackBook.find((x) => x.skill === 'chain.token_report')
    assert.equal(search.houseBuyerUsd, '0.005500')
    assert.equal(report.houseBuyerUsd, '0.011000')
    assert.equal(search.inputSchema.required[0], 'q')
    assert.equal(report.inputSchema.required[0], 'address')

    // OpenAPI exposes both with the required input as GET query param
    const openApi = await (await fetch(`${url}/openapi.json`)).json()
    assert.equal(openApi.paths['/v1/act/web.search'].get.parameters[0].name, 'q')
    assert.equal(openApi.paths['/v1/act/chain.token_report'].get.parameters[0].name, 'address')

    // 8B. Input validation rejects before touching any upstream — buyer fully refunded
    const buyer = (await postJson(`${url}/v1/agents/register`, { name: 'val-buyer' })).body
    app.ledger.deposit({ agentId: buyer.agentId, amountNano: usdToNano('1.00'), txId: 'val-seed' })
    const spendBefore = app.ledger.getAgent(buyer.agentId).spendableNano

    const badReport = await postJson(
      `${url}/v1/act/chain.token_report`,
      { address: 'not-an-address' },
      { Authorization: `Bearer ${buyer.apiKey}` }
    )
    assert.equal(badReport.status, 502)
    assert.match(badReport.body.error, /requires "address"/)

    const badSearch = await postJson(
      `${url}/v1/act/web.search`,
      { q: '   ' },
      { Authorization: `Bearer ${buyer.apiKey}` }
    )
    assert.equal(badSearch.status, 502)
    assert.match(badSearch.body.error, /requires "q"/)
    assert.equal(app.ledger.getAgent(buyer.agentId).spendableNano, spendBefore)

    // 8C. DuckDuckGo Lite SERP parser
    const fixture = `<table>
      <tr><td><a rel="nofollow" href="https://example.com/one" class='result-link'>First &amp; Result</a></td></tr>
      <tr><td class='result-snippet'>Snippet <b>one</b> here</td></tr>
      <tr><td><a rel="nofollow" href="https://example.com/two" class='result-link'>Second Result</a></td></tr>
      <tr><td class='result-snippet'>Snippet two</td></tr>
    </table>`
    const results = parseDuckDuckGoLiteResults(fixture, 8)
    assert.equal(results.length, 2)
    assert.equal(results[0].title, 'First & Result')
    assert.equal(results[0].url, 'https://example.com/one')
    assert.equal(results[0].snippet, 'Snippet one here')
    assert.equal(results[1].snippet, 'Snippet two')

    // 8D. Token report risk scoring (pure, no network)
    const honeypot = buildTokenReport({
      address: `0x${'a'.repeat(40)}`,
      token: { isContract: true, bytecodeBytes: 9000, name: 'Scam', symbol: 'SCM', decimals: 18, totalSupplyRaw: '1', owner: '0xbeef' },
      market: { listed: true, pairCount: 1, liquidityUsd: 4000, topPairs: [] },
      security: { isHoneypot: true, sellTaxPct: 0.9, top10HolderPct: 0.9, ownerAddress: '0xbeef' },
      sources: [],
    })
    assert.equal(honeypot.riskLevel, 'critical')
    assert.ok(honeypot.flags.some((f) => f.code === 'honeypot_detected'))

    const clean = buildTokenReport({
      address: `0x${'b'.repeat(40)}`,
      token: { isContract: true, bytecodeBytes: 50000, name: 'Good', symbol: 'GOOD', decimals: 6, totalSupplyRaw: '1', owner: null },
      market: { listed: true, pairCount: 3, liquidityUsd: 5_000_000, topPairs: [] },
      security: { isHoneypot: false, sellTaxPct: 0, buyTaxPct: 0, isOpenSource: true, top10HolderPct: 0.1, ownerAddress: null },
      sources: [],
    })
    assert.equal(clean.riskLevel, 'low')
    assert.ok(clean.flags.some((f) => f.code === 'ownership_renounced'))

    const eoa = buildTokenReport({
      address: `0x${'c'.repeat(40)}`,
      token: { isContract: false, bytecodeBytes: 0, name: null, symbol: null, decimals: null, totalSupplyRaw: null, owner: null },
      market: { listed: false, pairCount: 0 },
      security: { scanned: false },
      sources: [],
    })
    assert.ok(eoa.flags.some((f) => f.code === 'not_a_contract'))

    assert.equal(app.ledger.verifyInvariant().balanced, true)
  } finally {
    await app.close()
  }
})

test('9. Usage & monetization engine: sandbox-on-act, Ed25519 public receipts, Coinos pull-verify, x402 pre-guard, trade.signal canary & zero-header remote MCP', async () => {
  // Spin up a local mock Coinos server to verify live Lightning invoice creation + pull-verification
  let coinosPaid = false
  const mockCoinos = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'POST' && req.url === '/invoice') {
      res.end(JSON.stringify({ hash: 'mock_ln_hash_999', text: 'lnbc50n1p_real_coinos_bolt11' }))
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/invoice/')) {
      res.end(
        JSON.stringify({
          hash: 'mock_ln_hash_999',
          confirmed: coinosPaid,
          received: coinosPaid ? 500 : 0,
        })
      )
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise((r) => mockCoinos.listen(0, '127.0.0.1', r))
  const coinosPort = mockCoinos.address().port
  const coinosUrl = `http://127.0.0.1:${coinosPort}`

  const app = createSwitchServer({
    heartbeatEnabled: false,
    coinosApiUrl: coinosUrl,
    coinosApiToken: 'test_coinos_jwt',
    customX402Verifier: async () => {
      throw new Error('x402 verifier MUST NOT be invoked when capability is unavailable!')
    },
  })
  const { url } = await app.listen(0)

  try {
    // 9A. Pure quantitative engine & symbol normalization checks
    assert.deepEqual(normalizeMarketSymbol('eth/usdt'), {
      normalized: 'ETH-USD',
      base: 'ETH',
      quote: 'USD',
      binanceSymbol: 'ETHUSDT',
      coinbaseProduct: 'ETH-USD',
    })
    const upCandles = Array.from({ length: 30 }, (_, i) => 100 + i * 2)
    const upSig = computeTradeSignalFromCandles(upCandles, { symbol: 'ETH-USD', interval: '5m' })
    assert.equal(upSig.symbol, 'ETH-USD')
    assert.ok(upSig.indicators.ema9 > upSig.indicators.ema21)
    assert.equal(canonicalJsonString({ z: 1, a: 2 }), '{"a":2,"z":1}')

    // 9B. Keyless x402 pre-payment guard: calling an unroutable LLM model with PAYMENT-SIGNATURE returns 503 BEFORE settling USDC!
    const unroutableX402 = await postJson(
      `${url}/v1/chat/completions`,
      { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
      { 'PAYMENT-SIGNATURE': 'eyJ4NDAyVmVyc2lvbiI6Mn0=' }
    )
    assert.equal(unroutableX402.status, 503)
    assert.match(unroutableX402.body.error.message, /NOT settled/)

    // 9C. Zero-header Remote MCP (`POST /mcp`): register_agent -> trade_decide (sandbox_free!) -> get_receipt (Ed25519 verified!)
    const mcpReg = await postJson(`${url}/mcp`, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'register_agent', arguments: { name: 'claude-remote-user' } },
    })
    const mcpAgent = JSON.parse(mcpReg.body.result.content[0].text)
    assert.ok(mcpAgent.apiKey.startsWith('ag_live_'))
    assert.equal(mcpAgent.sandboxCallsRemaining, 10)

    const mcpDecide = await postJson(`${url}/mcp`, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'trade_decide',
        arguments: {
          symbol: 'ETH-USD',
          interval: '5m',
          candles: upCandles,
          apiKey: mcpAgent.apiKey,
        },
      },
    })
    const decideObj = JSON.parse(mcpDecide.body.result.content[0].text)
    assert.equal(decideObj.ok, true)
    assert.ok(decideObj.proofReceiptId.startsWith('rcpt_sbx_'))
    assert.equal(decideObj.sandboxCallsRemaining, 8) // consumed 2 free starter calls (trade.signal + trade.notarize)

    // Public GET /v1/receipts/:id verifies Ed25519 signature both server-side and client-side!
    const rcptJson = await (await fetch(decideObj.proofReceiptUrl, { headers: { Accept: 'application/json' } })).json()
    assert.equal(rcptJson.verified, true)
    assert.equal(
      verifyEd25519(rcptJson.signerPublicJwk, rcptJson.canonicalMessage, rcptJson.signature),
      true
    )
    const rcptHtmlResp = await fetch(decideObj.proofReceiptUrl, { headers: { Accept: 'text/html' } })
    assert.equal(rcptHtmlResp.status, 200)
    assert.match(await rcptHtmlResp.text(), /Ed25519 Signature Verified/)

    // 9D. Coinos Lightning micro-deposit ($0.005) + pull-verification credits idempotently without webhooks!
    const lnInv = (
      await postJson(
        `${url}/v1/wallet/deposit/lightning`,
        { amountUsd: 0.05 },
        { Authorization: `Bearer ${mcpAgent.apiKey}` }
      )
    ).body
    assert.equal(lnInv.bolt11, 'lnbc50n1p_real_coinos_bolt11')

    // Before payment -> settled: false
    const checkUnpaid = (
      await postJson(
        `${url}/v1/wallet/deposit/lightning/verify`,
        { invoiceId: lnInv.invoiceId },
        { Authorization: `Bearer ${mcpAgent.apiKey}` }
      )
    ).body
    assert.equal(checkUnpaid.settled, false)

    // Pay on Coinos -> pull-verify credits $0.0500 and replay is idempotent!
    coinosPaid = true
    const checkPaid = (
      await postJson(
        `${url}/v1/wallet/deposit/lightning/verify`,
        { invoiceId: lnInv.invoiceId },
        { Authorization: `Bearer ${mcpAgent.apiKey}` }
      )
    ).body
    assert.equal(checkPaid.settled, true)
    assert.equal(checkPaid.account.spendableUsd, '0.050000')

    const checkPaidReplay = (
      await postJson(
        `${url}/v1/wallet/deposit/lightning/verify`,
        { invoiceId: lnInv.invoiceId },
        { Authorization: `Bearer ${mcpAgent.apiKey}` }
      )
    ).body
    assert.equal(checkPaidReplay.alreadyCredited, true)
    assert.equal(checkPaidReplay.account.spendableUsd, '0.050000')

    // Now funded call settles via paid ledger path and records p50/p95 latency in /v1/market
    const paidNotarize = await postJson(
      `${url}/v1/act/trade.notarize`,
      { payload: { trade: 1 } },
      { Authorization: `Bearer ${mcpAgent.apiKey}` }
    )
    assert.equal(paidNotarize.status, 200)
    assert.equal(paidNotarize.body.mode, 'house_fallback')
    assert.ok(paidNotarize.body.receiptUrl.includes('/v1/receipts/'))

    const marketSnap = await (await fetch(`${url}/v1/market`)).json()
    const notaryBook = marketSnap.houseFallbackBook.find((x) => x.skill === 'trade.notarize')
    assert.equal(typeof notaryBook.p50LatencyMs, 'number')
    assert.ok(marketSnap.latencyByCapability['act:trade.notarize'].calls >= 2)

    // 9E. Deterministic canary verification on `act:trade.signal`: honest seller passes, spoofing seller gets slashed & banned!
    const honestSeller = (await postJson(`${url}/v1/agents/register`, { name: 'honest-quant' })).body
    const honestWorker = new SwitchWorker({
      serverUrl: url,
      apiKey: honestSeller.apiKey,
      autoReconnect: false,
      capabilities: [{ capability: 'act:trade.signal', priceUsd: '0.001' }],
      handlers: {
        'act:trade.signal': async (inp) =>
          computeTradeSignalFromCandles(inp.candles, { symbol: inp.symbol }),
      },
    })
    await honestWorker.start()
    const honestProbe = await app.router.runCanaryProbe(honestWorker.sessionId, 'act:trade.signal')
    assert.equal(honestProbe.passed, true)
    honestWorker.stop()

    const fakeSeller = (await postJson(`${url}/v1/agents/register`, { name: 'fake-quant' })).body
    const fakeWorker = new SwitchWorker({
      serverUrl: url,
      apiKey: fakeSeller.apiKey,
      autoReconnect: false,
      capabilities: [{ capability: 'act:trade.signal', priceUsd: '0.001' }],
      handlers: {
        'act:trade.signal': async () => ({ action: 'invalid_spoof' }),
      },
    })
    await fakeWorker.start()
    const fakeProbe = await app.router.runCanaryProbe(fakeWorker.sessionId, 'act:trade.signal')
    assert.equal(fakeProbe.slashed, true)
    assert.equal(app.ledger.serializeAccount(fakeSeller.agentId).banned, true)
    fakeWorker.stop()

    assert.equal(app.ledger.verifyInvariant().balanced, true)
  } finally {
    await app.close()
    await new Promise((r) => mockCoinos.close(r))
  }
})

test('10. Autonomous Agent Commons: 2% fee mode, Commons donations/patrons, zero-human verifiable bounties (sha256 + http_notary + requester_api + cancel), paid anti-spam inbox & WAL recovery', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw402-commons-'))
  const proofPages = new Map()
  const proofServer = http.createServer((req, res) => {
    const html = proofPages.get(req.url)
    if (!html) {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end(html)
  })
  await new Promise((r) => proofServer.listen(0, '127.0.0.1', r))
  const proofPort = proofServer.address().port
  const proofOrigin = `http://127.0.0.1:${proofPort}`

  let app = createSwitchServer({
    dataDir: tmpDir,
    platformFeeBps: 200, // 2% protocol fee / 98% worker & recipient keep
    heartbeatEnabled: false,
    allowLoopbackNotaryForTest: true,
  })
  let { url } = await app.listen(0)

  try {
    const donor = (await postJson(`${url}/v1/agents/register`, { name: 'patron-agent' })).body
    const reqAgent = (await postJson(`${url}/v1/agents/register`, { name: 'requester-agent' })).body
    const workerAgent = (await postJson(`${url}/v1/agents/register`, { name: 'worker-agent' })).body
    const inboxRecipient = (await postJson(`${url}/v1/agents/register`, { name: 'oracle-inbox' })).body

    app.ledger.deposit({ agentId: donor.agentId, amountNano: usdToNano('5.00'), txId: 'c10-donor' })
    app.ledger.deposit({ agentId: reqAgent.agentId, amountNano: usdToNano('5.00'), txId: 'c10-req' })
    app.ledger.deposit({ agentId: workerAgent.agentId, amountNano: usdToNano('1.00'), txId: 'c10-wrk' })

    // 10A. Commons donation ($0.50 -> 80% Commons Pool = $0.40, 20% Maintainer Treasury = $0.10)
    const donRes = await postJson(
      `${url}/v1/commons/donate`,
      { amountUsd: 0.5, note: 'for newborn agents' },
      { Authorization: `Bearer ${donor.apiKey}` }
    )
    assert.equal(donRes.status, 200)
    assert.equal(donRes.body.toCommonsPoolUsd, '0.400000')
    assert.equal(donRes.body.toMaintainerTreasuryUsd, '0.100000')
    assert.equal(donRes.body.commonsPoolUsd, '0.400000')

    // 10B. Patron Spotlight rejects SSRF loopback URL before charging; accepts valid public URL (50/50 split)
    const badPatron = await postJson(
      `${url}/v1/commons/patron`,
      {
        amountUsd: 1.0,
        name: 'EvilLocal',
        tagline: 'SSRF attempt',
        url: 'http://127.0.0.1/secret',
      },
      { Authorization: `Bearer ${donor.apiKey}` }
    )
    assert.equal(badPatron.status, 400)
    assert.equal(app.ledger.serializeAccount(donor.agentId).spendableUsd, '4.500000')

    const goodPatron = await postJson(
      `${url}/v1/commons/patron`,
      {
        amountUsd: 1.0,
        name: 'BaseQuant Guild',
        tagline: 'Autonomous DeFi signals & execution',
        url: 'https://example.org/guild',
        capabilityHint: 'act:trade.signal',
      },
      { Authorization: `Bearer ${donor.apiKey}` }
    )
    assert.equal(goodPatron.status, 201)
    assert.equal(goodPatron.body.toCommonsPoolUsd, '0.500000')
    assert.equal(goodPatron.body.toMaintainerTreasuryUsd, '0.500000')
    assert.equal(goodPatron.body.commonsPoolUsd, '0.900000')

    const commonsJson = await (await fetch(`${url}/v1/commons`)).json()
    assert.equal(commonsJson.feeModel.p2pPlatformFeeBps, 200)
    assert.equal(commonsJson.feeModel.sellerKeepBps, 9800)
    assert.equal(commonsJson.activePatrons[0].name, 'BaseQuant Guild')

    const llmsText = await (await fetch(`${url}/llms.txt`)).text()
    assert.match(llmsText, /keep 98%/)
    assert.match(llmsText, /BaseQuant Guild/)
    const dashHtml = await (await fetch(`${url}/`, { headers: { Accept: 'text/html' } })).text()
    assert.match(dashHtml, /BaseQuant Guild/)
    assert.match(dashHtml, /98% Seller Keep/)

    // 10C. Heartbeat benchmark draws from ag_commons_pool BEFORE treasuryNano
    const hbWorker = new SwitchWorker({
      serverUrl: url,
      apiKey: workerAgent.apiKey,
      autoReconnect: false,
      capabilities: [{ capability: 'act:util.sha256', pricePerCallUsd: '0.001' }],
      handlers: {
        'act:util.sha256': async (inp) => ({
          sha256: sha256Hex(String(inp.text || '')),
          bytes: Buffer.byteLength(String(inp.text || '')),
        }),
      },
    })
    await hbWorker.start()
    const commonsBeforeHb = app.ledger.getAgent('ag_commons_pool').spendableNano
    const treasuryBeforeHb = app.ledger.treasuryNano
    app.heartbeat.enabled = true
    const hbRes = await app.heartbeat.benchmarkSession(hbWorker.sessionId)
    app.heartbeat.enabled = false
    assert.equal(hbRes.settled, true)
    assert.equal(app.ledger.getAgent('ag_commons_pool').spendableNano, commonsBeforeHb - usdToNano('0.001'))
    // Treasury only gained the 2% fee ($0.00002), did NOT pay the $0.001 benchmark subsidy!
    assert.equal(app.ledger.treasuryNano, treasuryBeforeHb + usdToNano('0.00002'))
    hbWorker.stop()

    // 10D. Zero-human sha256_match bounty ($0.50 -> 98% = $0.49 to worker, 2% = $0.01 to treasury)
    const secretPreimage = 'autonomous-commons-preimage-2026'
    const shaBounty = await postJson(
      `${url}/v1/bounties`,
      {
        title: 'Find sha256 preimage',
        rewardUsd: 0.5,
        seats: 1,
        verifier: { type: 'sha256_match', expectedSha256: sha256Hex(secretPreimage) },
      },
      { Authorization: `Bearer ${reqAgent.apiKey}` }
    )
    assert.equal(shaBounty.status, 201)

    const selfClaim = await postJson(
      `${url}/v1/bounties/${shaBounty.body.id}/submit`,
      { preimage: secretPreimage },
      { Authorization: `Bearer ${reqAgent.apiKey}` }
    )
    assert.equal(selfClaim.status, 403)

    const wrongClaim = await postJson(
      `${url}/v1/bounties/${shaBounty.body.id}/submit`,
      { preimage: 'wrong' },
      { Authorization: `Bearer ${workerAgent.apiKey}` }
    )
    assert.equal(wrongClaim.status, 400)

    const workerBalBeforeBounty = app.ledger.getAgent(workerAgent.agentId).spendableNano
    const rightClaim = await postJson(
      `${url}/v1/bounties/${shaBounty.body.id}/submit`,
      { preimage: secretPreimage },
      { Authorization: `Bearer ${workerAgent.apiKey}` }
    )
    assert.equal(rightClaim.status, 200)
    assert.equal(rightClaim.body.paid, true)
    assert.equal(rightClaim.body.workerNetUsd, '0.490000')
    assert.equal(rightClaim.body.platformFeeUsd, '0.010000')
    assert.equal(rightClaim.body.status, 'filled')
    assert.equal(
      app.ledger.getAgent(workerAgent.agentId).spendableNano,
      workerBalBeforeBounty + usdToNano('0.49')
    )
    const btyReceipt = await (await fetch(rightClaim.body.receiptUrl)).json()
    assert.equal(btyReceipt.verified, true)

    // 10E. Zero-human http_notary_proof bounty ($0.20, 2 seats, requireClaimantId + anti-dupe URL)
    const notaryBounty = await postJson(
      `${url}/v1/bounties`,
      {
        title: 'Publish verified proof page',
        rewardUsd: 0.2,
        seats: 2,
        verifier: {
          type: 'http_notary_proof',
          mustContain: 'PROOF_TOKEN_77',
          requireClaimantId: true,
        },
      },
      { Authorization: `Bearer ${reqAgent.apiKey}` }
    )
    assert.equal(notaryBounty.status, 201)

    proofPages.set('/bad-proof', 'missing required token')
    const badNotary = await postJson(
      `${url}/v1/bounties/${notaryBounty.body.id}/submit`,
      { url: `${proofOrigin}/bad-proof` },
      { Authorization: `Bearer ${workerAgent.apiKey}` }
    )
    assert.equal(badNotary.status, 400)

    proofPages.set('/good-proof', `Live submission PROOF_TOKEN_77 by ${workerAgent.agentId}`)
    const goodNotary = await postJson(
      `${url}/v1/bounties/${notaryBounty.body.id}/submit`,
      { url: `${proofOrigin}/good-proof` },
      { Authorization: `Bearer ${workerAgent.apiKey}` }
    )
    assert.equal(goodNotary.status, 200)
    assert.equal(goodNotary.body.workerNetUsd, '0.196000')
    assert.equal(goodNotary.body.seatsRemaining, 1)

    // Another agent cannot replay the exact same URL!
    const dupeUrlAttempt = await postJson(
      `${url}/v1/bounties/${notaryBounty.body.id}/submit`,
      { url: `${proofOrigin}/good-proof` },
      { Authorization: `Bearer ${donor.apiKey}` }
    )
    assert.equal(dupeUrlAttempt.status, 409)

    // 10F. requester_api bounty: submit -> accept 1 seat -> cancel refunds remaining 1 seat 100%
    const apiBounty = await postJson(
      `${url}/v1/bounties`,
      {
        title: 'Manual API QA check',
        rewardUsd: 0.3,
        seats: 2,
        verifier: { type: 'requester_api' },
      },
      { Authorization: `Bearer ${reqAgent.apiKey}` }
    )
    assert.equal(apiBounty.status, 201)

    const subPending = await postJson(
      `${url}/v1/bounties/${apiBounty.body.id}/submit`,
      { url: 'https://example.com', payload: { ok: true } },
      { Authorization: `Bearer ${workerAgent.apiKey}` }
    )
    assert.equal(subPending.status, 200)
    assert.equal(subPending.body.paid, false)

    const accepted = await postJson(
      `${url}/v1/bounties/${apiBounty.body.id}/accept`,
      { submissionId: subPending.body.submission.submissionId },
      { Authorization: `Bearer ${reqAgent.apiKey}` }
    )
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.workerNetUsd, '0.294000')

    const reqBalBeforeCancel = app.ledger.getAgent(reqAgent.agentId).spendableNano
    const cancelled = await postJson(
      `${url}/v1/bounties/${apiBounty.body.id}/cancel`,
      {},
      { Authorization: `Bearer ${reqAgent.apiKey}` }
    )
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.refundedUsd, '0.300000')
    assert.equal(app.ledger.getAgent(reqAgent.agentId).spendableNano, reqBalBeforeCancel + usdToNano('0.30'))

    // 10G. Paid Anti-Spam Agent Inbox (98% to recipient, stamp threshold enforced)
    const patchRes = await fetch(`${url}/v1/agents/me/inbox`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${inboxRecipient.apiKey}`,
      },
      body: JSON.stringify({ minStampUsd: '0.01' }),
    })
    assert.equal(patchRes.status, 200)

    const lowStamp = await postJson(
      `${url}/v1/agents/${inboxRecipient.agentId}/inbox`,
      { subject: 'cheap spam', body: 'hello', stampUsd: '0.001' },
      { Authorization: `Bearer ${workerAgent.apiKey}` }
    )
    assert.equal(lowStamp.status, 402)

    const validMsg = await postJson(
      `${url}/v1/agents/${inboxRecipient.agentId}/inbox`,
      { subject: 'Job offer', body: 'Need quote check' },
      { Authorization: `Bearer ${workerAgent.apiKey}` }
    )
    assert.equal(validMsg.status, 201)
    assert.equal(validMsg.body.stampUsd, '0.010000')
    assert.equal(validMsg.body.recipientNetUsd, '0.009800')
    assert.equal(app.ledger.serializeAccount(inboxRecipient.agentId).spendableUsd, '0.009800')

    // Remote MCP inbox + commons tools
    const mcpInbox = await postJson(`${url}/mcp`, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: {
        name: 'check_inbox',
        arguments: { unreadOnly: true, markRead: true, apiKey: inboxRecipient.apiKey },
      },
    })
    const inboxData = JSON.parse(mcpInbox.body.result.content[0].text)
    assert.equal(inboxData.messages.length, 1)
    assert.equal(inboxData.messages[0].subject, 'Job offer')
    assert.equal(inboxData.unreadCount, 0)

    // Re-check unreadOnly -> 0 messages now!
    const afterRead = await (
      await fetch(`${url}/v1/agents/me/inbox?unread=true`, {
        headers: { Authorization: `Bearer ${inboxRecipient.apiKey}` },
      })
    ).json()
    assert.equal(afterRead.messages.length, 0)

    assert.equal(app.ledger.verifyInvariant().balanced, true)

    // 10H. Crash-safe WAL + Commons JSON persistence across full server restart
    await app.close()
    app = createSwitchServer({
      dataDir: tmpDir,
      platformFeeBps: 200,
      heartbeatEnabled: false,
    })
    ;({ url } = await app.listen(0))

    assert.equal(app.ledger.verifyInvariant().balanced, true)
    assert.equal(app.ledger.serializeAccount(inboxRecipient.agentId).spendableUsd, '0.009800')
    const persistedCommons = await (await fetch(`${url}/v1/commons`)).json()
    assert.equal(persistedCommons.activePatrons[0].name, 'BaseQuant Guild')
    const persistedBounties = await (await fetch(`${url}/v1/bounties?status=all`)).json()
    assert.equal(persistedBounties.bounties.length, 3)
  } finally {
    await app.close()
    await new Promise((r) => proofServer.close(r))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

const sharedAgent = new http.Agent({ keepAlive: true, maxSockets: 128 })
test.after(() => sharedAgent.destroy())

function postJson(urlStr, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        agent: sharedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            resolve({ status: res.statusCode, headers: res.headers, body: parsed })
          } catch (err) {
            reject(err)
          }
        })
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}
