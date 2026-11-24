# Distribution Playbook — Switch402

Long-term userbase growth ops log. Update the status column as items land.

## Status board

| Channel | Status | Notes |
|---|---|---|
| x402scan (Merit Systems) | ✅ LIVE | All 8 resources registered 2026-11-24. Server page: https://www.x402scan.com/server/d1b06f8b-03cf-4c10-87fa-f8d6db630ef9 |
| Official MCP Registry | ✅ LIVE | `dev.fly.switch402/switch402` v0.1.3 published via HTTP (Ed25519) auth, remotes → `switch402.fly.dev/mcp`. Auto-feeds PulseMCP + Glama. |
| Official MCP Registry (canonical) | ⏳ pending npm | `io.github.AlbertPa00/switch402-mcp` at 0.1.1 — republish 0.1.3 after `npm publish` (see below) |
| awesome-mcp-servers | ⏳ PR open | https://github.com/punkpeye/awesome-mcp-servers/pull/20632 — Aggregators section, Glama badge in README |
| PayAI Bazaar | ✅ indexed | facilitator `facilitator.payai.network` picks up valid x402 challenges |
| npm `switch402-mcp` | ⏳ 0.1.3 not published | `npm publish` needs user OTP (2FA) — run in `packages/mcp` |
| mcp.so | 🔲 manual | https://mcp.so/submit — repo URL `AlbertPa00/switch402`; free review or $39 instant+featured |
| PulseMCP | ⏸ paused | Submissions paused since 2026-09; auto-picks from official registry when back — registry listing covers us |
| Glama | 🔄 auto | Syncs from official registry + npm; badge already in README |
| Smithery | ❌ dead | MCP proxy/SDK shut down 2026-10-31 (now Arcade.dev directory, no submit flow) |
| Base Builder Grant S2 | 🔲 apply | Up to $5k + GTM. "Agents — x402 implementations" is a listed category → https://docs.base.org/get-started/builders |

## After `npm publish switch402-mcp@0.1.3`

1. `cd packages/mcp && npm publish` (enter OTP)
2. Re-run the registry workflow: GitHub → Actions → "Publish to MCP Registry" → Run workflow
   (or `gh workflow run mcp-registry.yml`, or push tag `v0.1.3`)
   — registry validates the npm version exists, so it MUST run after npm publish.
3. `mcp.so/submit` with the repo URL.

## Re-registering on x402scan (after endpoint changes)

`POST https://www.x402scan.com/api/x402/registry/register` `{"url":"<endpoint>"}` — free,
but gated by SIWX (EIP-191 challenge → `SIGN-IN-WITH-X` header). Upserts on `(url, method)` —
no dupes. Identity wallet: `0x913D625729619b8b29B2dE0121100332F8691541` (unfunded,
key in `../siwx_identity_key.txt` — do NOT use the payout key for sign-ins).
Working Python impl: `profit-ops` session 2026-11-24 (`/tmp/x402scan_reg.py`).

## Drafts

### Show HN

> **Show HN: Switch402 — keyless x402 payment switch + P2P inference grid in zero-dep Node.js**
>
> Spin up a paid API surface for autonomous agents with a single file server — no npm deps,
> no port forwarding, no Stripe. Agents pay per call in USDC on Base via x402 (HTTP 402,
> finally doing its job).
>
> - `POST /v1/chat/completions` — OpenAI-compat, keyless for agents holding $1 USDC
> - `/v1/act/*` skills: web.search (keyless SERP), chain.token_report (Base token
>   pre-trade safety: bytecode + DexScreener + GoPlus in one call), fetch_markdown, …
> - P2P worker mesh: `npx switch402 serve --auto-ollama` sells your GPU/ollama into the grid
> - MCP server `switch402-mcp` plugs Claude Code/Cursor straight into the grid
>
> Live: https://switch402.fly.dev · Repo: github.com/AlbertPa00/switch402

### X / Base builders

> Agents can't open Stripe accounts. Switch402 fixes that: a zero-dep Node x402 switch where
> agents pay per call in USDC on @base — inference, SERP search, token safety reports.
> `npx switch402 serve --auto-ollama` turns any GPU box into a paid worker. No port forwarding.

## Grants

- **Base Builder Grant Program S2** (open, no deadline): up to $5k + GTM/product support.
  Category literally includes "x402 implementations". Apply: https://docs.base.org/get-started/builders
- **Builder Codes** (grant-eligibility signal): register app + get `bc_` code at
  https://dashboard.base.org → Settings → Builder Codes; seller-side integration per
  https://docs.cdp.coinbase.com/x402/builder-code.skill
- Base Ecosystem Fund / Base Batches — larger, later stage.

## Gotchas learned

- `com.switch402/switch402` on the registry is an unrelated service at switch402.com
  (name collision, not impersonation). Consider this for branding/Show HN title.
- x402scan requires every registered route to be listed in origin `/openapi.json`
  with `x-payment-info` (merged PR #988).
- Registry description field ≤100 chars.
- x402scan read APIs are paid; register/verify writes are free with SIWX.
