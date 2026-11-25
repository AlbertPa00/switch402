# Distribution Playbook — Switch402

Long-term userbase growth ops log. Update the status column as items land.

## Status board

| Channel | Status | Notes |
|---|---|---|
| x402scan (Merit Systems) | ✅ LIVE | All 8 resources registered 2026-11-24. Server page: https://www.x402scan.com/server/d1b06f8b-03cf-4c10-87fa-f8d6db630ef9 |
| x402dash | ✅ 8/8 | All endpoints registered+verified 2026-11-25 via `POST api.x402dash.com/v1/register` |
| PayAI Bazaar | 🔲 needs settlement | Confirmed NOT indexed (scanned all 19k resources by payTo 2026-11-25). Server already injects `extensions.bazaar` into facilitator calls (payments.mjs:228) — but indexing needs a settled payment whose payload carries it. `python ../x402_buy.py` with ~$0.10 USDC on Base lists all 8. |
| Agentic.Market (Coinbase) | 🔲 curated | No public submit; indexes from facilitator catalogs. Get Bazaar-listed first |
| x402-list.com | 🔲 $1 fee | CONFIRMED 2026-11-25: fly.dev = free-compute host → $1 USDC x402 payment to enter review queue (non-refundable, buys review not listing). NOTE: unrelated `api.switch402.com` service already listed there under "switch402" |
| SarnAI board | ✅ LIVE | Listed as "Switch402 - x402 payment switch for agents" — searchable, health passing. `register_me`/`check_listing` MCP tools at board.sarnai.dev/mcp for future services |
| ClawWork | ✅ LIVE | 4 service offers posted (x402 utilities/token/trade signals); agent `switch402` id e3326979-5a9c-41be-aa7b-dfa0c74903ce. New-account offers don't render publicly until moderation |
| pay.sh registry | ❌ n/a | Solana-foundation MPP gateway stack (`pay` CLI) — catalogs provider gateways, not external x402 endpoints. Revisit only if we run an MPP gateway |
| app.ampersend.ai | 🔲 account | Marketplace behind sign-in — human step |
| Official MCP Registry | ✅ LIVE | `dev.fly.switch402/switch402` v0.1.3 published via HTTP (Ed25519) auth, remotes → `switch402.fly.dev/mcp`. Auto-feeds PulseMCP + Glama. |
| Official MCP Registry (canonical) | ⏳ pending npm | `io.github.AlbertPa00/switch402-mcp` at 0.1.1 — republish 0.1.3 after `npm publish` (see below) |
| awesome-mcp-servers | ⏳ PR open | https://github.com/punkpeye/awesome-mcp-servers/pull/20632 — Aggregators section, Glama badge in README |
| xpaysh/awesome-x402 | ⏳ PR open | https://github.com/xpaysh/awesome-x402/pull/2354 — Ecosystem Projects |
| Merit awesome-agentic-commerce | ⏳ PR open | https://github.com/Merit-Systems/awesome-agentic-commerce/pull/920 — Ecosystem section |
| gold-402 directory | ⏳ PR open | https://github.com/Haustorium12/gold-402/pull/530 — directory/apis.md, they probe the 402 before merge |
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

- x402scan requires every registered route to be listed in origin `/openapi.json`
  with `x-payment-info` (merged PR #988).
- x402.org/ecosystem page is SUNSET — foundation now points to x402scan,
  Agentic.Market, pay.sh, ampersend, x402-list (README of x402-foundation/x402).
- x402dash probes endpoints with GET — `/v1/chat/completions` now returns the
  402 challenge on GET for indexability.
- PayAI Bazaar: listing = automatic on first SETTLED payment; client must echo
  `extensions.bazaar` in payment payload. `x402_buy.py` (workspace root) now
  echoes it — needed ~$0.10 USDC on Base + user approval to list all 8.
- `com.switch402/switch402` on the registry is an unrelated service at switch402.com
  (name collision, not impersonation). Consider this for branding/Show HN title.
- Registry description field ≤100 chars.
- x402scan read APIs are paid; register/verify writes are free with SIWX.

## 2026-11-25 ~10:25Z — PR wave 2 + YourAITools gateway
- PR michielpost/x402-dev#330 — Projects.md services section (verified commit via GraphQL)
- PR xpaysh/awesome-mcp-monetization#31 — Platforms and Services (verified)
- PR eltociear/awesome-molt-ecosystem#51 — Tier A row (verified)
- YourAITools agent submit API: sub_9jc848wzcs slug=switch402 — all auto checks passed (health/InjectScan/PayGuard), pending manual review. Gateway will be api.youraitools.co/g/switch402/ — 0% cut, proxies our 402s to our payTo. NOTE: api.youraitools.co is IPv6/DoH-weird from this box; --resolve api.youraitools.co:443:188.114.97.2 works (pages.dev CNAME).
- NEW LANE NonSynthetic (api.nonsynthetic.net): board has 200 tasks but radar items are dead/decoy; $402 "MAX" pays in cr_ credit only. Paid options pending: storefront/list $0.05, board task post $5.
- Skipped: SatBotly (crawl-only, no self-serve), oss-bot-trap $750 (literal bot-trap decoy), overturn bounties (all closed), agent-bounties #1632 (verifier expired).
- toku.agency: agent profile live (toku.agency/agents/glitchnexuswizard) + 3 services. Dead board but free.
- nostr: kind-1 note on nos.lol + nostr.mom (event 7dfe7ce1, key tmp/nostr_priv.txt)
- Pending human steps: ERC-8004 on-chain registration (needs Base ETH gas), ugig email confirm, a2a-registry UI signup, Smithery GitHub OAuth.
