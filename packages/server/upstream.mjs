import { createHash, randomUUID } from 'node:crypto'
import dns from 'node:dns'
import net from 'node:net'
import { usdToNano } from '../protocol/index.mjs'

const MAX_VERIFY_BODY_BYTES = 2 * 1024 * 1024 // 2 MB hard cap

/**
 * Validate that a target URL resolves strictly to public unicast IP space (blocks SSRF against
 * loopback, RFC1918 LAN, CGNAT, link-local, cloud metadata 169.254.169.254, and ::ffff: mapped IPs).
 */
export async function assertSafePublicUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl))
  } catch {
    throw new Error('Invalid URL format')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are permitted')
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are prohibited')
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error(`Blocked internal/reserved hostname: ${host}`)
  }

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error(`Blocked private or reserved IP address: ${host}`)
    }
    return parsed
  }

  const records = await dns.promises.lookup(host, { all: true, verbatim: true })
  if (!records || records.length === 0) {
    throw new Error(`DNS resolution returned no records for ${host}`)
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error(`Hostname ${host} resolves to blocked private/reserved IP (${rec.address})`)
    }
  }
  return parsed
}

export function isPrivateOrReservedIp(ipStr) {
  const ip = String(ipStr).trim().toLowerCase()

  // Unwrap IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1` or hex `::ffff:7f00:1`)
  if (ip.startsWith('::ffff:')) {
    const tail = ip.slice(7)
    if (net.isIPv4(tail)) return isPrivateOrReservedIp(tail)
    const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16)
      const lo = parseInt(hexMatch[2], 16)
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
      return isPrivateOrReservedIp(v4)
    }
    return true
  }

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0) return true // 0.0.0.0/8
    if (a === 10) return true // 10.0.0.0/8 RFC1918
    if (a === 127) return true // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return true // 192.168.0.0/16 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    if (a >= 224) return true // multicast & reserved
    return false
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true // fc00::/7 ULA
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
      return true // fe80::/10 link-local
    }
    if (ip.startsWith('ff')) return true // multicast
    if (ip.startsWith('2001:db8:')) return true // documentation
    return false
  }

  return true
}

/**
 * Day-1 House Fallback Upstream Engine.
 */
