#!/usr/bin/env node
import { createHash, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

/**
 * Switch402 Standalone Meta-MCP Server (stdio JSON-RPC 2.0, zero external dependencies).
 * Ships as a single self-contained executable file for `npx switch402-mcp`.
 */

function generateAgentIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pubJwk = publicKey.export({ format: 'jwk' })
  const privJwk = privateKey.export({ format: 'jwk' })
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${pubJwk.x}"}`
  const keyId = createHash('sha256').update(canonical).digest('base64url')
  return {
    keyId,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: pubJwk.x },
    privateJwk: privJwk,
  }
}

const args = process.argv.slice(2)
function getFlag(name, fallback) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback
}

const SERVER_URL = String(
  getFlag('server', process.env.SWITCH402_URL || 'https://switch402.fly.dev')
).replace(/\/+$/, '')

const CONFIG_PATH = getFlag(
  'config',
  process.env.SWITCH402_CONFIG || path.join(os.homedir(), '.switch402', 'agent.json')
)

let cachedApiKey = getFlag('key', process.env.SWITCH402_KEY || '')

async function ensureApiKey() {
  if (cachedApiKey) return cachedApiKey
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      if (cfg.apiKey) {
        cachedApiKey = cfg.apiKey
        return cachedApiKey
      }
    } catch {
      // fallthrough to fresh registration
    }
  }

  const identity = generateAgentIdentity()
  const resp = await fetch(`${SERVER_URL}/v1/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `mcp-${os.hostname().slice(0, 12)}`,
      publicJwk: identity.publicJwk,
    }),
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `Registration failed: HTTP ${resp.status}`)

  cachedApiKey = data.apiKey
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ serverUrl: SERVER_URL, ...data, identity }, null, 2),
    { mode: 0o600 }
  )
  return cachedApiKey
}

const TOOLS = [
  {
    name: 'find_capability',
    description:
      'Discover live capabilities and LLM inference models on the Switch402 agent grid (shows floor prices, online P2P sellers, latency, and House fallback availability).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional keyword filter (e.g. "fetch_markdown", "sha256", "verify", "qwen")',
        },
      },
    },
  },
  {
    name: 'describe_capability',
    description:
      'Inspect exact inputSchema, example JSON payload, and live pricing for any Switch402 skill or model before calling it.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: {
          type: 'string',
          description: 'Skill or model name (e.g. "web.fetch_markdown", "web.verify_url", "switch402/instant-test")',
        },
      },
      required: ['capability'],
    },
  },
  {
    name: 'act',
    description:
      'Execute an atomic JSON capability on Switch402 (auto-routes to best P2P worker or House fallback and settles in nano-USD).',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill identifier without act: prefix (e.g. "web.fetch_markdown", "web.verify_url", "util.sha256")',
        },
        input: {
          type: 'object',
          description: 'JSON input payload for the skill',
        },
        maxPriceUsd: {
          type: 'number',
          description: 'Optional ceiling price in USD for P2P routing',
        },
      },
      required: ['skill'],
    },
  },
  {
    name: 'chat_inference',
    description:
      'Run chat completion inference on any model on Switch402. Every registered agent gets 10 FREE sandbox calls on "switch402/instant-test"!',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model ID (e.g. "switch402/instant-test", "qwen/qwen3-32b")',
        },
        prompt: {
          type: 'string',
          description: 'User prompt to send to the model',
        },
        system: {
          type: 'string',
          description: 'Optional system instruction',
        },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name: 'list_unmet_demand',
    description:
      'Inspect capabilities where buyers are hitting House Fallback so you can spin up a P2P seller worker to undercut and earn 95%.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wallet_status',
    description:
      'View your Switch402 agent ID, spendable USD balance, free sandbox calls remaining, $2.00 Earned Quality Bond status, and referral earnings.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'deposit_lightning',
    description:
      'Generate a Bitcoin Lightning (bolt11) deposit invoice to top up your Switch402 agent balance.',
    inputSchema: {
      type: 'object',
      properties: {
        amountUsd: {
          type: 'number',
          description: 'Deposit amount in USD (between 0.01 and 10000, default 1.00)',
        },
      },
    },
  },
]

const RESOURCES = [
  {
    uri: 'switch402://market',
    name: 'Switch402 Live Market Orderbook',
    description: 'Live P2P capabilities, House fallback prices, and unmet demand arbitrage feed',
    mimeType: 'application/json',
  },
  {
    uri: 'switch402://wallet',
    name: 'Switch402 Agent Wallet',
    description: 'Your agent ID, spendable USD balance, free sandbox calls, and Earned Quality Bond',
    mimeType: 'application/json',
  },
]

async function executeTool(name, toolArgs = {}) {
  if (name === 'find_capability') {
    const resp = await fetch(`${SERVER_URL}/v1/market`, { signal: AbortSignal.timeout(10_000) })
    const market = await resp.json()
    const q = String(toolArgs.query || '').toLowerCase().trim()
    const filterFn = (item) =>
      !q ||
      item.capability.toLowerCase().includes(q) ||
      String(item.description || '').toLowerCase().includes(q)

    return {
      onlineWorkers: market.onlineWorkers,
      p2pCapabilities: (market.p2pBook || []).filter(filterFn),
      houseCapabilities: (market.houseFallbackBook || []).filter(filterFn),
    }
  }

  if (name === 'describe_capability') {
    const resp = await fetch(`${SERVER_URL}/v1/market`, { signal: AbortSignal.timeout(10_000) })
    const market = await resp.json()
    const target = String(toolArgs.capability || '').trim()
    const all = [...(market.p2pBook || []), ...(market.houseFallbackBook || [])]
    const found = all.find(
      (x) =>
        x.capability === target ||
        x.skill === target ||
        x.model === target ||
        x.capability === `act:${target}` ||
        x.capability === `llm:${target}`
    )
    return found || { error: `Capability "${target}" not found`, available: all.map((x) => x.capability) }
  }

  if (name === 'list_unmet_demand') {
    const resp = await fetch(`${SERVER_URL}/v1/market`, { signal: AbortSignal.timeout(10_000) })
    const market = await resp.json()
    return {
      unmetDemandFeed: market.unmetDemandFeed || [],
      tip: 'Run `npx switch402 serve --auto-ollama` or `npx switch402 serve --model <id> --price <suggestedUndercutUsd>` to capture 100% of flow.',
    }
  }

  if (name === 'wallet_status') {
    const key = await ensureApiKey()
    const resp = await fetch(`${SERVER_URL}/v1/agents/me`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    return await resp.json()
  }

  if (name === 'deposit_lightning') {
    const key = await ensureApiKey()
    const resp = await fetch(`${SERVER_URL}/v1/wallet/deposit/lightning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ amountUsd: toolArgs.amountUsd ?? 1.0 }),
      signal: AbortSignal.timeout(12_000),
    })
    return await resp.json()
  }

  if (name === 'act') {
    const key = await ensureApiKey()
    const skill = String(toolArgs.skill || '').replace(/^act:/, '')
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    }
    if (toolArgs.maxPriceUsd !== undefined) {
      headers['X-Max-Price-Usd'] = String(toolArgs.maxPriceUsd)
    }
    const resp = await fetch(`${SERVER_URL}/v1/act/${encodeURIComponent(skill)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolArgs.input || {}),
      signal: AbortSignal.timeout(45_000),
    })
    const body = await resp.json()
    if (resp.status === 402) {
      return {
        status: 402,
        ...body,
        nextSteps: {
          tryFreeSandbox: 'Call chat_inference with model="switch402/instant-test" (10 free sandbox calls included!)',
          topupLightning: 'Call deposit_lightning(amountUsd=1.0) to get a bolt11 invoice',
          topupBaseUsdc: `POST ${SERVER_URL}/v1/wallet/topup/x402?amountUsd=1.00`,
          earnCreditsFree: `npx switch402 serve --auto-ollama --server ${SERVER_URL}`,
        },
      }
    }
    return body
  }

  if (name === 'chat_inference') {
    const key = await ensureApiKey()
    const messages = []
    if (toolArgs.system) messages.push({ role: 'system', content: String(toolArgs.system) })
    messages.push({ role: 'user', content: String(toolArgs.prompt || '') })

    const resp = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: toolArgs.model,
        messages,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const json = await resp.json()
    if (resp.status === 402) {
      return {
        status: 402,
        ...json,
        nextSteps: {
          tryFreeSandbox: 'Call chat_inference with model="switch402/instant-test" (10 free sandbox calls included!)',
          topupLightning: 'Call deposit_lightning(amountUsd=1.0) to get a bolt11 invoice',
          topupBaseUsdc: `POST ${SERVER_URL}/v1/wallet/topup/x402?amountUsd=1.00`,
          earnCreditsFree: `npx switch402 serve --auto-ollama --server ${SERVER_URL}`,
        },
      }
    }
    return {
      status: resp.status,
      receiptId: resp.headers.get('x-switch402-receipt'),
      mode: resp.headers.get('x-switch402-mode'),
      costUsd: resp.headers.get('x-switch402-cost-usd'),
      sandboxRemaining: resp.headers.get('x-switch402-sandbox-remaining'),
      reply: json?.choices?.[0]?.message?.content ?? json,
    }
  }

  throw new Error(`Unknown MCP tool: ${name}`)
}

function sendRpc(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

async function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.id === undefined || msg.id === null) return

  try {
    if (msg.method === 'initialize') {
      sendRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'switch402-mcp', version: '0.1.2' },
        },
      })
      return
    }

    if (msg.method === 'ping') {
      sendRpc({ jsonrpc: '2.0', id: msg.id, result: {} })
      return
    }

    if (msg.method === 'tools/list') {
      sendRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: TOOLS },
      })
      return
    }

    if (msg.method === 'resources/list') {
      sendRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: { resources: RESOURCES },
      })
      return
    }

    if (msg.method === 'resources/read') {
      const uri = msg.params?.uri
      if (uri === 'switch402://market') {
        const data = await executeTool('find_capability', {})
        sendRpc({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
          },
        })
        return
      }
      if (uri === 'switch402://wallet') {
        const data = await executeTool('wallet_status', {})
        sendRpc({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
          },
        })
        return
      }
      sendRpc({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: `Unknown resource URI: ${uri}` },
      })
      return
    }

    if (msg.method === 'tools/call') {
      const toolName = msg.params?.name
      const toolArgs = msg.params?.arguments || {}
      try {
        const out = await executeTool(toolName, toolArgs)
        sendRpc({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          },
        })
      } catch (toolErr) {
        sendRpc({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Error: ${toolErr.message}` }],
          },
        })
      }
      return
    }

    sendRpc({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    })
  } catch (err) {
    sendRpc({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32603, message: err.message },
    })
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('Content-Length:')) return
  try {
    const parsed = JSON.parse(trimmed)
    handleRpcMessage(parsed)
  } catch {
    // ignore non-JSON framing lines
  }
})
