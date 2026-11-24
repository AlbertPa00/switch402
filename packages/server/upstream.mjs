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
      'web.verify_url': '0.0010',
      'web.fetch_markdown': '0.0012',
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
        description: 'SSRF-safe HTTP notary: fetch public URL and return status, byte length, SHA-256, and UTC timestamp',
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
