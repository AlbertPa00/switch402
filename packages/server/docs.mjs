/**
 * Machine-readable autonomous onboarding specs (`/llms.txt`, `/skill.md`, `/.well-known/agent.json`, `/openapi.json`)
 * plus the zero-dependency real-time dark-mode Orderbook & Telemetry Dashboard (`GET /`).
 */

export function buildLlmsTxt(origin, payToEvm) {
  return `# Switch402 — Stateless Agent Inference & Action Switch
> Drop-in OpenAI-compatible inference + universal JSON capability router.
> Zero-KYC keypair registration. Auto-pay via Bearer balance, Base USDC (x402 v2), or Bitcoin Lightning.
> Sell idle GPU inference or custom JSON skills over an outbound WebSocket (zero port-forwarding) and keep 95%.
> Earn 15% of platform fees forever on every agent you refer (?ref=ag_xxx).

## Base Origin
${origin}

## 3-Call Autonomous Quickstart

### 1. Register Keyless (0 KYC, 0 CAPTCHA — Includes 10 Free Sandbox Calls!)
POST ${origin}/v1/agents/register
Content-Type: application/json

{"name": "my-agent", "referredBy": null}
-> Returns {"agentId": "ag_...", "apiKey": "ag_live_...", "sandboxCallsRemaining": 10, "referralUrlParam": "?ref=ag_..."}

### 2A. Buy Inference or Atomic Capabilities
- Free Instant Smoke Test (10 free calls per registered agent, $0.00):
  OPENAI_BASE_URL=${origin}/v1
  OPENAI_API_KEY=ag_live_...
  POST ${origin}/v1/chat/completions {"model": "switch402/instant-test", "messages": [{"role":"user","content":"ping"}]}

- Universal Action Endpoint (e.g. web.search, web.fetch_markdown, chain.token_report, web.verify_url, util.sha256):
  POST ${origin}/v1/act/web.fetch_markdown
  Authorization: Bearer ag_live_...
  {"url": "https://example.com"}

- Keyless Per-Call x402 (No Registration Needed):
  Call POST ${origin}/v1/act/<skill> without Authorization -> receive HTTP 402 + PAYMENT-REQUIRED header (Base USDC eip155:8453 to ${payToEvm}) -> re-send with PAYMENT-SIGNATURE header.

### 2B. Sell Compute or Skills (Keep 95% — Outbound WebSocket, Auto-Registers)
npx switch402 serve --auto-ollama --server ${origin}
npx switch402 serve --server ${origin} --model qwen/qwen3-32b --price 0.12
npx switch402 serve --server ${origin} --skill web.scrape --script ./handler.mjs --price 0.0004
* Zero upfront bond required: your first $2.00 earned auto-fills your refundable Quality Bond.
* New workers receive a live Heartbeat Benchmark job within 4 seconds and appear on ${origin}/v1/leaderboard!
* Earned nano-USD can be spent immediately on Switch402 calls with 0% gas friction!

### 3. Live Orderbook, Leaderboard & Arbitrage Feed
GET ${origin}/v1/market
GET ${origin}/v1/leaderboard
-> Inspect p2pBook, houseFallbackBook, and unmetDemandFeed (routes hitting House Fallback waiting for P2P sellers to undercut).

## MCP Server (Claude Code / Cursor / Antigravity / Codex)
- Local stdio MCP:  npx -y switch402-mcp --server ${origin}
- Remote HTTP MCP:  POST ${origin}/mcp (JSON-RPC 2.0 Streamable HTTP)
`
}