export class HouseUpstream {
  /**
   * @param {object} [opts]
   * @param {string} [opts.upstreamUrl]
   * @param {string} [opts.upstreamKey]
   * @param {Record<string, string>} [opts.modelPricePerMillionUsd]
   */
  constructor(opts = {}) {
    this.upstreamUrl = (opts.upstreamUrl || '').replace(/\/+$/, '')
    this.upstreamKey = opts.upstreamKey || ''

    this.modelWholesalePer1M = {
      'switch402/instant-test': '0.10',
      'qwen/qwen3-32b': '0.20',
      'meta-llama/llama-3.3-70b-instruct': '0.40',
      'deepseek/deepseek-chat': '0.28',
      'openai/gpt-4o-mini': '0.30',
      ...(opts.modelPricePerMillionUsd || {}),
    }

    this.skillWholesaleUsd = {
      'util.sha256': '0.0005',
      'util.json_validate': '0.0005',
      'util.markdown_clean': '0.0008',
      'web.verify_url': '0.0020',
      'web.fetch_markdown': '0.0050',
      'web.search': '0.0050',
      'chain.token_report': '0.0100',
      'market.quote': '0.0005',
      'trade.signal': '0.0015',
      'trade.notarize': '0.0005',
    }

    this.skillMeta = {
      'util.sha256': {
        description: 'Compute SHA-256 hex digest and UTF-8 byte length of a string',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Input text to hash' } },
          required: ['text'],
        },
        example: { text: 'hello world' },
      },
      'util.json_validate': {
        description: 'Validate JSON syntax and report parsed root type or parse error',
        inputSchema: {
          type: 'object',
          properties: { json: { type: 'string', description: 'JSON string or value to validate' } },
          required: ['json'],
        },
        example: { json: '{"ok":true}' },
      },
      'util.markdown_clean': {
        description: 'Strip HTML tags, scripts, and styles into clean plaintext/markdown',
        inputSchema: {
          type: 'object',
          properties: { html: { type: 'string', description: 'Raw HTML content' } },
          required: ['html'],
        },
        example: { html: '<h1>Hello</h1><p>World</p>' },
      },
      'web.verify_url': {
        description: 'SSRF-safe HTTP notary: fetch public URL and return status, byte length, SHA-256, UTC timestamp, and signed receipt URL',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Public http(s) URL to notarize' } },
          required: ['url'],
        },
        example: { url: 'https://example.com' },
      },
      'web.fetch_markdown': {
        description: 'SSRF-safe web reader: fetch any public URL and return clean readable Markdown + page title',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Public http(s) URL to fetch and convert to Markdown' },
            maxChars: { type: 'number', description: 'Optional max output character length (default 16000, max 64000)' },
          },
          required: ['url'],
        },
        example: { url: 'https://example.com', maxChars: 8000 },
      },
      'web.search': {
        description: 'Keyless web search: top organic results with titles, URLs, and snippets (no API key, no account, no rate-limit subscription needed)',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Search query' },
            maxResults: { type: 'number', description: 'Optional max results (default 8, max 20)' },
          },
          required: ['q'],
        },
        example: { q: 'x402 payment protocol', maxResults: 5 },
      },
      'chain.token_report': {
        description: 'Base token pre-trade safety & liquidity report: contract bytecode + holder concentration + honeypot/tax/owner flags + DEX liquidity/FDV/pair-age in one call',
        inputSchema: {
          type: 'object',
          properties: {
            address: { type: 'string', description: '0x contract address of the token on Base (chainId 8453)' },
          },
          required: ['address'],
        },
        example: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
      },
      'market.quote': {
        description: 'Sub-second multi-venue crypto spot ticker (Binance Vision + Coinbase): mid price, best bid/ask, spread bps, and 24h volume/change',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Asset ticker or pair (e.g. "BTC", "ETH-USD", "SOLUSDT")' },
          },
          required: ['symbol'],
        },
        example: { symbol: 'BTC-USD' },
      },
      'trade.signal': {
        description: 'Sub-second quantitative regime & trade signal engine (EMA-9/21, RSI-14, ATR%, Bollinger %B) from live OHLCV klines or deterministic candles array',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Asset ticker or pair (e.g. "ETH-USD", "BTC", "SOL")' },
            interval: { type: 'string', description: 'Candle interval: "1m", "5m", "15m", "1h", "4h", "1d" (default "5m")' },
            candles: {
              type: 'array',
              description: 'Optional deterministic close/OHLC array (min 22 items) for offline evaluation & canary verification',
            },
          },
        },
        example: { symbol: 'ETH-USD', interval: '5m' },
      },
      'trade.notarize': {
        description: 'Cryptographic pre-trade / bounty commitment notary: canonical JSON SHA-256 digest + UTC timestamp + verifiable Switch402 receipt',
        inputSchema: {
          type: 'object',
          properties: {
            payload: { description: 'Decision object or string payload to commit and timestamp' },
            note: { type: 'string', description: 'Optional context label (e.g. strategy ID or bounty task ID)' },
          },
          required: ['payload'],
        },
        example: { payload: { symbol: 'ETH-USD', action: 'buy', price: 3120.5 }, note: 'arb-v1' },
      },
    }

    /** @type {Map<string, { calls: number, lastCallAt: number }>} */
    this.unmetDemandTracker = new Map()
  }

  recordHouseHit(capability) {
    const prev = this.unmetDemandTracker.get(capability) || { calls: 0, lastCallAt: 0 }
    prev.calls += 1
    prev.lastCallAt = Date.now()
    this.unmetDemandTracker.set(capability, prev)
  }

  listAvailableCapabilities() {
    const models = Object.entries(this.modelWholesalePer1M)
      .filter(([m]) => m === 'switch402/instant-test' || Boolean(this.upstreamKey))
      .map(([model, wholesalePer1M]) => ({
        capability: `llm:${model}`,
        kind: 'chat',
        model,
        houseWholesalePer1MUsd: wholesalePer1M,
        houseBuyerPer1MUsd: (Number(wholesalePer1M) * 1.1).toFixed(4),
      }))

    const skills = Object.entries(this.skillWholesaleUsd).map(([skill, wholesaleUsd]) => {
      const meta = this.skillMeta[skill] || {}
      return {
        capability: `act:${skill}`,
        kind: 'act',
        skill,
        description: meta.description || `Atomic capability ${skill}`,
        inputSchema: meta.inputSchema || null,
        example: meta.example || null,
        houseWholesaleUsd: wholesaleUsd,
        houseBuyerUsd: (Number(wholesaleUsd) * 1.1).toFixed(6),
      }
    })

    return [...models, ...skills]
  }

  estimateMaxWholesaleNano(capability, body = {}) {
    if (capability.startsWith('llm:')) {
      const model = capability.slice(4)
      const rateUsd = Number(this.modelWholesalePer1M[model] || '0.50')
      const maxTokens = Math.min(Math.max(Number(body.max_tokens || 1024), 64), 16384)
      const promptChars = JSON.stringify(body.messages || []).length
      const estTokens = Math.ceil(promptChars / 3) + maxTokens
      const estUsd = Math.max((estTokens / 1_000_000) * rateUsd, 0.00001)
      return usdToNano(estUsd.toFixed(9))
    }

    const skill = capability.startsWith('act:') ? capability.slice(4) : capability
    const fixed = this.skillWholesaleUsd[skill]
    if (fixed) return usdToNano(fixed)
    return usdToNano('0.001')
  }

  canFulfill(capability) {
    if (capability === 'llm:switch402/instant-test') return true
    if (capability.startsWith('llm:')) return Boolean(this.upstreamUrl && this.upstreamKey)
    const skill = capability.startsWith('act:') ? capability.slice(4) : capability
    return Object.prototype.hasOwnProperty.call(this.skillWholesaleUsd, skill)
  }

  /**
   * Zero-marginal-cost capabilities eligible for registered-agent free starter sandbox calls.
   */
  isSandboxEligible(capability) {
    if (capability === 'llm:switch402/instant-test') return true
    if (capability.startsWith('llm:')) return false
    const skill = capability.startsWith('act:') ? capability.slice(4) : capability
    return Object.prototype.hasOwnProperty.call(this.skillWholesaleUsd, skill)
  }

  async executeChat(model, body, { onSseChunk, signal } = {}) {
    this.recordHouseHit(`llm:${model}`)

    if (model === 'switch402/instant-test' || !this.upstreamKey) {
      if (model !== 'switch402/instant-test' && !this.upstreamKey) {
        throw new Error(`No P2P seller online for ${model} and HOUSE_UPSTREAM_KEY is not configured`)
      }
      return this._runSyntheticTestModel(model, body, { onSseChunk })
    }

    const isStream = Boolean(body.stream)
    const res = await fetch(`${this.upstreamUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.upstreamKey}`,
      },
      body: JSON.stringify({ ...body, model }),
      signal: signal || AbortSignal.timeout(45_000),
    })

    if (!res.ok) {
      const errTxt = await res.text().catch(() => '')
      throw new Error(`House upstream HTTP ${res.status}: ${errTxt.slice(0, 200)}`)
    }

    const ratePer1M = Number(this.modelWholesalePer1M[model] || '0.50')

    if (!isStream) {
      const json = await res.json()
      const totalTokens =
        json?.usage?.total_tokens ||
        Math.ceil((JSON.stringify(body.messages || []).length + JSON.stringify(json).length) / 4)
      const wholesaleUsd = Math.max((totalTokens / 1_000_000) * ratePer1M, 0.000005)
      return {
        wholesaleNano: usdToNano(wholesaleUsd.toFixed(9)),
        totalTokens,
        responseObj: json,
      }
    }

    const decoder = new TextDecoder()
    let streamedChars = 0
    for await (const chunk of res.body) {
      const text = decoder.decode(chunk, { stream: true })
      streamedChars += text.length
      if (onSseChunk) onSseChunk(text)
    }
    const promptTokens = Math.ceil(JSON.stringify(body.messages || []).length / 4)
    const completionTokens = Math.max(Math.ceil(streamedChars / 16), 1)
    const totalTokens = promptTokens + completionTokens
    const wholesaleUsd = Math.max((totalTokens / 1_000_000) * ratePer1M, 0.000005)

    return {
      wholesaleNano: usdToNano(wholesaleUsd.toFixed(9)),
      totalTokens,
      responseObj: null,
    }
  }

  async executeSkill(skill, input = {}) {
    this.recordHouseHit(`act:${skill}`)
    const wholesaleNano = usdToNano(this.skillWholesaleUsd[skill] || '0.001')

    switch (skill) {
      case 'util.sha256': {
        const text = String(input.text ?? '')
        return {
          wholesaleNano,
          output: {
            sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
            bytes: Buffer.byteLength(text, 'utf8'),
          },
        }
      }

      case 'util.json_validate': {
        const raw = typeof input.json === 'string' ? input.json : JSON.stringify(input.json ?? '')
        try {
          const parsed = JSON.parse(raw)
          return {
            wholesaleNano,
            output: { valid: true, type: Array.isArray(parsed) ? 'array' : typeof parsed },
          }
        } catch (err) {
          return {
            wholesaleNano,
            output: { valid: false, error: err.message },
          }
        }
      }

      case 'util.markdown_clean': {
        const html = String(input.html ?? '')
        const clean = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<\/?(h[1-6]|p|div|br|li|tr)[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        return {
          wholesaleNano,
          output: { markdown: clean, length: clean.length },
        }
      }

      case 'web.verify_url': {
        let currentUrl = String(input.url || '')
        let resp = null
        // Validate each hop manually to defeat HTTP 302 redirect-to-metadata SSRF
        for (let hop = 0; hop < 4; hop++) {
          const safeUrl = await assertSafePublicUrl(currentUrl)
          resp = await fetch(safeUrl.href, {
            headers: { 'User-Agent': 'Switch402-Notary/1.0' },
            redirect: 'manual',
            signal: AbortSignal.timeout(12_000),
          })
          if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
            currentUrl = new URL(resp.headers.get('location'), safeUrl.href).href
            continue
          }
          break
        }

        const hash = createHash('sha256')
        let totalBytes = 0
        if (resp.body) {
          for await (const chunk of resp.body) {
            totalBytes += chunk.length
            if (totalBytes > MAX_VERIFY_BODY_BYTES) {
              throw new Error(`Target response exceeded ${MAX_VERIFY_BODY_BYTES} byte Notary cap`)
            }
            hash.update(chunk)
          }
        }

        return {
          wholesaleNano,
          output: {
            url: currentUrl,
            status: resp.status,
            bytes: totalBytes,
            sha256: hash.digest('hex'),
            fetchedUtc: new Date().toISOString(),
          },
        }
      }

      case 'web.fetch_markdown': {
        let currentUrl = String(input.url || '')
        let resp = null
        for (let hop = 0; hop < 4; hop++) {
          const safeUrl = await assertSafePublicUrl(currentUrl)
          resp = await fetch(safeUrl.href, {
            headers: {
              'User-Agent': 'Switch402-Reader/1.0 (+https://switch402.fly.dev)',
              Accept: 'text/html,text/markdown,text/plain;q=0.9,*/*;q=0.1',
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(12_000),
          })
          if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
            currentUrl = new URL(resp.headers.get('location'), safeUrl.href).href
            continue
          }
          break
        }

        const chunks = []
        let totalBytes = 0
        if (resp.body) {
          for await (const chunk of resp.body) {
            totalBytes += chunk.length
            if (totalBytes > MAX_VERIFY_BODY_BYTES) {
              throw new Error(`Target response exceeded ${MAX_VERIFY_BODY_BYTES} byte Reader cap`)
            }
            chunks.push(chunk)
          }
        }
        const rawText = Buffer.concat(chunks).toString('utf8')
        const titleMatch = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
        const title = titleMatch ? decodeBasicEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : ''
        const maxChars = Math.min(Math.max(Number(input.maxChars || 16_000), 200), 64_000)
        const md = htmlToReadableMarkdown(rawText)
        const truncated = md.length > maxChars
        const markdown = truncated ? `${md.slice(0, maxChars)}\n\n[truncated]` : md

        return {
          wholesaleNano,
          output: {
            url: currentUrl,
            status: resp.status,
            title,
            markdown,
            length: markdown.length,
            truncated,
            fetchedUtc: new Date().toISOString(),
          },
        }
      }

      case 'web.search': {
        const q = String(input.q ?? input.query ?? '').trim()
        if (!q || q.length > 400) {
          throw new Error('web.search requires "q": non-empty search query (max 400 chars)')
        }
        const maxResults = Math.min(Math.max(Number(input.maxResults || 8), 1), 20)
        const res = await fetch('https://lite.duckduckgo.com/lite/', {
          method: 'POST',
          headers: {
            'User-Agent': 'Switch402-Search/1.0 (+https://switch402.fly.dev)',
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/html',
          },
          body: `q=${encodeURIComponent(q)}`,
          signal: AbortSignal.timeout(12_000),
        })
        if (!res.ok) {
          throw new Error(`Search upstream HTTP ${res.status}`)
        }
        const html = await res.text()
        const results = parseDuckDuckGoLiteResults(html, maxResults)
        return {
          wholesaleNano,
          output: {
            query: q,
            engine: 'duckduckgo-lite',
            resultCount: results.length,
            results,
            fetchedUtc: new Date().toISOString(),
          },
        }
      }

      case 'chain.token_report': {
        const address = String(input.address ?? input.token ?? '').trim()
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
          throw new Error(
            'chain.token_report requires "address": a 0x-prefixed 20-byte token contract on Base'
          )
        }
        const report = await fetchBaseTokenReport(address.toLowerCase())
        return { wholesaleNano, output: report }
      }

      case 'market.quote': {
        const rawSym = String(input.symbol ?? input.pair ?? '').trim()
        if (!rawSym) {
          throw new Error('market.quote requires "symbol" (e.g. "BTC", "ETH-USD", "SOLUSDT")')
        }
        const quote = await fetchMultiVenueQuote(rawSym)
        return { wholesaleNano, output: quote }
      }

      case 'trade.signal': {
        if (Array.isArray(input.candles)) {
          const sig = computeTradeSignalFromCandles(input.candles, {
            symbol: String(input.symbol || 'CUSTOM'),
            interval: String(input.interval || 'custom'),
            source: 'deterministic_candles',
          })
          return { wholesaleNano, output: sig }
        }
        const rawSym = String(input.symbol ?? input.pair ?? '').trim()
        if (!rawSym) {
          throw new Error(
            'trade.signal requires either "symbol" (e.g. "ETH-USD") or a deterministic "candles" array'
          )
        }
        const interval = normalizeCandleInterval(input.interval)
        const { candles, source, normalizedSymbol } = await fetchMarketCandles(rawSym, interval)
        const sig = computeTradeSignalFromCandles(candles, {
          symbol: normalizedSymbol,
          interval,
          source,
        })
        return { wholesaleNano, output: sig }
      }

      case 'trade.notarize': {
        if (input.payload === undefined || input.payload === null || input.payload === '') {
          throw new Error('trade.notarize requires a non-empty "payload" object or string')
        }
        const canonical =
          typeof input.payload === 'string' ? input.payload : canonicalJsonString(input.payload)
        const sha256 = createHash('sha256').update(canonical, 'utf8').digest('hex')
        return {
          wholesaleNano,
          output: {
            sha256,
            bytes: Buffer.byteLength(canonical, 'utf8'),
            canonicalPayload: canonical.length <= 4096 ? canonical : `${canonical.slice(0, 4096)}...[truncated]`,
            note: input.note ? String(input.note).slice(0, 240) : null,
            notarizedUtc: new Date().toISOString(),
          },
        }
      }

      default:
        throw new Error(`Unsupported House skill: ${skill}`)
    }
  }

  async _runSyntheticTestModel(model, body, { onSseChunk }) {
    const lastMsg =
      Array.isArray(body.messages) && body.messages.length > 0
        ? String(body.messages[body.messages.length - 1].content || '')
        : ''
    const reply = `[house:${model}] Ready. Echo: ${lastMsg.slice(0, 180)}`
    const totalTokens = Math.max(Math.ceil((lastMsg.length + reply.length) / 4), 10)
    const wholesaleUsd = Math.max((totalTokens / 1_000_000) * 0.1, 0.00001)
    const wholesaleNano = usdToNano(wholesaleUsd.toFixed(9))
    const id = `chatcmpl_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const created = Math.floor(Date.now() / 1000)

    if (body.stream && onSseChunk) {
      const words = reply.split(' ')
      for (let i = 0; i < words.length; i++) {
        const piece = (i === 0 ? '' : ' ') + words[i]
        const frame = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        }
        onSseChunk(`data: ${JSON.stringify(frame)}\n\n`)
      }
      const stopFrame = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      onSseChunk(`data: ${JSON.stringify(stopFrame)}\n\ndata: [DONE]\n\n`)
      return { wholesaleNano, totalTokens, responseObj: null }
    }

    return {
      wholesaleNano,
      totalTokens,
      responseObj: {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(lastMsg.length / 4),
          completion_tokens: Math.ceil(reply.length / 4),
          total_tokens: totalTokens,
        },
      },
    }
  }
}

function decodeBasicEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => {
      const cp = parseInt(h, 16)
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/&#(\d{1,7});/g, (_, d) => {
      const cp = parseInt(d, 10)
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
}

function htmlToReadableMarkdown(html) {
  return decodeBasicEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '')
      .replace(/<(h1)[^>]*>([\s\S]*?)<\/\1>/gi, '\n\n# $2\n\n')
      .replace(/<(h2)[^>]*>([\s\S]*?)<\/\1>/gi, '\n\n## $2\n\n')
      .replace(/<(h3)[^>]*>([\s\S]*?)<\/\1>/gi, '\n\n### $2\n\n')
      .replace(/<(h[4-6])[^>]*>([\s\S]*?)<\/\1>/gi, '\n\n#### $2\n\n')
      .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/?(p|div|br|tr|section|article|header|footer|main)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const DDG_RESULT_TOKEN_RE =
  /<a[^>]+href="([^"]+)"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>|class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g

/**
 * Parse DuckDuckGo Lite SERP HTML into [{position,title,url,snippet}].
 * `result-link` anchors carry title+URL; the `result-snippet` <td> directly after carries the excerpt.
 */
export function parseDuckDuckGoLiteResults(html, maxResults = 8) {
  const text = String(html || '')
  const results = []
  let m
  DDG_RESULT_TOKEN_RE.lastIndex = 0
  while ((m = DDG_RESULT_TOKEN_RE.exec(text)) !== null) {
    if (m[1] !== undefined) {
      if (results.length >= maxResults) break
      if (!/^https?:\/\//i.test(m[1])) continue
      results.push({
        position: results.length + 1,
        title: decodeBasicEntities(m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()),
        url: m[1],
        snippet: '',
      })
    } else if (results.length > 0 && !results[results.length - 1].snippet) {
      results[results.length - 1].snippet = decodeBasicEntities(
        m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      )
    }
  }
  return results
}

const BASE_RPC_URL = 'https://mainnet.base.org'
const BASE_CHAIN_ID = 8453

async function timedSource(name, fn) {
  const started = Date.now()
  try {
    return { name, ok: true, ms: Date.now() - started, data: await fn() }
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, error: String(err.message || err) }
  }
}

/**
 * One-call Base token pre-trade report. Fans out to Base public RPC (batched
 * eth_getCode + eth_call name/symbol/decimals/totalSupply/owner), DexScreener
 * (DEX liquidity/FDV/pair age) and GoPlus (honeypot/tax/owner security flags).
 * Throws only if ALL sources fail, so buyers never pay for an empty report.
 */
export async function fetchBaseTokenReport(address) {
  const [rpc, dex, goplus] = await Promise.all([
    timedSource('base_rpc', () => fetchBaseRpcTokenData(address)),
    timedSource('dexscreener', () => fetchDexScreenerTokenData(address)),
    timedSource('goplus', () => fetchGoPlusTokenSecurity(address)),
  ])

  if (!rpc.ok && !dex.ok && !goplus.ok) {
    throw new Error(
      `All report sources failed: ${rpc.error}; ${dex.error}; ${goplus.error}`
    )
  }

  return buildTokenReport({
    address,
    token: rpc.ok ? rpc.data : null,
    market: dex.ok ? dex.data : null,
    security: goplus.ok ? goplus.data : null,
    sources: [
      { name: rpc.name, ok: rpc.ok, ms: rpc.ms, ...(rpc.ok ? {} : { error: rpc.error }) },
      { name: dex.name, ok: dex.ok, ms: dex.ms, ...(dex.ok ? {} : { error: dex.error }) },
      { name: goplus.name, ok: goplus.ok, ms: goplus.ms, ...(goplus.ok ? {} : { error: goplus.error }) },
    ],
  })
}

async function fetchBaseRpcTokenData(address) {
  const batch = [
    { id: 1, method: 'eth_getCode', params: [address, 'latest'] },
    { id: 2, method: 'eth_call', params: [{ to: address, data: '0x06fdde03' }, 'latest'] }, // name()
    { id: 3, method: 'eth_call', params: [{ to: address, data: '0x95d89b41' }, 'latest'] }, // symbol()
    { id: 4, method: 'eth_call', params: [{ to: address, data: '0x313ce567' }, 'latest'] }, // decimals()
    { id: 5, method: 'eth_call', params: [{ to: address, data: '0x18160ddd' }, 'latest'] }, // totalSupply()
    { id: 6, method: 'eth_call', params: [{ to: address, data: '0x8da5cb5b' }, 'latest'] }, // owner()
  ].map((c) => ({ jsonrpc: '2.0', ...c }))

  const res = await fetch(BASE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(9_000),
  })
  if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`)
  const arr = await res.json()
  const byId = new Map((Array.isArray(arr) ? arr : [arr]).map((r) => [r.id, r]))
  const ok = (id) => {
    const r = byId.get(id)
    return r && !r.error && typeof r.result === 'string' ? r.result : null
  }

  const code = ok(1) || '0x'
  const isContract = strip0x(code).length > 0
  return {
    isContract,
    bytecodeBytes: Math.floor(strip0x(code).length / 2),
    name: decodeAbiString(ok(2)),
    symbol: decodeAbiString(ok(3)),
    decimals: ok(4) !== null ? Number(decodeAbiUint(ok(4))) : null,
    totalSupplyRaw: ok(5) !== null ? decodeAbiUint(ok(5)).toString() : null,
    owner: decodeAbiAddress(ok(6)),
  }
}

