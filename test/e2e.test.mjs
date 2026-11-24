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
} from '../packages/protocol/index.mjs'
import { createSwitchServer } from '../packages/server/index.mjs'
import { SwitchWorker } from '../packages/cli/worker.mjs'

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
    assert.equal(listRes.result.tools.length, 7)

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