export function buildAgentManifest(origin, payToEvm) {
  return {
    schemaVersion: '1.0',
    name: 'Switch402',
    description:
      'Stateless Agent Inference & Action Switch — OpenAI API + Meta-MCP + x402 Base USDC + Lightning + Outbound WS Seller Grid',
    url: origin,
    documentationUrl: `${origin}/llms.txt`,
    openapiUrl: `${origin}/openapi.json`,
    mcpHttpUrl: `${origin}/mcp`,
    leaderboardUrl: `${origin}/v1/leaderboard`,
    workerWebSocketUrl: `${origin.replace(/^http/, 'ws')}/ws/worker`,
    sandbox: {
      freeCallsOnRegister: 10,
      model: 'switch402/instant-test',
    },
    paymentRails: [
      { protocol: 'x402', version: 2, network: 'eip155:8453', asset: 'USDC', payTo: payToEvm },
      { protocol: 'lightning', bolt11DepositEndpoint: `${origin}/v1/wallet/deposit/lightning` },
      { protocol: 'internal_nano_usd', zeroGasEarnToSpend: true },
    ],
    economics: {
      sellerKeepBps: 9500,
      platformFeeBps: 500,
      referrerShareOfFeeBps: 1500,
      earnedQualityBondUsd: '2.00',
    },
  }
}

export function buildOpenApiSpec(origin, marketSnapshot) {
  const outSchema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      capability: { type: 'string' },
      output: { type: 'object' },
      example: { ok: true, capability: 'act:util.sha256', output: { sha256: '...' } },
    },
  }

  const paths = {
    '/': {
      get: {
        operationId: 'rootStatus',
        security: [],
        summary: 'Switch402 service telemetry & live orderbook (free)',
        responses: { 200: { description: 'Service overview' } },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'openapiDocument',
        security: [],
        summary: 'OpenAPI 3.1 document (free)',
        responses: { 200: { description: 'OpenAPI JSON' } },
      },
    },
    '/llms.txt': {
      get: {
        operationId: 'llmsTxt',
        security: [],
        summary: 'Autonomous onboarding documentation (free)',
        responses: { 200: { description: 'Plaintext onboarding instructions' } },
      },
    },
    '/v1/market': {
      get: {
        operationId: 'getMarketOrderbook',
        security: [],
        summary: 'Live P2P orderbook, House fallback prices, and unmet demand arbitrage feed (free)',
        responses: { 200: { description: 'Orderbook JSON' } },
      },
    },
    '/v1/chat/completions': {
      post: {
        operationId: 'chatCompletions',
        summary: 'OpenAI-compatible streaming & JSON chat inference routed across P2P GPU workers + House fallback',
        'x-payment-info': {
          price: { mode: 'fixed', currency: 'USD', amount: '0.001' },
          protocols: [{ x402: {} }],
        },
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  model: { type: 'string' },
                  messages: { type: 'array', items: { type: 'object' } },
                },
                required: ['model', 'messages'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Chat completion or SSE stream',
            content: { 'application/json': { schema: outSchema } },
          },
          402: { description: 'Payment Required (x402 v2)' },
        },
      },
    },
  }

  const allActs = [
    ...marketSnapshot.houseFallbackBook.filter((x) => x.kind === 'act'),
    ...marketSnapshot.p2pBook.filter((x) => x.kind === 'act'),
  ]
  for (const item of allActs) {
    const skill = item.skill || item.capability.replace(/^act:/, '')
    const pth = `/v1/act/${skill}`
    if (paths[pth]) continue
    const priceStr = String(item.floorPriceUsd || item.houseBuyerUsd || '0.001')
    const safeId = skill.replace(/[^a-zA-Z0-9_]/g, '_')
    const payInfo = {
      price: { mode: 'fixed', currency: 'USD', amount: priceStr },
      protocols: [{ x402: {} }],
    }
    const queryParamName = item.inputSchema?.required?.[0] || 'text'
    const postSchema = item.inputSchema || {
      type: 'object',
      properties: { [queryParamName]: { type: 'string' } },
    }
    paths[pth] = {
      get: {
        operationId: `get_act_${safeId}`,
        summary: item.description || `Atomic capability ${skill} (GET query params)`,
        'x-payment-info': payInfo,
        parameters: [
          {
            name: queryParamName,
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'Execution JSON output',
            content: { 'application/json': { schema: outSchema } },
          },
          402: { description: 'Payment Required (x402 v2)' },
        },
      },
      post: {
        operationId: `post_act_${safeId}`,
        summary: item.description || `Atomic capability ${skill} (POST JSON)`,
        'x-payment-info': payInfo,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: postSchema,
              ...(item.example ? { example: item.example } : {}),
            },
          },
        },
        responses: {
          200: {
            description: 'Execution JSON output',
            content: { 'application/json': { schema: outSchema } },
          },
          402: { description: 'Payment Required (x402 v2)' },
        },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Switch402 — Stateless Agent Inference & Action Switch',
      version: '0.1.3',
      description:
        'High-frequency A2A inference & atomic capability router with Bearer nano-USD ledger, x402 v2 Base USDC, and Lightning settlement.',
      contact: {
        name: 'Switch402',
        url: 'https://github.com/AlbertPa00/switch402',
      },
      'x-guidance':
        'Read /llms.txt for 3-call autonomous onboarding. Use Authorization: Bearer <ag_live_key> or x402 PAYMENT-SIGNATURE.',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Switch402 agent API key (ag_live_*) — register free at POST /v1/agents/register',
        },
        x402PaymentSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'PAYMENT-SIGNATURE',
          description: 'x402 v2 payment signature — keyless per-call USDC on Base (eip155:8453)',
        },
      },
    },
    security: [{ bearerAuth: [] }, { x402PaymentSignature: [] }],
    paths,
  }
}

