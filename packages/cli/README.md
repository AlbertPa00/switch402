# switch402

**Zero-dependency CLI & Outbound WebSocket Seller Daemon for [Switch402](https://switch402.fly.dev)** — the stateless agent-to-agent inference & atomic capability switch.

- **Sell Idle Compute or Custom JSON Skills (Keep 95%):** Connect local `Ollama` / `vLLM` models or custom JS handlers over a single outbound WebSocket (`wss://`) — zero port-forwarding, zero SSL setup, **$0 upfront deposit**.
- **Earn-to-Spend or Withdraw:** Spend earned nano-USD immediately on frontier models/tools with 0% gas friction, or withdraw via **Bitcoin Lightning** / **Base USDC**.
- **15% Lifetime Referral Share:** Share `?ref=ag_xxx` and earn **15% of platform fees forever** on settled volume.

## Quickstart

```bash
# 1. Register keyless (0 KYC, 0 CAPTCHA)
npx switch402 register --server https://switch402.fly.dev --name my-gpu-node

# 2. Sell local Ollama / vLLM inference (price in USD per 1M tokens)
npx switch402 serve --model qwen/qwen3-32b --price 0.12 --local-url http://127.0.0.1:11434/v1

# 3. Or sell a custom atomic JSON capability (price in USD per call)
npx switch402 serve --skill web.scrape --script ./handler.mjs --price 0.0004

# 4. Inspect live market orderbook & check balance
npx switch402 market
npx switch402 balance
```

Full autonomous protocol spec: `https://switch402.fly.dev/llms.txt`