async function fetchDexScreenerTokenData(address) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`)
  const json = await res.json()
  const pairs = (json.pairs || [])
    .filter((p) => p.chainId === 'base')
    .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0))

  if (pairs.length === 0) {
    return { listed: false, pairCount: 0 }
  }

  const oldestMs = Math.min(
    ...pairs.map((p) => Number(p.pairCreatedAt || Date.now())).filter((n) => n > 0)
  )
  const txns24h = pairs.reduce(
    (acc, p) => {
      acc.buys += Number(p.txns?.h24?.buys || 0)
      acc.sells += Number(p.txns?.h24?.sells || 0)
      return acc
    },
    { buys: 0, sells: 0 }
  )

  return {
    listed: true,
    pairCount: pairs.length,
    dexes: [...new Set(pairs.map((p) => p.dexId))],
    priceUsd: pairs[0].priceUsd ? Number(pairs[0].priceUsd) : null,
    fdvUsd: pairs[0].fdv ? Number(pairs[0].fdv) : null,
    liquidityUsd: Math.round(
      pairs.reduce((s, p) => s + Number(p.liquidity?.usd || 0), 0) * 100
    ) / 100,
    volume24hUsd: Math.round(
      pairs.reduce((s, p) => s + Number(p.volume?.h24 || 0), 0) * 100
    ) / 100,
    txns24h,
    oldestPairAgeDays: Math.round(((Date.now() - oldestMs) / 86_400_000) * 10) / 10,
    topPairs: pairs.slice(0, 5).map((p) => ({
      dexId: p.dexId,
      pairAddress: p.pairAddress,
      liquidityUsd: p.liquidity?.usd ?? null,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      pairUrl: p.url || null,
    })),
  }
}

async function fetchGoPlusTokenSecurity(address) {
  const res = await fetch(
    `https://api.gopluslabs.io/api/v1/token_security/${BASE_CHAIN_ID}?contract_addresses=${address}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) }
  )
  if (!res.ok) throw new Error(`GoPlus HTTP ${res.status}`)
  const json = await res.json()
  const g = json?.result?.[address]
  if (!g) return { scanned: false }

  const flag = (k) => String(g[k] ?? '0') === '1'
  const pct = (k) => {
    const v = g[k]
    if (v === undefined || v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const holderPcts = (Array.isArray(g.holders) ? g.holders : [])
    .map((h) => Number(h.percent || 0))
    .sort((a, b) => b - a)

  return {
    scanned: true,
    isHoneypot: flag('is_honeypot'),
    honeypotWithSameCreator: flag('honeypot_with_same_creator'),
    cannotSellAll: flag('cannot_sell_all'),
    cannotBuy: flag('cannot_buy'),
    buyTaxPct: pct('buy_tax'),
    sellTaxPct: pct('sell_tax'),
    isOpenSource: flag('is_open_source'),
    isProxy: flag('is_proxy'),
    isMintable: flag('is_mintable'),
    isBlacklisted: flag('is_blacklisted'),
    isWhitelisted: flag('is_whitelisted'),
    hiddenOwner: flag('hidden_owner'),
    canTakeBackOwnership: flag('can_take_back_ownership'),
    ownerChangeBalance: flag('owner_change_balance'),
    transferPausable: flag('transfer_pausable'),
    slippageModifiable: flag('slippage_modifiable') || flag('personal_slippage_modifiable'),
    antiWhaleModifiable: flag('anti_whale_modifiable'),
    tradingCooldown: flag('trading_cooldown'),
    ownerAddress: g.owner_address || null,
    creatorAddress: g.creator_address || null,
    holderCount: g.holder_count ? Number(g.holder_count) : null,
    top10HolderPct:
      holderPcts.length > 0
        ? Math.round(holderPcts.slice(0, 10).reduce((s, p) => s + p, 0) * 1000) / 1000
        : null,
    lpHolderCount: g.lp_holder_count ? Number(g.lp_holder_count) : null,
    inDex: flag('is_in_dex'),
  }
}

function strip0x(h) {
  return String(h || '').replace(/^0x/i, '')
}

function decodeAbiUint(hex) {
  const h = strip0x(hex)
  if (!h) return 0n
  try {
    return BigInt(`0x${h}`)
  } catch {
    return 0n
  }
}

function decodeAbiAddress(hex) {
  const h = strip0x(hex)
  if (h.length < 40) return null
  const addr = `0x${h.slice(-40).toLowerCase()}`
  return /^0x0{40}$/.test(addr) ? null : addr
}

function decodeAbiString(hex) {
  const h = strip0x(hex)
  if (!h) return null
  try {
    // bytes32 return (fixed 32-byte word — used by some older token contracts)
    if (h.length <= 64) {
      const bytes = Buffer.from(h.padEnd(64, '0').slice(0, 64), 'hex')
      const end = bytes.indexOf(0)
      return bytes.subarray(0, end === -1 ? 32 : end).toString('utf8') || null
    }
    // Dynamic ABI string: word0 = byte offset, word@offset = length, then UTF-8 bytes
    const offset = Number(BigInt(`0x${h.slice(0, 64)}`)) * 2
    const len = Number(BigInt(`0x${h.slice(offset, offset + 64)}`))
    if (!Number.isFinite(len) || len < 0 || len > 4096) return null
    const raw = h.slice(offset + 64, offset + 64 + len * 2)
    return Buffer.from(raw, 'hex').toString('utf8') || null
  } catch {
    return null
  }
}

/**
 * Merge normalized source payloads + compute a 0-100 heuristic risk score.
 * Pure function (offline-testable).
 */
export function buildTokenReport({ address, token, market, security, sources }) {
  const flags = []
  const addFlag = (code, points, detail) =>
    flags.push({
      code,
      points,
      severity:
        points >= 40 ? 'critical' : points >= 15 ? 'high' : points >= 8 ? 'medium' : points >= 0 ? 'low' : 'info',
      detail,
    })

  if (token && token.isContract === false) {
    addFlag('not_a_contract', 90, 'Address holds no contract bytecode (EOA or self-destructed)')
  }
  if (security?.isHoneypot) addFlag('honeypot_detected', 100, 'GoPlus: sell simulation failed — likely honeypot')
  if (security?.cannotSellAll) addFlag('cannot_sell_all', 60, 'Holders cannot sell entire balance')
  if (security?.honeypotWithSameCreator) addFlag('same_creator_honeypot', 40, 'Creator linked to prior honeypot contracts')
  if (security?.cannotBuy) addFlag('cannot_buy', 25, 'Contract blocks buys')
  if (security?.ownerChangeBalance) addFlag('owner_can_change_balance', 40, 'Owner can arbitrarily modify balances')
  if (security?.sellTaxPct != null) {
    if (security.sellTaxPct > 0.25) addFlag('extreme_sell_tax', 35, `Sell tax ${pct100(security.sellTaxPct)}`)
    else if (security.sellTaxPct > 0.10) addFlag('high_sell_tax', 25, `Sell tax ${pct100(security.sellTaxPct)}`)
    else if (security.sellTaxPct > 0.05) addFlag('elevated_sell_tax', 15, `Sell tax ${pct100(security.sellTaxPct)}`)
    else if (security.sellTaxPct > 0) addFlag('sell_tax', 5, `Sell tax ${pct100(security.sellTaxPct)}`)
  }
  if (security?.buyTaxPct != null && security.buyTaxPct > 0.05) {
    addFlag('high_buy_tax', 12, `Buy tax ${pct100(security.buyTaxPct)}`)
  }
  if (security?.hiddenOwner) addFlag('hidden_owner', 15, 'Contract owner address is hidden')
  if (security?.canTakeBackOwnership) addFlag('ownership_recoverable', 15, 'Owner can reclaim renounced ownership')
  if (security?.isMintable) addFlag('mintable_supply', 10, 'Supply can be inflated by owner')
  if (security?.isBlacklisted) addFlag('blacklist_function', 10, 'Contract can blacklist addresses')
  if (security?.transferPausable) addFlag('transfer_pausable', 10, 'Transfers can be paused by owner')
  if (security?.slippageModifiable) addFlag('tax_modifiable', 12, 'Buy/sell tax can be changed after launch')
  if (security?.isProxy) addFlag('proxy_contract', 5, 'Upgradeable proxy — logic can change')
  if (security && security.isOpenSource === false) addFlag('closed_source', 10, 'Contract source not verified')
  if (market) {
    if (market.listed === false) addFlag('no_dex_listing', 20, 'No Base DEX pairs found on DexScreener')
    else if ((market.liquidityUsd ?? 0) < 10_000) {
      addFlag('thin_liquidity', 15, `Total DEX liquidity only $${Math.round(market.liquidityUsd ?? 0)}`)
    } else if ((market.liquidityUsd ?? 0) < 50_000) {
      addFlag('low_liquidity', 8, `Total DEX liquidity $${Math.round(market.liquidityUsd ?? 0)}`)
    }
  }
  if (security?.top10HolderPct != null) {
    if (security.top10HolderPct > 0.5) addFlag('concentrated_holders', 15, `Top-10 holders own ${Math.round(security.top10HolderPct * 100)}%`)
    else if (security.top10HolderPct > 0.3) addFlag('holder_concentration', 8, `Top-10 holders own ${Math.round(security.top10HolderPct * 100)}%`)
  }
  if (security && !security.ownerAddress) {
    flags.push({ code: 'ownership_renounced', points: -5, severity: 'info', detail: 'Owner address is zero — ownership renounced' })
  }

  const riskScore = Math.max(0, Math.min(100, flags.reduce((s, f) => s + f.points, 0)))
  const riskLevel = riskScore >= 70 ? 'critical' : riskScore >= 40 ? 'high' : riskScore >= 20 ? 'medium' : 'low'

  return {
    chain: 'base',
    chainId: BASE_CHAIN_ID,
    address,
    token: token
      ? {
          isContract: token.isContract,
          bytecodeBytes: token.bytecodeBytes,
          name: token.name,
          symbol: token.symbol,
          decimals: token.decimals,
          totalSupplyRaw: token.totalSupplyRaw,
          owner: token.owner,
        }
      : null,
    market: market || null,
    security: security || null,
    riskScore,
    riskLevel,
    flags,
    sources,
    fetchedUtc: new Date().toISOString(),
  }
}

function pct100(frac) {
  return `${Math.round(Number(frac) * 10000) / 100}%`
}

/**
 * Deterministic recursive key-sorted JSON serializer for commitment notarization.
 */
export function canonicalJsonString(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val)
  if (Array.isArray(val)) return `[${val.map((v) => canonicalJsonString(v)).join(',')}]`
  const keys = Object.keys(val).sort()
  return `{${keys
    .filter((k) => val[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonString(val[k])}`)
    .join(',')}}`
}

/**
 * Normalize flexible ticker inputs ("BTC", "eth-usd", "SOL/USDT", "SOLUSDT") into venue pairs.
 */
export function normalizeMarketSymbol(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9/-]/g, '')
  if (!cleaned || cleaned.length > 20) {
    throw new Error(`Invalid market symbol: "${raw}"`)
  }
  let base = cleaned
  let quote = 'USD'
  if (cleaned.includes('-') || cleaned.includes('/')) {
    const [b, q] = cleaned.split(/[-/]/)
    base = b
    quote = q === 'USDT' || q === 'USDC' || !q ? 'USD' : q
  } else if (cleaned.endsWith('USDT') && cleaned.length > 4) {
    base = cleaned.slice(0, -4)
    quote = 'USD'
  } else if (cleaned.endsWith('USDC') && cleaned.length > 4) {
    base = cleaned.slice(0, -4)
    quote = 'USD'
  } else if (cleaned.endsWith('USD') && cleaned.length > 3) {
    base = cleaned.slice(0, -3)
    quote = 'USD'
  }
  if (!/^[A-Z0-9]{2,12}$/.test(base)) {
    throw new Error(`Invalid base asset in symbol: "${raw}"`)
  }
  const binanceQuote = quote === 'USD' ? 'USDT' : quote
  return {
    normalized: `${base}-${quote}`,
    base,
    quote,
    binanceSymbol: `${base}${binanceQuote}`,
    coinbaseProduct: `${base}-${quote === 'USDT' ? 'USD' : quote}`,
  }
}

/**
 * US-datacenter-safe (`iad`) multi-venue ticker fanout (`data-api.binance.vision` + Coinbase Exchange).
 */
export async function fetchMultiVenueQuote(rawSymbol) {
  const sym = normalizeMarketSymbol(rawSymbol)

  const [bRes, cRes] = await Promise.all([
    timedSource('binance_vision', async () => {
      const r = await fetch(
        `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym.binanceSymbol)}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6_000) }
      )
      if (!r.ok) throw new Error(`Binance Vision HTTP ${r.status}`)
      const j = await r.json()
      const bid = Number(j.bidPrice)
      const ask = Number(j.askPrice)
      const last = Number(j.lastPrice)
      if (!Number.isFinite(last) || last <= 0) throw new Error('Invalid Binance price')
      return {
        venue: 'binance_vision',
        last,
        bid: bid > 0 ? bid : last,
        ask: ask > 0 ? ask : last,
        change24hPct: Number(j.priceChangePercent || 0),
        volume24hUsd: Number(j.quoteVolume || 0),
      }
    }),
    timedSource('coinbase', async () => {
      const r = await fetch(
        `https://api.exchange.coinbase.com/products/${encodeURIComponent(sym.coinbaseProduct)}/ticker`,
        {
          headers: { Accept: 'application/json', 'User-Agent': 'Switch402-Market/1.0' },
          signal: AbortSignal.timeout(6_000),
        }
      )
      if (!r.ok) throw new Error(`Coinbase HTTP ${r.status}`)
      const j = await r.json()
      const last = Number(j.price)
      const bid = Number(j.bid || last)
      const ask = Number(j.ask || last)
      const volBase = Number(j.volume || 0)
      if (!Number.isFinite(last) || last <= 0) throw new Error('Invalid Coinbase price')
      return {
        venue: 'coinbase',
        last,
        bid,
        ask,
        change24hPct: null,
        volume24hUsd: Math.round(volBase * last * 100) / 100,
      }
    }),
  ])

  const active = [bRes, cRes].filter((x) => x.ok).map((x) => ({ ...x.data, rttMs: x.ms }))
  if (active.length === 0) {
    throw new Error(`No venue quote for ${sym.normalized}: ${bRes.error}; ${cRes.error}`)
  }

  const bestBid = Math.max(...active.map((v) => v.bid))
  const bestAsk = Math.min(...active.map((v) => v.ask))
  const avgMid = active.reduce((s, v) => s + (v.bid + v.ask) / 2, 0) / active.length
  const midUsd = Number(avgMid.toPrecision(8))
  const rawSpread = bestAsk >= bestBid ? bestAsk - bestBid : Math.abs(active[0].ask - active[0].bid)
  const spreadBps = Math.round(((rawSpread / midUsd) * 10_000) * 100) / 100
  const changeSource = active.find((v) => v.change24hPct !== null)

  return {
    symbol: sym.normalized,
    base: sym.base,
    quote: sym.quote,
    midUsd,
    bestBid: Number(bestBid.toPrecision(8)),
    bestAsk: Number(bestAsk.toPrecision(8)),
    spreadBps,
    change24hPct: changeSource ? changeSource.change24hPct : null,
    volume24hUsd: Math.round(active.reduce((s, v) => s + (v.volume24hUsd || 0), 0)),
    venueCount: active.length,
    venues: active,
    fetchedUtc: new Date().toISOString(),
  }
}