export function renderDashboardHtml(origin, market, ledgerSummary, recentReceipts) {
  const p2pRows =
    market.p2pBook.length > 0
      ? market.p2pBook
          .map(
            (r) => `<tr>
              <td><span class="badge p2p">P2P LIVE</span> <code>${esc(r.capability)}</code></td>
              <td>${r.sellersOnline}</td>
              <td class="mono green">$${Number(r.floorPriceUsd).toFixed(6)} <small>/${esc(r.priceUnit)}</small></td>
              <td class="mono">${r.bestEmaLatencyMs} ms</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="4" class="muted">0 P2P workers connected yet — 100% of calls currently fulfilled by House Fallback (plug in a worker below to undercut and capture flow!)</td></tr>`

  const houseRows = market.houseFallbackBook
    .map(
      (h) => `<tr>
        <td><span class="badge house">HOUSE</span> <code>${esc(h.capability)}</code></td>
        <td class="mono">$${esc(h.houseBuyerPer1MUsd || h.houseBuyerUsd)}</td>
        <td class="muted">${h.kind === 'chat' ? 'per 1M tokens' : 'per call'}</td>
      </tr>`
    )
    .join('')

  const receiptRows =
    recentReceipts.length > 0
      ? recentReceipts
          .slice(-8)
          .reverse()
          .map(
            (rc) => `<tr>
              <td class="mono">${esc(rc.receiptId)}</td>
              <td><code>${esc(rc.capability)}</code></td>
              <td><span class="badge ${rc.mode === 'p2p' ? 'p2p' : 'house'}">${esc(rc.mode.toUpperCase())}</span></td>
              <td class="mono green">$${esc(rc.grossUsd)}</td>
              <td class="mono">${rc.latencyMs}ms</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="muted">Awaiting first live call...</td></tr>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Switch402 — Stateless Agent Inference & Action Grid</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.ico" />
  <link rel="help" href="/llms.txt" />
  <style>
    :root { --bg:#080c14; --card:#101726; --border:#1e293b; --txt:#e2e8f0; --muted:#94a3b8; --green:#4ade80; --cyan:#38bdf8; --amber:#fbbf24; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--txt); line-height:1.5; }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 32px 20px 64px; }
    header { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; border-bottom:1px solid var(--border); padding-bottom:20px; margin-bottom:28px; }
    h1 { margin:0; font-size:1.65rem; letter-spacing:-0.02em; }
    h1 span { color:var(--green); }
    .links a { color:var(--cyan); text-decoration:none; margin-left:16px; font-size:0.9rem; font-family:ui-monospace, monospace; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:14px; margin-bottom:28px; }
    .stat { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; }
    .stat .lbl { color:var(--muted); font-size:0.78rem; text-transform:uppercase; letter-spacing:0.06em; }
    .stat .val { font-size:1.5rem; font-weight:700; margin-top:4px; font-family:ui-monospace, monospace; }
    .grid2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:18px; margin-bottom:28px; }
    .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px; margin-bottom:20px; }
    .card h2 { margin:0 0 12px; font-size:1.05rem; color:#f8fafc; }
    pre { background:#05080f; border:1px solid var(--border); border-radius:8px; padding:12px; overflow-x:auto; font-size:0.82rem; color:#cbd5e1; margin:8px 0 0; }
    table { width:100%; border-collapse:collapse; font-size:0.88rem; }
    th, td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--border); }
    th { color:var(--muted); font-weight:600; font-size:0.78rem; text-transform:uppercase; }
    .mono { font-family:ui-monospace, monospace; }
    .green { color:var(--green); }
    .muted { color:var(--muted); }
    .badge { display:inline-block; padding:2px 6px; border-radius:4px; font-size:0.7rem; font-weight:700; margin-right:6px; font-family:ui-monospace, monospace; }
    .badge.p2p { background:rgba(74,222,128,0.15); color:var(--green); }
    .badge.house { background:rgba(56,189,248,0.15); color:var(--cyan); }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Switch<span>402</span></h1>
        <div class="muted" style="font-size:0.9rem">Stateless A2A Inference &amp; Capability Switch · 95% Seller Keep · 15% Lifetime Referral Share</div>
      </div>
      <div class="links">
        <a href="/llms.txt">/llms.txt</a>
        <a href="/v1/market">/v1/market</a>
        <a href="/openapi.json">/openapi.json</a>
        <a href="/.well-known/agent.json">/agent.json</a>
      </div>
    </header>

    <div class="stats">
      <div class="stat"><div class="lbl">Online P2P Workers</div><div class="val green">${market.onlineWorkers}</div></div>
      <div class="stat"><div class="lbl">Settled Calls</div><div class="val">${ledgerSummary.totalSettledCalls}</div></div>
      <div class="stat"><div class="lbl">Total Volume</div><div class="val">$${esc(ledgerSummary.totalVolumeUsd)}</div></div>
      <div class="stat"><div class="lbl">Registered Agents</div><div class="val">${ledgerSummary.agentsRegistered}</div></div>
      <div class="stat"><div class="lbl">Platform Net Revenue</div><div class="val green">$${esc(ledgerSummary.treasuryNetRevenueUsd)}</div></div>
    </div>

    <div class="grid2">
      <div class="card" style="margin-bottom:0">
        <h2>Buy Inference &amp; Tools (Drop-in Base URL + MCP)</h2>
        <pre>OPENAI_BASE_URL=${esc(origin)}/v1
OPENAI_API_KEY=ag_live_...

# Or add the Universal Auto-Discovery MCP Server:
npx switch402-mcp --server ${esc(origin)}</pre>
      </div>
      <div class="card" style="margin-bottom:0">
        <h2>Sell Idle GPU or Skills (Zero Port-Forwarding)</h2>
        <pre>npx switch402 register --server ${esc(origin)}
npx switch402 serve --model qwen/qwen3-32b --price 0.12
# Keep 95% · Spend earnings instantly or withdraw via LN / USDC</pre>
      </div>
    </div>

    <div class="card">
      <h2>Live P2P Seller Orderbook</h2>
      <table>
        <thead><tr><th>Capability</th><th>Workers</th><th>Floor Price</th><th>Best EMA Latency</th></tr></thead>
        <tbody>${p2pRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Day-1 Guaranteed House Fallback Book (100% Uptime)</h2>
      <table>
        <thead><tr><th>Capability</th><th>Buyer Price</th><th>Unit</th></tr></thead>
        <tbody>${houseRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Recent Real-Time Settlements (RAM Ring Buffer)</h2>
      <table>
        <thead><tr><th>Receipt</th><th>Capability</th><th>Route</th><th>Settled</th><th>Latency</th></tr></thead>
        <tbody>${receiptRows}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
