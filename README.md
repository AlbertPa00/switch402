# Switch402 — Stateless Agent Inference & Action Switch

[![AlbertPa00/switch402 MCP server](https://glama.ai/mcp/servers/AlbertPa00/switch402/badges/score.svg)](https://glama.ai/mcp/servers/AlbertPa00/switch402)

**Zero-dependency Node.js ESM (`>=18`) high-throughput A2A execution switch:**
- **Drop-In OpenAI Inference (`/v1/chat/completions`, `/v1/models`)** + **Universal Atomic Capabilities (`/v1/act/:skill`)**
- **Keyless x402 per-call payment**: an agent holding $0.01 USDC on Base hits any capability with **zero account signup, zero API key, zero KYC** — receive `HTTP 402`, sign `PAYMENT-SIGNATURE`, get the result.
- **Outbound WebSocket Seller Grid (`/ws/worker`)**: Any GPU owner (`Ollama` / `vLLM`) or agent developer sells inference or custom skills with **zero port-forwarding, zero SSL setup, and $0 upfront deposit** (keep **95%**).
- **In-RAM `BigInt` Nano-USD Ledger + Crash-Safe WAL**: Sub-millisecond double-entry accounting (`1 USD = 1e9 nanoUSD`), `$2.00` Earned Quality Bond auto-lock, and **15% lifetime referral fee share** (`?ref=ag_xxx`).
- **Auto-Failover & 1% Canary Slashing**: `1,500ms` first-token SLA with transparent failover to Seller #2 or **Day-1 House Fallback Upstream (+10% spread)**; spoofing sellers lose their `$2.00` Earned Bond on stealth canary checks.
- **Multi-Rail Crypto Auto-Pay**: `x402` v2 Base USDC (`PAYMENT-REQUIRED` + Bazaar/OpenAPI `3.1.0` crawler discovery), Bitcoin Lightning (`bolt11` + HMAC webhook), and instant 0-gas **Earn-to-Spend** internal reuse.

## House capability book (always-on fallback, `POST /v1/act/:skill`)

| Skill | What it does | Buyer price |
|---|---|---|
| `web.search` | Keyless SERP: top organic results + titles/URLs/snippets — no API key or $50/mo search subscription | `$0.0055`/call |
| `chain.token_report` | Base token pre-trade safety report: bytecode + honeypot/tax/owner flags + holder concentration + DEX liquidity/FDV/age in one call (replaces ~4 RPC/REST calls before a swap) | `$0.011`/call |
| `web.fetch_markdown` | SSRF-safe reader: any public URL → clean Markdown + title | `$0.0055`/call |
| `web.verify_url` | HTTP notary: status + bytes + SHA-256 + UTC timestamp | `$0.0022`/call |
| `util.sha256` / `util.json_validate` / `util.markdown_clean` | Cheap deterministic utilities for smoke tests | `≤$0.0009`/call |

Plus keyless LLM inference (`deepseek`, `qwen`, `llama`, `gpt-4o-mini`) via the OpenAI endpoint — prices in `/v1/models` + `/v1/market`.

## Quickstart

```bash
# 1. Run the full E2E & concurrency verification suite
npm test

# 2. Start the Switch402 server + Live Orderbook UI on :4020
npm start

# 3. Register an agent & connect a Seller Worker over outbound WebSocket
node packages/cli/bin.mjs register --server http://localhost:4020 --name my-gpu-node
node packages/cli/bin.mjs serve --server http://localhost:4020 --model qwen/qwen3-32b --price 0.12

# 4. Run the Universal Meta-MCP Server (Claude Code / Antigravity / Cursor / Codex)
node packages/mcp/mcp-server.mjs --server http://localhost:4020
```

## Keyless call example (x402, no account)

```bash
# 402 challenge -> sign -> paid result. $0.011 USDC on Base.
curl -X POST https://switch402.fly.dev/v1/act/chain.token_report \
  -H 'Content-Type: application/json' \
  -d '{"address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}'
# -> HTTP 402 + PAYMENT-REQUIRED header -> re-send with PAYMENT-SIGNATURE
```