export function normalizeCandleInterval(raw) {
  const allowed = new Set(['1m', '5m', '15m', '1h', '4h', '1d'])
  const v = String(raw || '5m').trim().toLowerCase()
  if (!allowed.has(v)) {
    throw new Error(`Unsupported interval "${raw}". Allowed: 1m, 5m, 15m, 1h, 4h, 1d`)
  }
  return v
}

async function fetchMarketCandles(rawSymbol, interval) {
  const sym = normalizeMarketSymbol(rawSymbol)

  try {
    const r = await fetch(
      `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(sym.binanceSymbol)}&interval=${interval}&limit=60`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7_000) }
    )
    if (r.ok) {
      const rows = await r.json()
      if (Array.isArray(rows) && rows.length >= 22) {
        const candles = rows.map((k) => ({
          ts: Number(k[0]),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }))
        return { candles, source: 'binance_vision', normalizedSymbol: sym.normalized }
      }
    }
  } catch {
    // Fall back to Coinbase Exchange public candles
  }

  const granMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }
  const gran = granMap[interval] || 300
  const cb = await fetch(
    `https://api.exchange.coinbase.com/products/${encodeURIComponent(sym.coinbaseProduct)}/candles?granularity=${gran}`,
    {
      headers: { Accept: 'application/json', 'User-Agent': 'Switch402-Market/1.0' },
      signal: AbortSignal.timeout(7_000),
    }
  )
  if (!cb.ok) {
    throw new Error(`Failed to fetch OHLCV klines for ${sym.normalized} (HTTP ${cb.status})`)
  }
  const cbRows = await cb.json()
  if (!Array.isArray(cbRows) || cbRows.length < 22) {
    throw new Error(`Insufficient candle history for ${sym.normalized}`)
  }
  // Coinbase returns newest-first: [time, low, high, open, close, volume]
  const sorted = cbRows
    .slice(0, 60)
    .reverse()
    .map((k) => ({
      ts: Number(k[0]) * 1000,
      low: Number(k[1]),
      high: Number(k[2]),
      open: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }))
  return { candles: sorted, source: 'coinbase', normalizedSymbol: sym.normalized }
}

