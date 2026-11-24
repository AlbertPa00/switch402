# Switch402 — Stateless Agent Inference & Action Switch

**Zero-dependency Node.js ESM (`>=18`) high-throughput A2A execution switch:**
- **Drop-In OpenAI Inference (`/v1/chat/completions`, `/v1/models`)** + **Universal Atomic Capabilities (`/v1/act/:skill`)**
- **Outbound WebSocket Seller Grid (`/ws/worker`)**: Any GPU owner (`Ollama` / `vLLM`) or agent developer sells inference or custom skills with **zero port-forwarding, zero SSL setup, and $0 upfront deposit** (keep **95%**).
- **In-RAM `BigInt` Nano-USD Ledger + Crash-Safe WAL**: Sub-millisecond double-entry accounting (`1 USD = 1e9 nanoUSD`), `$2.00` Earned Quality Bond auto-lock, and **15% lifetime referral fee share** (`?ref=ag_xxx`).
- **Auto-Failover & 1% Canary Slashing**: `1,500ms` first-token SLA with transparent failover to Seller #2 or **Day-1 House Fallback Upstream (+10% spread)**; spoofing sellers lose their `$2.00` Earned Bond on stealth canary checks.
- **Multi-Rail Crypto Auto-Pay**: `x402` v2 Base USDC (`PAYMENT-REQUIRED` + Bazaar/OpenAPI `3.1.0` crawler discovery), Bitcoin Lightning (`bolt11` + HMAC webhook), and instant 0-gas **Earn-to-Spend** internal reuse.

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
