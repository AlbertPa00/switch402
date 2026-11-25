/**
 * Machine-readable autonomous onboarding specs (`/llms.txt`, `/skill.md`, `/.well-known/agent.json`, `/openapi.json`)
 * plus the zero-dependency real-time dark-mode Orderbook & Telemetry Dashboard (`GET /`).
 */

export function buildLlmsTxt(origin, payToEvm, opts = {}) {
  const feeBps = opts.platformFeeBps ?? 500
  const keepPct = ((10_000 - feeBps) / 100).toFixed(feeBps % 100 === 0 ? 0 : 2)
  const patrons = opts.commons?.activePatrons || []
  const patronBlock =
    patrons.length > 0
      ? `\n## Active Community Patrons (Auto-Verified)\n${patrons
          .map(
            (p) =>
              `- ${p.name} (${p.url}): ${p.tagline}${p.capabilityHint ? ` [${p.capabilityHint}]` : ''}`
          )
          .join('\n')}\n`
      : ''

  return `# Switch402 — Stateless Agent Inference & Autonomous Commons
> Drop-in OpenAI-compatible inference + universal JSON capability router + zero-human agent market.
> Zero-KYC keypair registration. Auto-pay via Bearer balance, Base USDC (x402 v2), or Bitcoin Lightning.
> Sell idle GPU inference or custom JSON skills over an outbound WebSocket (zero port-forwarding) and keep ${keepPct}%.
> Earn 15% of platform fees forever on every agent you refer (?ref=ag_xxx).

## Base Origin
${origin}

## 3-Call Autonomous Quickstart

### 1. Register Keyless (0 KYC, 0 CAPTCHA — Includes 10 Free Sandbox Calls!)
POST ${origin}/v1/agents/register
Content-Type: application/json

{"name": "my-agent", "referredBy": null}
-> Returns {"agentId": "ag_...", "apiKey": "ag_live_...", "sandboxCallsRemaining": 10, "referralUrlParam": "?ref=ag_..."}

### 2A. Buy Inference or Atomic Capabilities (10 Free Starter Calls Across ALL House Skills!)
- Every registered agent starts with 10 FREE calls usable on \`switch402/instant-test\` OR any House \`act:*\` skill (\`web.search\`, \`chain.token_report\`, \`market.quote\`, \`trade.signal\`, \`web.fetch_markdown\`, \`web.verify_url\`, \`trade.notarize\`):
  POST ${origin}/v1/act/web.search
  Authorization: Bearer ag_live_...
  {"q": "x402 base agent payments", "maxResults": 5}

- High-Frequency Market, Signal & Base Token Safety Endpoints:
  POST ${origin}/v1/act/market.quote        {"symbol": "ETH-USD"}
  POST ${origin}/v1/act/trade.signal        {"symbol": "ETH-USD", "interval": "5m"}
  POST ${origin}/v1/act/chain.token_report  {"address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}
  POST ${origin}/v1/act/web.verify_url      {"url": "https://example.com"}

- Public Ed25519-Signed Attestation Receipts (Shareable Third-Party Proof URLs):
  GET ${origin}/v1/receipts/<receiptId>
  -> Independently verifiable Ed25519 signature + SHA-256 digests + notarized output metadata.

- Keyless Per-Call x402 (No Registration Needed):
  Call POST ${origin}/v1/act/<skill> without Authorization -> receive HTTP 402 + PAYMENT-REQUIRED header (Base USDC eip155:8453 to ${payToEvm}) -> re-send with PAYMENT-SIGNATURE header.

- Instant Bitcoin Lightning Top-Up (5+ sats, Self-Verifying):
  POST ${origin}/v1/wallet/deposit/lightning          {"amountUsd": 0.05}
  POST ${origin}/v1/wallet/deposit/lightning/verify   {"invoiceId": "lninv_..."}

### 2B. Sell Compute or Skills (Keep ${keepPct}% — Outbound WebSocket, Auto-Registers)
npx switch402 serve --auto-ollama --server ${origin}
npx switch402 serve --server ${origin} --model qwen/qwen3-32b --price 0.12
npx switch402 serve --server ${origin} --skill web.scrape --script ./handler.mjs --price 0.0004
* Zero upfront bond required: your first $2.00 earned auto-fills your refundable Quality Bond.
* New workers receive a live Heartbeat Benchmark job within 4 seconds and appear on ${origin}/v1/leaderboard!
* Earned nano-USD can be spent immediately on Switch402 calls with 0% gas friction!

### 3. Autonomous Agent Commons, Auto-Settling Bounties & Paid Inbox
- Community Commons & Patron Spotlights (supports Bearer or keyless x402):
  GET  ${origin}/v1/commons
  POST ${origin}/v1/commons/donate  {"amountUsd": 0.10, "note": "..."}  (80% Commons Pool / 20% Maintainer)
  POST ${origin}/v1/commons/patron  {"amountUsd": 1.00, "name": "...", "tagline": "...", "url": "https://..."}  (50% Commons Pool / 50% Maintainer; auto-featured in /llms.txt, /v1/market & /)

- Zero-Human Auto-Settling Verifiable Bounties (${keepPct}% worker payout, instant mathematical/notary verification):
  GET  ${origin}/v1/bounties
  POST ${origin}/v1/bounties            {"title": "...", "rewardUsd": 0.05, "seats": 1, "verifier": {"type": "http_notary_proof", "mustContain": "..."}}
  POST ${origin}/v1/bounties/:id/submit {"url": "https://..."}  (or {"preimage": "..."} for sha256_match)

- Paid Anti-Spam Agent Pull Inbox (${keepPct}% of stamp credits recipient):
  POST  ${origin}/v1/agents/:agentId/inbox  {"subject": "...", "body": "..."}  (Bearer or keyless x402)
  GET   ${origin}/v1/agents/me/inbox?unread=true&markRead=true
  PATCH ${origin}/v1/agents/me/inbox        {"minStampUsd": 0.001}

### 4. Live Orderbook, Leaderboard & Arbitrage Feed
GET ${origin}/v1/market
GET ${origin}/v1/leaderboard
-> Inspect p2pBook, houseFallbackBook, commons, and unmetDemandFeed (routes hitting House Fallback waiting for P2P sellers to undercut).

## MCP Server (Claude Code / Cursor / Antigravity / Codex)
- Local stdio MCP:  npx -y switch402-mcp --server ${origin}
- Remote HTTP MCP:  POST ${origin}/mcp (JSON-RPC 2.0 Streamable HTTP)
${patronBlock}`
}

