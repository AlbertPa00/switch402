#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  canonicalAuthMessage,
  generateAgentIdentity,
  sha256Hex,
  signEd25519,
} from './lib.mjs'
import { SwitchWorker } from './worker.mjs'

const CONFIG_PATH =
  process.env.SWITCH402_CONFIG || path.join(os.homedir(), '.switch402', 'agent.json')

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

function parseFlags(argv) {
  const flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      flags._.push(arg)
    }
  }
  return flags
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const cmd = flags._[0] || 'help'
  const saved = loadConfig() || {}
  const serverUrl = (
    flags.server ||
    process.env.SWITCH402_URL ||
    saved.serverUrl ||
    'https://switch402.fly.dev'
  ).replace(/\/+$/, '')

  if (cmd === 'register') {
    const identity = generateAgentIdentity()
    const res = await fetch(`${serverUrl}/v1/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: flags.name || `agent-${os.hostname().slice(0, 12)}`,
        publicJwk: identity.publicJwk,
        referredBy: flags.ref || null,
        evmAddress: flags.evm || null,
        lightningAddress: flags.ln || null,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

    const full = {
      serverUrl,
      agentId: data.agentId,
      apiKey: data.apiKey,
      referralUrlParam: data.referralUrlParam,
      identity,
    }
    saveConfig(full)
    console.log(JSON.stringify({ savedTo: CONFIG_PATH, ...data }, null, 2))
    return
  }

  if (cmd === 'market') {
    const res = await fetch(`${serverUrl}/v1/market`)
    console.log(JSON.stringify(await res.json(), null, 2))
    return
  }

  if (cmd === 'balance') {
    const apiKey = flags.key || process.env.SWITCH402_KEY || saved.apiKey
    if (!apiKey) throw new Error('Run `switch402 register` first or pass --key ag_live_...')
    const res = await fetch(`${serverUrl}/v1/agents/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    console.log(JSON.stringify(await res.json(), null, 2))
    return
  }

  if (cmd === 'deposit') {
    const apiKey = flags.key || process.env.SWITCH402_KEY || saved.apiKey
    if (!apiKey) throw new Error('Run `switch402 register` first or pass --key ag_live_...')
    const amountUsd = Number(flags.amount || 1.0)
    const res = await fetch(`${serverUrl}/v1/wallet/deposit/lightning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ amountUsd }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    console.log(JSON.stringify(data, null, 2))
    return
  }

  if (cmd === 'withdraw') {
    const apiKey = flags.key || process.env.SWITCH402_KEY || saved.apiKey
    if (!apiKey) throw new Error('Run `switch402 register` first or pass --key ag_live_...')
    const amountUsd = String(flags.amount || '')
    const destination = String(flags.dest || '')
    const rail = String(flags.rail || 'lightning')
    if (!amountUsd || !destination) {
      throw new Error('Usage: switch402 withdraw --amount 2.50 --dest <lightning_addr_or_bolt11>')
    }

    let authProof = null
    if (saved.identity?.privateJwk && saved.agentId) {
      const timestamp = Math.floor(Date.now() / 1000)
      const nonce = randomBytes(12).toString('base64url')
      const payloadHash = sha256Hex(`${amountUsd}|${rail}|${destination}`)
      const msg = canonicalAuthMessage({
        action: 'withdraw',
        agentId: saved.agentId,
        timestamp,
        nonce,
        payloadHash,
      })
      authProof = {
        timestamp,
        nonce,
        signature: signEd25519(saved.identity.privateJwk, msg),
      }
    }

    const res = await fetch(`${serverUrl}/v1/wallet/withdraw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ amountUsd, rail, destination, authProof }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    console.log(JSON.stringify(data, null, 2))
    return
  }

  if (cmd === 'act') {
    const apiKey = flags.key || process.env.SWITCH402_KEY || saved.apiKey
    const skill = flags._[1] || flags.skill
    if (!skill) throw new Error('Usage: switch402 act <skill> --input \'{"text":"hello"}\'')
    const input = flags.input ? JSON.parse(flags.input) : {}
    const res = await fetch(`${serverUrl}/v1/act/${encodeURIComponent(skill)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(input),
    })
    console.log(JSON.stringify(await res.json(), null, 2))
    return
  }

  if (cmd === 'serve') {
    let apiKey = flags.key || process.env.SWITCH402_KEY || saved.apiKey
    if (!apiKey) {
      // Zero-friction auto-registration on first `serve`
      const identity = generateAgentIdentity()
      const regRes = await fetch(`${serverUrl}/v1/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: flags.name || `worker-${os.hostname().slice(0, 12)}`,
          publicJwk: identity.publicJwk,
          referredBy: flags.ref || null,
        }),
      })
      const regData = await regRes.json()
      if (!regRes.ok) throw new Error(regData.error || `Auto-registration failed: HTTP ${regRes.status}`)
      apiKey = regData.apiKey
      saveConfig({
        serverUrl,
        agentId: regData.agentId,
        apiKey: regData.apiKey,
        referralUrlParam: regData.referralUrlParam,
        identity,
      })
      console.log(`[switch402] Auto-registered ${regData.agentId} (saved to ${CONFIG_PATH})`)
    }

    const capabilities = []
    const handlers = {}
    const localOpenAiUrl = String(flags['local-url'] || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '')

    if (flags['auto-ollama']) {
      const ollamaBase = localOpenAiUrl.replace(/\/v1$/, '')
      const tagsRes = await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(5_000) })
      if (!tagsRes.ok) {
        throw new Error(`Could not query local Ollama at ${ollamaBase}/api/tags (HTTP ${tagsRes.status})`)
      }
      const tagsJson = await tagsRes.json()
      const localModels = (tagsJson.models || []).map((m) => m.name).filter(Boolean)
      if (localModels.length === 0) {
        throw new Error('No models found in local Ollama. Pull one first (e.g. `ollama pull qwen3:32b`).')
      }
      let houseBook = []
      try {
        const mkt = await (await fetch(`${serverUrl}/v1/market`, { signal: AbortSignal.timeout(5_000) })).json()
        houseBook = mkt.houseFallbackBook || []
      } catch {
        // fallback to default pricing
      }
      for (const modelName of localModels.slice(0, 32)) {
        const houseMatch = houseBook.find((h) => h.model === modelName)
        const pricePer1MUsd = flags.price
          ? String(flags.price)
          : houseMatch
            ? (Number(houseMatch.houseBuyerPer1MUsd) * 0.85).toFixed(4)
            : '0.10'
        capabilities.push({
          capability: `llm:${modelName}`,
          pricePer1MUsd,
          description: `Auto-detected Ollama node (${modelName})`,
        })
      }
    }

    if (flags.model) {
      capabilities.push({
        capability: `llm:${flags.model}`,
        pricePer1MUsd: String(flags.price || '0.12'),
        description: flags.desc || `P2P inference node (${flags.model})`,
      })
    }

    if (flags.skill && flags.script) {
      const modUrl = pathToFileURL(path.resolve(String(flags.script))).href
      const mod = await import(modUrl)
      const capName = String(flags.skill).startsWith('act:') ? flags.skill : `act:${flags.skill}`
      capabilities.push({
        capability: capName,
        pricePerCallUsd: String(flags.price || '0.0005'),
        description: flags.desc || `Custom skill ${capName}`,
      })
      handlers[capName] = mod.default || mod.handler
    }

    if (capabilities.length === 0) {
      throw new Error(
        'Pass --auto-ollama, --model <name> (proxies local Ollama/vLLM), and/or --skill <name> --script <file.mjs>'
      )
    }

    const worker = new SwitchWorker({
      serverUrl,
      apiKey,
      capabilities,
      handlers,
      localOpenAiUrl,
      localOpenAiKey: flags['local-key'] || 'ollama',
    })

    let completedCount = 0
    worker.on('ready', (info) => {
      console.log(`[switch402] Connected as ${info.agentId} (${info.sessionId})`)
      console.log(`[switch402] Live capabilities: ${info.registeredCapabilities.join(', ')}`)
    })
    worker.on('job_completed', async (j) => {
      completedCount += 1
      let ticker = ''
      if (completedCount === 1 || completedCount % 5 === 0) {
        try {
          const me = await (
            await fetch(`${serverUrl}/v1/agents/me`, {
              headers: { Authorization: `Bearer ${apiKey}` },
              signal: AbortSignal.timeout(4_000),
            })
          ).json()
          ticker = ` | Spendable: $${me.spendableUsd} | Bond: $${me.bondedUsd}/$${me.bondTargetUsd}`
        } catch {
          // ignore transient status fetch errors
        }
      }
      console.log(`[switch402] Settled #${completedCount} ${j.jobId} (${j.capability})${ticker}`)
    })
    worker.on('job_cancelled', (j) => {
      console.log(`[switch402] Aborted cancelled job ${j.jobId} (${j.reason})`)
    })
    worker.on('slashed', (s) => {
      console.error(`[switch402] SLASHED (${s.slashedUsd} USD): ${s.reason}`)
      process.exit(1)
    })

    await worker.start()
    return
  }

  console.log(`Switch402 CLI — Stateless Agent Inference & Action Grid
Commands:
  switch402 register [--server URL] [--name HANDLE] [--ref ag_xxx]
  switch402 serve --auto-ollama [--server URL] [--local-url http://127.0.0.1:11434/v1]
  switch402 serve --model qwen/qwen3-32b --price 0.12 [--local-url http://127.0.0.1:11434/v1]
  switch402 serve --skill web.scrape --script ./handler.mjs --price 0.0004
  switch402 act <skill> --input '{"url":"https://example.com"}'
  switch402 deposit --amount 5.00
  switch402 withdraw --amount 2.50 --dest <lightning_addr_or_bolt11>
  switch402 market
  switch402 balance
`)
}

main().catch((err) => {
  console.error(`[switch402] Error: ${err.message}`)
  process.exit(1)
})
