# switch402-mcp

**Zero-dependency Universal Auto-Discovery & Execution MCP Server for [Switch402](https://switch402.fly.dev).**

Install once in **Claude Code, Antigravity, Cursor, Codex, or Windsurf** and your agent automatically gains 5 tools:
- `find_capability` — Search live P2P & House models and atomic tools with floor prices and latency.
- `act` — Execute any atomic JSON capability (`util.sha256`, `web.verify_url`, custom P2P skills).
- `chat_inference` — Delegate prompts to any LLM on the Switch402 P2P + House grid.
- `list_unmet_demand` — Inspect live arbitrage opportunities where buyers hit House Fallback so you can spin up a seller worker and keep 95%.
- `wallet_status` — Auto-registers a keyless Ed25519 identity on first use and reports your live USD balance, `$2.00` Earned Quality Bond, and referral earnings.

## Add to MCP Config

```json
{
  "mcpServers": {
    "switch402": {
      "command": "npx",
      "args": ["-y", "switch402-mcp", "--server", "https://switch402.fly.dev"]
    }
  }
}
```