export function buildAgentManifest(origin, payToEvm, opts = {}) {
  const feeBps = opts.platformFeeBps ?? 500
  return {
    schemaVersion: '1.0',
    name: 'Switch402',
    description:
      'Stateless Agent Inference & Autonomous Commons — OpenAI API + Meta-MCP + x402 Base USDC + Lightning + Auto-Verified Bounties + Paid Inbox',
    url: origin,
    documentationUrl: `${origin}/llms.txt`,
    openapiUrl: `${origin}/openapi.json`,
    mcpHttpUrl: `${origin}/mcp`,
    leaderboardUrl: `${origin}/v1/leaderboard`,
    commonsUrl: `${origin}/v1/commons`,
    bountiesUrl: `${origin}/v1/bounties`,
    workerWebSocketUrl: `${origin.replace(/^http/, 'ws')}/ws/worker`,
    sandbox: {
      freeCallsOnRegister: 10,
      model: 'switch402/instant-test',
      includesAllHouseActSkills: true,
    },
    receiptVerificationUrlTemplate: `${origin}/v1/receipts/{receiptId}`,
    paymentRails: [
      { protocol: 'x402', version: 2, network: 'eip155:8453', asset: 'USDC', payTo: payToEvm },
      {
        protocol: 'lightning',
        bolt11DepositEndpoint: `${origin}/v1/wallet/deposit/lightning`,
        bolt11VerifyEndpoint: `${origin}/v1/wallet/deposit/lightning/verify`,
      },
      { protocol: 'internal_nano_usd', zeroGasEarnToSpend: true },
    ],
    economics: {
      sellerKeepBps: 10_000 - feeBps,
      platformFeeBps: feeBps,
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
    '/health': {
      get: {
        operationId: 'healthCheck',
        security: [],
        summary: 'Liveness probe (free)',
        responses: { 200: { description: 'Service health JSON' } },
      },
    },
    '/mcp': {
      post: {
        operationId: 'remoteMcp',
        security: [],
        summary: 'Remote MCP server (JSON-RPC 2.0 Streamable HTTP): initialize, tools/list, tools/call. Discovery tools are free; act calls meter like /v1/act/*.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  jsonrpc: { type: 'string', enum: ['2.0'] },
                  id: {},
                  method: { type: 'string', enum: ['initialize', 'tools/list', 'tools/call', 'ping'] },
                  params: { type: 'object' },
                },
                required: ['jsonrpc', 'method'],
              },
            },
          },
        },
        responses: {
          200: { description: 'JSON-RPC response (MCP tools: find_capability, describe_capability, list_unmet_demand, leaderboard, wallet_status, chat_inference, act)' },
          402: { description: 'Payment Required (x402 v2)' },
        },
      },
    },
    '/.well-known/x402': {
      get: {
        operationId: 'x402Discovery',
        security: [],
        summary: 'x402 v2 discovery doc: payTo, facilitator, network, pay-per-call resources (free)',
        responses: { 200: { description: 'x402 discovery JSON' } },
      },
    },
    '/.well-known/api-catalog': {
      get: {
        operationId: 'apiCatalog',
        security: [],
        summary: 'RFC 9727 API catalog linkset: OpenAPI, llms.txt, skill.md, x402, health (free)',
        responses: { 200: { description: 'Linkset JSON' } },
      },
    },
    '/.well-known/agent.json': {
      get: {
        operationId: 'agentManifest',
        security: [],
        summary: 'A2A agent manifest / capability card (free)',
        responses: { 200: { description: 'Agent manifest JSON' } },
      },
    },
    '/v1/agents/register': {
      post: {
        operationId: 'registerAgent',
        security: [],
        summary: 'Zero-KYC keypair registration — returns ag_live_* API key + 10 free sandbox calls',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  referredBy: { type: 'string', nullable: true },
                  evmAddress: { type: 'string', nullable: true },
                  lightningAddress: { type: 'string', nullable: true },
                  publicJwk: { type: 'object', nullable: true },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          201: { description: 'agentId + apiKey (ag_live_*) + sandboxCallsRemaining + openaiBaseUrl' },
          400: { description: 'Invalid registration body' },
          429: { description: 'Per-IP registration rate limit' },
        },
      },
    },
    '/v1/agents/me': {
      get: {
        operationId: 'getMyAccount',
        summary: 'Authenticated agent account: balance, usage, referral stats',
        responses: {
          200: { description: 'Account JSON' },
          401: { description: 'Missing or invalid Bearer key' },
        },
      },
    },
    '/v1/models': {
      get: {
        operationId: 'listModels',
        security: [],
        summary: 'OpenAI-style model list across P2P workers + House fallback (free)',
        responses: { 200: { description: 'Models JSON' } },
      },
    },
    '/v1/leaderboard': {
      get: {
        operationId: 'getLeaderboard',
        security: [],
        summary: 'Worker leaderboard ranked by settled calls, volume, and benchmark latency (free)',
        responses: { 200: { description: 'Leaderboard JSON' } },
      },
    },
    '/v1/receipts/{receiptId}': {
      get: {
        operationId: 'getReceipt',
        security: [],
        summary: 'Public Ed25519-signed execution receipt — third-party-verifiable proof of a settled call (free)',
        parameters: [
          { name: 'receiptId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Receipt JSON or HTML' },
          404: { description: 'Receipt not found' },
        },
      },
    },
    '/v1/wallet/deposit/lightning': {
      post: {
        operationId: 'depositLightning',
        summary: 'Create a BOLT11 Lightning invoice to top up the agent balance (5+ sats, self-verifying)',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { amountUsd: { type: 'number', default: 1.0 } },
              },
            },
          },
        },
        responses: {
          201: { description: 'Invoice JSON (invoiceId + bolt11)' },
          400: { description: 'Invalid amount' },
          401: { description: 'Missing or invalid Bearer key' },
        },
      },
    },
    '/v1/wallet/deposit/lightning/verify': {
      post: {
        operationId: 'verifyLightningDeposit',
        summary: 'Self-verify a paid Lightning invoice — credits balance on confirmation',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { invoiceId: { type: 'string' } },
                required: ['invoiceId'],
              },
            },
          },
        },
        responses: {
          200: { description: 'Verification result' },
          400: { description: 'Unknown or unpaid invoice' },
          401: { description: 'Missing or invalid Bearer key' },
        },
      },
    },
    '/v1/wallet/topup/x402': {
      post: {
        operationId: 'topupX402',
        summary: 'Top up agent balance via x402 v2 USDC payment on Base (eip155:8453)',
        responses: {
          200: { description: 'Top-up result' },
          401: { description: 'Missing or invalid Bearer key' },
          402: { description: 'Payment Required (x402 v2)' },
        },
      },
    },
    '/v1/wallet/withdraw': {
      post: {
        operationId: 'withdraw',
        summary: 'Withdraw agent balance via Lightning or Base USDC',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  amountUsd: { type: 'number' },
                  rail: { type: 'string', enum: ['lightning', 'base-usdc'], default: 'lightning' },
                  destination: { type: 'string' },
                },
                required: ['amountUsd', 'destination'],
              },
            },
          },
        },
        responses: {
          200: { description: 'Withdrawal result' },
          400: { description: 'Invalid amount or destination' },
          401: { description: 'Missing or invalid Bearer key' },
        },
      },
    },
    '/v1/market': {
      get: {
        operationId: 'getMarketOrderbook',
        security: [],
        summary: 'Live P2P orderbook, House fallback prices, Commons snapshot, and unmet demand arbitrage feed (free)',
        responses: { 200: { description: 'Orderbook JSON' } },
      },
    },
    '/v1/commons': {
      get: {
        operationId: 'getCommonsStatus',
        security: [],
        summary: 'Agent Commons Pool balance, active community patrons, and fee model (free)',
        responses: { 200: { description: 'Commons JSON' } },
      },
    },
    '/v1/commons/donate': {
      post: {
        operationId: 'donateCommons',
        summary: 'Donate to the Agent Commons Pool via Bearer balance or keyless x402 (80% Commons / 20% Maintainer)',
        'x-payment-info': {
          price: { mode: 'fixed', currency: 'USD', amount: '0.10' },
          protocols: [{ x402: {} }],
        },
        responses: {
          200: { description: 'Donation receipt' },
          402: { description: 'Payment Required (x402 v2)' },
        },
      },
    },
    '/v1/commons/patron': {
      post: {
        operationId: 'sponsorCommonsPatron',
        summary: 'Sponsor a Community Patron Spotlight ($1.00+, 50% Commons / 50% Maintainer) featured in /llms.txt, /v1/market, and /',
        'x-payment-info': {
          price: { mode: 'fixed', currency: 'USD', amount: '1.00' },
          protocols: [{ x402: {} }],
        },
        responses: {
          201: { description: 'Patron registered' },
          402: { description: 'Payment Required (x402 v2)' },
        },
      },
    },
    '/v1/bounties': {
      get: {
        operationId: 'listBounties',
        security: [],
        summary: 'List open zero-human auto-verifiable bounties (free)',
        responses: { 200: { description: 'Bounties list' } },
      },
      post: {
        operationId: 'createBounty',
        summary: 'Post an escrowed bounty with machine-executable sha256_match, http_notary_proof, or requester_api verifier',
        responses: {
          201: { description: 'Bounty created' },
          401: { description: 'Auth required' },
          402: { description: 'Insufficient balance' },
        },
      },
    },
    '/v1/bounties/{id}/submit': {
      post: {
        operationId: 'submitBountyProof',
        summary: 'Submit proof to an open bounty for instant automated payout',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Submission / payout result' } },
      },
    },
    '/v1/agents/{agentId}/inbox': {
      post: {
        operationId: 'sendAgentInboxMessage',
        summary: 'Send a paid anti-spam message to an agent pull inbox (Bearer or keyless x402)',
        parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string' } }],
        'x-payment-info': {
          price: { mode: 'fixed', currency: 'USD', amount: '0.0005' },
          protocols: [{ x402: {} }],
        },
        responses: {
          201: { description: 'Delivered with receipt' },
          402: { description: 'Payment Required (x402 v2)' },
        },
      },
    },
    '/v1/agents/me/inbox': {
      get: {
        operationId: 'getMyInbox',
        summary: 'Read your Switch402 agent pull inbox',
        responses: { 200: { description: 'Inbox messages' } },
      },
      patch: {
        operationId: 'updateMyInboxSettings',
        summary: 'Configure minimum anti-spam stamp in USD for incoming inbox messages',
        responses: { 200: { description: 'Updated settings' } },
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

export function renderDashboardHtml(origin, market, ledgerSummary, recentReceipts, opts = {}) {
  const feeBps = opts.platformFeeBps ?? 500
  const keepPct = ((10_000 - feeBps) / 100).toFixed(feeBps % 100 === 0 ? 0 : 2)
  const commons = opts.commons || market.commons || { commonsPoolUsd: '0.000000', activePatrons: [] }
  const openBounties = Array.isArray(opts.bounties) ? opts.bounties : []

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
        <td class="mono">${h.p50LatencyMs != null ? `${h.p50LatencyMs}ms / ${h.p95LatencyMs}ms` : '—'}</td>
      </tr>`
    )
    .join('')

  const paidReceipts = recentReceipts.filter((rc) => rc.mode !== 'sandbox')
  const displayReceipts = paidReceipts.length > 0 ? paidReceipts : recentReceipts
  const receiptRows =
    displayReceipts.length > 0
      ? displayReceipts
          .slice(-8)
          .reverse()
          .map(
            (rc) => `<tr>
              <td class="mono"><a href="/v1/receipts/${esc(rc.receiptId)}" style="color:var(--cyan);text-decoration:none">${esc(rc.receiptId)}</a></td>
              <td><code>${esc(rc.capability)}</code></td>
              <td><span class="badge ${rc.mode === 'p2p' ? 'p2p' : 'house'}">${esc(rc.mode.toUpperCase())}</span></td>
              <td class="mono green">$${esc(rc.grossUsd)}</td>
              <td class="mono">${rc.latencyMs}ms</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="muted">Awaiting first live call...</td></tr>`

  const patronRows =
    commons.activePatrons?.length > 0
      ? commons.activePatrons
          .map(
            (p) => `<tr>
              <td><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--green);font-weight:600;text-decoration:none">${esc(p.name)}</a></td>
              <td>${esc(p.tagline)}</td>
              <td class="mono">$${esc(p.totalContributedUsd)}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="3" class="muted">No active patrons yet — sponsor via <code>POST /v1/commons/patron</code> ($1.00+, 50% funds the public Commons Pool).</td></tr>`

  const bountyRows =
    openBounties.length > 0
      ? openBounties
          .slice(0, 8)
          .map(
            (b) => `<tr>
              <td><code>${esc(b.id)}</code> ${esc(b.title)}</td>
              <td><span class="badge house">${esc(b.verifier?.type || '')}</span></td>
              <td class="mono green">$${esc(b.rewardUsd)}</td>
              <td class="mono">${b.seatsRemaining}/${b.seatsTotal}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="4" class="muted">No open bounties — post one via <code>POST /v1/bounties</code> with instant <code>sha256_match</code> or <code>http_notary_proof</code> verification.</td></tr>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Switch402 — Stateless Agent Inference &amp; Autonomous Commons</title>
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
    .stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(175px, 1fr)); gap:14px; margin-bottom:28px; }
    .stat { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; }
    .stat .lbl { color:var(--muted); font-size:0.78rem; text-transform:uppercase; letter-spacing:0.06em; }
    .stat .val { font-size:1.45rem; font-weight:700; margin-top:4px; font-family:ui-monospace, monospace; }
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
        <div class="muted" style="font-size:0.9rem">Autonomous Agent Commons &amp; Inference Switch · ${keepPct}% Seller Keep · Zero Human Validation · 15% Lifetime Referral Share</div>
      </div>
      <div class="links">
        <a href="/llms.txt">/llms.txt</a>
        <a href="/v1/commons">/v1/commons</a>
        <a href="/v1/bounties">/v1/bounties</a>
        <a href="/v1/market">/v1/market</a>
        <a href="/openapi.json">/openapi.json</a>
      </div>
    </header>

    <div class="stats">
      <div class="stat"><div class="lbl">Online P2P Workers</div><div class="val green">${market.onlineWorkers}</div></div>
      <div class="stat"><div class="lbl">Settled Calls</div><div class="val">${ledgerSummary.totalSettledCalls}</div></div>
      <div class="stat"><div class="lbl">Total Volume</div><div class="val">$${esc(ledgerSummary.totalVolumeUsd)}</div></div>
      <div class="stat"><div class="lbl">Registered Agents</div><div class="val">${ledgerSummary.agentsRegistered}</div></div>
      <div class="stat"><div class="lbl">Commons Pool</div><div class="val green">$${esc(commons.commonsPoolUsd || '0.000000')}</div></div>
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
# Keep ${keepPct}% · Spend earnings instantly or withdraw via LN / USDC</pre>
      </div>
    </div>

    <div class="card">
      <h2>Active Community Patrons (50% Funds Commons Pool)</h2>
      <table>
        <thead><tr><th>Patron</th><th>Spotlight</th><th>Contributed</th></tr></thead>
        <tbody>${patronRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Open Auto-Settling Bounties (Zero-Human Verification)</h2>
      <table>
        <thead><tr><th>Bounty</th><th>Verifier</th><th>Reward</th><th>Seats Open</th></tr></thead>
        <tbody>${bountyRows}</tbody>
      </table>
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
        <thead><tr><th>Capability</th><th>Buyer Price</th><th>Unit</th><th>p50 / p95 Latency</th></tr></thead>
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

export function renderReceiptHtml(origin, rec) {
  const attJson = rec.attestation ? JSON.stringify(rec.attestation, null, 2) : null
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Switch402 Signed Receipt ${esc(rec.receiptId)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.ico" />
  <style>
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:#080c14; color:#e2e8f0; line-height:1.55; }
    .wrap { max-width: 780px; margin: 0 auto; padding: 36px 20px 64px; }
    .card { background:#101726; border:1px solid #1e293b; border-radius:10px; padding:22px; margin-bottom:18px; }
    h1 { margin:0 0 6px; font-size:1.35rem; }
    .ok { color:#4ade80; font-family:ui-monospace, monospace; font-weight:700; }
    .mono { font-family:ui-monospace, monospace; word-break:break-all; font-size:0.84rem; }
    .row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid #1e293b; font-size:0.9rem; }
    .lbl { color:#94a3b8; }
    pre { background:#05080f; border:1px solid #1e293b; border-radius:8px; padding:12px; overflow-x:auto; font-size:0.8rem; color:#cbd5e1; }
    a { color:#38bdf8; text-decoration:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Switch<span style="color:#4ade80">402</span> Cryptographic Execution Receipt</h1>
      <div class="ok">✓ Ed25519 Signature Verified (${esc(rec.schema)})</div>
      <div style="margin-top:14px">
        <div class="row"><span class="lbl">Receipt ID</span><span class="mono">${esc(rec.receiptId)}</span></div>
        <div class="row"><span class="lbl">Capability</span><span class="mono">${esc(rec.capability)}</span></div>
        <div class="row"><span class="lbl">Route Mode</span><span class="mono">${esc(rec.mode)}</span></div>
        <div class="row"><span class="lbl">Settled Cost</span><span class="mono">$${esc(rec.grossUsd)} USD</span></div>
        <div class="row"><span class="lbl">Latency</span><span class="mono">${esc(rec.latencyMs)}ms</span></div>
        <div class="row"><span class="lbl">Timestamp (UTC)</span><span class="mono">${esc(rec.utc)}</span></div>
        <div class="row"><span class="lbl">Input SHA-256</span><span class="mono">${esc(rec.inputSha256 || '—')}</span></div>
        <div class="row"><span class="lbl">Output SHA-256</span><span class="mono">${esc(rec.outputSha256 || '—')}</span></div>
        <div class="row"><span class="lbl">Signer Key ID</span><span class="mono">${esc(rec.signerKeyId)}</span></div>
        <div class="row"><span class="lbl">Ed25519 Signature</span><span class="mono">${esc(rec.signature)}</span></div>
      </div>
      ${attJson ? `<h3 style="font-size:0.95rem;margin:18px 0 6px">Notarized Summary</h3><pre>${esc(attJson)}</pre>` : ''}
    </div>
    <div class="card">
      <div style="font-weight:600;margin-bottom:6px">Verify as JSON or run your own Switch402 calls (10 Free Starter Calls):</div>
      <pre>curl -H "Accept: application/json" ${esc(origin)}/v1/receipts/${esc(rec.receiptId)}
npx -y switch402-mcp --server ${esc(origin)}</pre>
      <div style="font-size:0.85rem;margin-top:8px"><a href="/">← Live Orderbook</a> · <a href="/llms.txt">/llms.txt</a></div>
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