/**
 * Pure deterministic quantitative indicator & signal engine (offline-testable & P2P canary-verifiable).
 */
export function computeTradeSignalFromCandles(rawCandles, meta = {}) {
  if (!Array.isArray(rawCandles) || rawCandles.length < 22) {
    throw new Error('trade.signal requires at least 22 candles')
  }

  const candles = rawCandles.map((c) => {
    if (typeof c === 'number') {
      if (!Number.isFinite(c) || c <= 0) throw new Error('Candle close values must be positive numbers')
      return { open: c, high: c, low: c, close: c, volume: 0 }
    }
    const close = Number(c?.close ?? c?.c)
    if (!Number.isFinite(close) || close <= 0) {
      throw new Error('Each candle object requires a positive numeric "close"')
    }
    return {
      open: Number(c.open ?? c.o ?? close),
      high: Number(c.high ?? c.h ?? close),
      low: Number(c.low ?? c.l ?? close),
      close,
      volume: Number(c.volume ?? c.v ?? 0),
    }
  })

  const closes = candles.map((c) => c.close)
  const price = closes[closes.length - 1]
  const ema9 = calcEma(closes, 9)
  const ema21 = calcEma(closes, 21)
  const rsi14 = calcRsi(closes, 14)
  const atr14 = calcAtr(candles, 14)
  const atr14Pct = (atr14 / price) * 100

  const window20 = closes.slice(-20)
  const sma20 = window20.reduce((s, v) => s + v, 0) / window20.length
  const variance = window20.reduce((s, v) => s + (v - sma20) ** 2, 0) / window20.length
  const std20 = Math.sqrt(variance)
  const upperBand = sma20 + 2 * std20
  const lowerBand = sma20 - 2 * std20
  const bollingerPctB = upperBand > lowerBand ? (price - lowerBand) / (upperBand - lowerBand) : 0.5

  const lookbackIdx = Math.max(0, closes.length - 11)
  const momentum10Pct = ((price - closes[lookbackIdx]) / closes[lookbackIdx]) * 100
  const emaSpreadBps = ((ema9 - ema21) / ema21) * 10_000

  let score = 0
  const rationale = []

  if (emaSpreadBps > 12) {
    score += 1.2
    rationale.push(`EMA9 > EMA21 (+${emaSpreadBps.toFixed(1)} bps bullish trend)`)
  } else if (emaSpreadBps < -12) {
    score -= 1.2
    rationale.push(`EMA9 < EMA21 (${emaSpreadBps.toFixed(1)} bps bearish trend)`)
  }

  if (rsi14 < 30) {
    score += 1.4
    rationale.push(`RSI14 oversold (${rsi14.toFixed(1)} < 30)`)
  } else if (rsi14 > 70) {
    score -= 1.4
    rationale.push(`RSI14 overbought (${rsi14.toFixed(1)} > 70)`)
  } else if (rsi14 >= 54 && emaSpreadBps > 0) {
    score += 0.6
    rationale.push(`Constructive bullish momentum (RSI14 ${rsi14.toFixed(1)})`)
  } else if (rsi14 <= 46 && emaSpreadBps < 0) {
    score -= 0.6
    rationale.push(`Negative momentum confirmation (RSI14 ${rsi14.toFixed(1)})`)
  }

  if (bollingerPctB < 0.08) {
    score += 0.7
    rationale.push(`Price near lower 2-sigma Bollinger band (%B=${bollingerPctB.toFixed(2)})`)
  } else if (bollingerPctB > 0.92) {
    score -= 0.7
    rationale.push(`Price stretched above upper 2-sigma Bollinger band (%B=${bollingerPctB.toFixed(2)})`)
  }

  let regime = 'range'
  if (rsi14 < 30) regime = 'oversold_bounce'
  else if (rsi14 > 70) regime = 'overbought_fade'
  else if (emaSpreadBps > 20) regime = 'trend_up'
  else if (emaSpreadBps < -20) regime = 'trend_down'

  let action = 'hold'
  if (score >= 1.1) action = 'buy'
  else if (score <= -1.1) action = 'sell'

  const confidence = Math.round(Math.min(0.95, Math.max(0.15, Math.abs(score) / 2.8)) * 1000) / 1000
  if (rationale.length === 0) {
    rationale.push('Neutral consolidation inside EMA/RSI equilibrium band')
  }

  return {
    symbol: meta.symbol || 'CUSTOM',
    interval: meta.interval || 'custom',
    source: meta.source || 'deterministic_candles',
    candleCount: candles.length,
    action,
    regime,
    confidence,
    indicators: {
      price: roundSig(price),
      ema9: roundSig(ema9),
      ema21: roundSig(ema21),
      emaSpreadBps: Math.round(emaSpreadBps * 100) / 100,
      rsi14: Math.round(rsi14 * 100) / 100,
      atr14Pct: Math.round(atr14Pct * 1000) / 1000,
      bollingerPctB: Math.round(bollingerPctB * 1000) / 1000,
      momentum10Pct: Math.round(momentum10Pct * 1000) / 1000,
    },
    rationale,
  }
}

function calcEma(values, period) {
  const k = 2 / (period + 1)
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k)
  }
  return ema
}

function calcRsi(values, period = 14) {
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1]
    if (diff >= 0) avgGain += diff
    else avgLoss -= diff
  }
  avgGain /= period
  avgLoss /= period
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function calcAtr(candles, period = 14) {
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const prevClose = candles[i - 1].close
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    trs.push(tr)
  }
  if (trs.length === 0) return 0
  const slice = trs.slice(-period)
  return slice.reduce((s, v) => s + v, 0) / slice.length
}

function roundSig(n) {
  return Number(Number(n).toPrecision(8))
}
