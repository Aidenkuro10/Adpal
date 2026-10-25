# AdPal

A runnable prototype of advertising that pays for **attention** instead of personal data.

The reader experience is fully passive: no “click to earn” button, no countdown, no overlay. A publisher declares an ad slot, the extension measures attention in the background, the server validates it, and only then does a clean creative appear. The reader's share is credited automatically.

The repository contains three independent parts:

1. **`extension/`** — a Chrome Manifest V3 extension that measures attention passively and renders the approved creative inside the declared ad slot.
2. **`server/`** — a Node.js/Express simulator: a “human vs script” heuristic, a rotating ad-server agent pool (five advertiser profiles), the **70% user / 30% publisher** split, balances, real PayPal Sandbox payouts through the official **PayPal AI Toolkit**, and a telemetry feed.
3. **`demo-publisher/`** — the presentation layer, split into two dedicated views: **`/demo/`** is a clean fictional newspaper (editorial only, no telemetry UI), and **`/terminal/`** is a dark agent terminal that streams the negotiation as raw JSON over SSE.

> The ledger and the advertiser campaigns are in-memory and reset on restart, but the **settlement is real**: each batch is created with the PayPal REST Payouts API against your Sandbox credentials. Tokens and secrets are redacted before anything reaches the log or the page.

---

## Architecture

```text
┌──────────────────────────── Reader page (http/https) ─────────────────────┐
│  #adpal-slot — reserved frame, empty until attention is validated         │
│                                                                           │
│  content.js (invisible, no buttons, no panels)                            │
│    ├── passive tracker: duration · mouse · scroll · visibility · focus     │
│    ├── 6 s measurement window, started only after natural engagement       │
│    ├── Shadow DOM creative, rendered only on `approved: true`             │
│    └── aggregated session samples relayed to the server every 8 s          │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ chrome.runtime.sendMessage
┌───────────────────────────────▼───────────────────────────────────────────┐
│  background.js — MV3 service worker                                       │
│  chrome.storage.local cache · anonymous client ID · HTTP calls            │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ HTTP localhost:3000
┌───────────────────────────────▼───────────────────────────────────────────┐
│  server.js — Express                                                      │
│    POST /api/offer         → heuristic + rotation + L402 + ledger          │
│    POST /api/client-event  → silent session event sink                    │
│    GET  /api/balance       → user / publisher / advertiser balances       │
│    GET  /api/telemetry     → incremental negotiation feed (poll)          │
│    GET  /api/logs          → same events, live over Server-Sent Events    │
│    GET  /api/toolkit       → PayPal Agent Toolkit capability profile      │
│    GET  /api/agents        → advertiser roster + campaign budgets         │
│    POST /api/payout        → PayPal batch or one Solana 70/30 transfer      │
│    POST /api/flush-payout  → alias kept for the extension popup           │
│    GET  /api/solana        → devnet rail profile + live balances          │
│    POST /api/solana/fund   → devnet faucet for the treasury               │
│    POST /api/l402/solana/confirm → verify an on-chain L402 proof          │
│    GET  /demo/             → publication page (editorial only)            │
│    GET  /terminal/         → agent terminal (JSON protocol log only)      │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ SSE /api/logs
┌───────────────────────────────▼───────────────────────────────────────────┐
│  demo-publisher/terminal/ — dedicated operator console                    │
│  raw JSON events · L402 macaroons · attention · PayPal + Solana payloads  │
└───────────────────────────────────────────────────────────────────────────┘
```

Two agent layers sit beside the Express routes, both driven by the official
`AI-Toolkit-main/` checkout:

```text
AI-Toolkit-main/ (PayPal AI Toolkit v1.2.0)
        │  .mcp.json → paypal-sandbox (SSE) · skills/paypal-best-practices
        ▼
server/src/paypal-agent-toolkit.js
    ├── advertiser agent  → advertiser_authorize_spend   (campaign budgets)
    └── protocol agent    → protocol_split_invoice + paypal_create_payout

server/src/solana.js  (second settlement rail)
    ├── anchor   → memo of sha256(preimage), signed by the treasury
    ├── verify   → re-read a signature: confirmation, memo, recipient, units
    └── payout   → one transaction, two legs (70/30), one memo
```

### Project layout

```text
Adpal/
├── extension/
│   ├── manifest.json       Manifest V3 (scripting, activeTab, storage)
│   ├── content.js          Passive tracker + Shadow DOM creative renderer
│   ├── background.js       Service worker, cache, API calls
│   ├── popup.html          Extension interface
│   ├── popup.css
│   └── popup.js            Balance, connection, rules, activity, payout
├── server/
│   ├── package.json        Express, CORS, dotenv
│   ├── server.js           API, telemetry, and demo page hosting
│   ├── .env.example        All configuration options
│   └── src/
│       ├── config.js       Environment variable parsing and validation
│       ├── heuristic.js    0-100 attention score and guard rails
│       ├── ledger.js       Accounts, offers, split, and payouts
│       ├── creatives.js    Advertiser profiles (creative + campaign budget)
│       ├── rotation.js     Multi-advertiser rotation, per slot and over time
│       ├── paypal-agent-toolkit.js  PayPal AI Toolkit bridge (agent tools)
│       ├── l402.js         L402 challenge + HMAC-chained macaroon verifier
│       ├── l402-contract.js 402 offer contract + payment-context store
│       ├── paypal.js       OAuth2 + Payouts client (payload observer)
│       ├── solana.js       Devnet rail: anchor, verify, 70/30 transaction
│       └── telemetry.js    Event ring buffer with live subscribers
├── AI-Toolkit-main/        Official PayPal AI Toolkit checkout (MCP + skills)
├── client/
│   └── inspect.js          Standalone L402 inspection CLI (no dependencies)
├── demo-publisher/
│   ├── index.html          Publication: editorial only, no debug panels
│   ├── style.css           Newspaper layout
│   ├── reader.js           Reading-progress indicator
│   └── terminal/
│       ├── index.html      Agent terminal (dedicated view)
│       ├── terminal.css    Dark console styling
│       └── terminal.js     SSE client, JSON renderer, pipeline rail
├── README.md
└── .gitignore
```

### PayPal Agent Toolkit integration

`AI-Toolkit-main/` is PayPal's official AI Toolkit checkout: a plugin manifest,
a sandbox MCP server declaration (`.mcp.json` → `paypal-sandbox`, SSE) and the
`paypal-best-practices` skill with its Payouts reference. It ships no runtime
library, so the server integrates it at the level it defines:

| Layer | What the server does |
| --- | --- |
| Discovery | reads `package.json`, `.cursor-plugin/plugin.json` and `.mcp.json`, validates the Payouts reference, and exposes the result at `GET /api/toolkit` and in the terminal's **Agent toolkit** card |
| Tools | implements an MCP-shaped catalog (`paypal_get_token`, `paypal_create_payout`, `paypal_get_payout`, `advertiser_authorize_spend`, `protocol_split_invoice`) with JSON input schemas |
| Advertiser agent | authorizes campaign spend per impression against the chosen profile's budget before the ledger is credited |
| Protocol agent | splits the settled invoice (70/30) and routes both items into a single Payouts batch |
| Contract | environment-only credentials, `sender_item_id` + `PayPal-Request-Id` idempotency, exponential backoff on HTTP 429, sandbox host unless `PAYPAL_MODE=live` |

If the folder is absent the simulator still boots: `/api/toolkit` reports
`present: false` and the tools fall back to the local PayPal client.

---

## Requirements

- **Node.js 18+** and npm
- **Chrome** (or Edge/Chromium) 102+
- No account, no API key, no database

---

## Quick start

### 1. Start the server

```bash
cd server
npm install
npm start
```

The server listens on port **3000** (or the next free port if 3000 is taken) and prints:

```text
API        http://localhost:3000/api/balance
Demo       http://localhost:3000/demo/
Split      70% user · 30% publisher
Threshold  €0.050 · offer cap €0.050
```

Quick check:

```bash
curl http://localhost:3000/api/health
```

### Development assets and caching

The pages are edited live while a browser is open, so the server never lets a
browser keep a stylesheet from a previous run. `server/src/view-assets.js`
serves both views with three rules:

| Rule | Effect |
| --- | --- |
| `Cache-Control: no-store` (+ `Pragma`, `Expires`) and no `ETag`/`Last-Modified` in development | A normal refresh always re-reads `style.css` / `reader.js` from disk. There is no 304 that could be paired with a stale copy. |
| Content-addressed asset URLs | `<link href="style.css">` is served as `style.css?v=<sha1>`, recomputed whenever the file changes. A changed stylesheet is a *new URL*, so even a disk cache, bfcache or proxy cannot serve the old one. |
| CSS stays synchronous | The rewrite only edits the `href` of the existing `<link>` in `<head>`. Nothing is injected by JavaScript, preloaded asynchronously or deferred, so there is no flash of unstyled content. |

Both views declare their stylesheet in `<head>` and their script at the end of
`<body>`, and `serveView` keeps the trailing-slash redirect (`/demo` → `/demo/`)
so relative asset URLs always resolve inside the view.

Production caching is opt-in:

```powershell
$env:NODE_ENV = 'production'; node server.js
```

With `NODE_ENV=production`, pages are sent `public, max-age=0, must-revalidate`
with validators enabled, and a `?v=` URL is served `immutable` for a year.

### 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the **`extension/`** folder (not the project root).
5. Pin the **AdPal** icon to the toolbar.

After changing extension code, click **Reload** on the AdPal card in `chrome://extensions`, then reload the demo tab.

> The service worker and popup need the server. If it is stopped, the popup shows **Offline** and the terminal stays disconnected.

### 3. Open the demo

Go to **[http://localhost:3000/demo/](http://localhost:3000/demo/)** and read normally:

1. The page is a clean, bento-grid publication with **no telemetry panel**: a cover card, a quick take, a stat module, a reading column, a sticky sidebar rail and a mid-article row of category highlights. Four publisher placements (`#adpal-slot` and `[data-adpal-slot]`) each sit in a **frame the page reserves from the first paint**: one compact partner line at the foot of the stat card, one in the Business card of the mid-article row, one sponsored card in the sticky sidebar, and one partner strip at the close. Empty frames carry nothing but a quiet “Partner” hairline — no CTA, no placeholder button.

   > **Act 1** — `/terminal/` starts clean: *“Waiting for reader attention…”*.

2. Move the mouse and scroll for a few seconds, as any reader would.
3. The extension measures a **6-second window in the background** for whichever placement is on screen. The phase moves from *Measuring* to *Validating*.
4. The server runs the bot checks, scores the session, mints an **L402 macaroon**, and records the 70/30 split.

   > **Act 2/3** — `/terminal/` streams the `402 Payment Required` challenge, the attention proof, the macaroon caveats and the revenue split as raw JSON.

5. If approved, the sponsored banner appears **inside the article**, automatically, with no interaction. The reader is credited **€0.014** (70% of €0.02).
6. Keep reading: each placement negotiates once, so a full read of the four placements credits **€0.056** and rotates the creative between sponsors.
7. Open **[http://localhost:3000/terminal/](http://localhost:3000/terminal/)** in a second window. At €0.05 the PayPal card's **Settle €0.05 to PayPal** button lights up; `POST /api/payout` creates a real Sandbox batch.

   > **Act 4** — the batch id and status appear in the terminal, and the money lands in the Sandbox account.
8. Open the AdPal popup: live balance, last verification, activity, and rules.

> Use **New run** in the terminal toolbar to clear the stream and reset the ledger between rehearsals. It does not reverse batches already sent to PayPal.

> To see a rejection, keep the tab hidden or stay completely still: the server withholds the offer, the slot stays empty, and the terminal shows the failing guard rail. The article itself stays silent — no error card is shown to the reader.

### 4. Inspect the protocol without a browser

The whole L402 negotiation can be driven from the terminal, exactly as CrawlerPal's Python client does:

```bash
node client/inspect.js                 # contract → attention proof → macaroon → resource → ledger
node client/inspect.js --bot           # prove the refusal path (no credit, context kept for retry)
node client/inspect.js --settle-twice  # prove settlement idempotency
node client/inspect.js --json          # machine-readable transcript, no ANSI noise
```

No dependencies, no build step: it is plain Node 18+ `fetch`. Watch `/terminal/` while it runs to see `l402.contract`, `l402.settle`, `l402.issue`, `l402.verify` and `l402.access` arrive live.

---

## Two separate views

Presentation is deliberately split so a judge never confuses the demo chrome with the product:

**`/demo/` — Publication.** A distraction-free bento-grid front page and reading column for *The Attention Revolution*: a cover card, a quick take, a stat module, a reading column with a sticky sidebar rail, and a mid-article row of category highlights. The only advertising elements are the publisher-declared placements (`#adpal-slot` plus `[data-adpal-slot]`), and each one occupies a **frame the page reserves in CSS before any creative exists**: no “activate” button, no countdown, no “+€0.014” toast, and, crucially, no layout shift. When the L402 challenge settles, the unit fades into a box that was already there — the paragraphs around it never move, so the reader never loses their place. One unit renders as a **sponsored card in the sticky sidebar** (pinned while the essay scrolls), two as a **compact partner line** at the foot of an editorial card, and one as a **partner strip** at the close, so the unit inherits the bento aesthetic instead of interrupting it. There is no inspector, no debug card, no protocol badge and no overlay anywhere on the page.

**`/terminal/` — Agent terminal.** A dedicated dark console, not linked from the article, that shows the protocol as it happens:

| Panel | Contents |
| --- | --- |
| Stream | every event as the raw JSON envelope: `seq`, `at`, `stage`, `source`, `level`, `title`, `detail`, `data` |
| Viewport attention | smoothed 0-100 score, slot visibility, active reading share, article depth, session |
| Negotiation | offer id, advertiser agent id, bid, creative, human score |
| L402 macaroon | offer, payment context token, token id, caveat count, payment hash, expiry, signature status |
| PayPal Sandbox | reader balance, batch id, status, amount, recipient, OAuth2 token state |

Filters separate **L402**, **Attention**, **PayPal** and general **Negotiation** events. ***Follow tail* keeps the newest event in view** — every incoming event pins the stream to the bottom, even if the reader had scrolled up, and unchecking the switch is the only way to stay put. *Pause* freezes the view without dropping events, and *Export .jsonl* downloads the buffer.

**Money is colour-coded.** Standard protocol lines stay neutral, while every ledger split, payout request, OAuth/token event, batch confirmation and acknowledged settlement is painted in the payout accent: a 3 px bright-green left border, a tinted row background, a `€` badge between the stage chip and the title, and green title/detail text. A judge can scan the stream and spot the transaction without opening a single JSON body. Failures still win: a `warn` or `error` money line keeps its amber/red border and title.

An **Agent toolkit** card reports what was read from `AI-Toolkit-main/`: version, MCP endpoint, the tools wired into the server, and whether automatic settlement is on.

Three data paths feed the terminal:

- the server emits every negotiation stage into `Telemetry`, which fans out to SSE subscribers (`GET /api/logs`);
- `paypal.js` publishes redacted request/response bodies for `/v1/oauth2/token`, `/v1/payments/payouts` and the status re-read;
- the content script relays **aggregated** session samples through the service worker to `POST /api/client-event` (one sample every 8 seconds, never raw input).

The terminal is a demonstration surface only. The extension never injects it, and it is not part of the reader experience.
---

## The four-act live demo

The three surfaces are designed to be shown together, in this order:

| Act | Surface | What the audience sees |
| --- | --- | --- |
| **1 · Attention** | `/demo/` | An editorial article with no ad chrome. Reading it is the only input. |
| **2 · 402** | `/terminal/` | `HTTP 402 Payment Required`, the €0.020 offer, the payment hash, the caveats. |
| **3 · Proof** | `/terminal/` | `Attention score 100/100`, macaroon minted and verified, `70% reader / 30% publisher` credited. |
| **4 · Settlement** | `/terminal/` | A real Payouts batch against the Sandbox — created automatically the moment the settled invoice crosses the threshold. |

The terminal carries a **Demo runbook** card that tracks these four steps. It is driven only by real events — if the attention proof is refused, act 1 stays open — and its note always says what to do next.

**New run** in the terminal toolbar clears the stream, resets the ledger (and the L402 context store) and reopens act 1 without restarting the server. Batches already sent to PayPal are not reversed.

The stream is opened as `/api/logs?live=1`, which starts at the current sequence instead of replaying the tail. That is why a refreshed terminal shows *“Waiting for reader attention…”* rather than the previous run; a reconnecting `EventSource` still resumes from `Last-Event-ID`.

Each article placement is worth **€0.014** to the reader, so four verified impressions (€0.056) cross the €0.05 payout threshold. Reload `/demo/` to start a new page view.

### Multi-advertiser rotation

Five advertiser profiles are available, each with its own creative and campaign
budget (`server/src/rotation.js` rotates over `server/src/creatives.js`):

| Sponsor | Agent | Objective |
| --- | --- | --- |
| Northbound Coffee | `agt_northbound_01` | reader-acquisition |
| Lumen Audio | `agt_lumen_02` | consideration |
| Terrace Greens | `agt_terrace_03` | trial-signup |
| Halden Optics | `agt_halden_04` | direct-sale |
| Field Notes Press | `agt_fieldnotes_05` | brand-awareness |

A placement is not bound to one banner:

- the server rotates **per slot** and **over time**, preferring the least-shown
  profile and never repeating the creative that slot just showed;
- a profile whose campaign budget cannot cover the impression is skipped, and
  the **advertiser agent** authorizes every spend before the ledger is credited;
- the extension re-negotiates a placement after `rotateAfterMs` (20 s) of
  continued engagement, up to `maxPerSlot` impressions, and cross-fades the new
  creative in (`opacity` dip, swap, fade up) so the reserved frame never moves;
- the terminal shows a `rotation` event per switch, with the chosen advertiser,
  the reason and the remaining campaign budget.

---

## How the passive flow works

### The slot

- AdPal only activates where the publisher exposes a placement: **`#adpal-slot`** or any element carrying **`[data-adpal-slot]`**. `demo-publisher/index.html` declares four of them across the article.
- Without a declared placement, the extension stays completely invisible and does nothing. It never creates a floating ad on arbitrary pages.
- One negotiation runs at a time across the whole page, so two placements can never be credited for the same stretch of attention. A placement rotates: up to three impressions per page view, each delivered only after a fresh measurement window and never from the advertiser it just showed.
- The placement is untouched until an impression is approved. Then the extension clears publisher fallback content, attaches a **Shadow DOM**, and renders the banner in-flow. Site styles cannot break it.

### The measurement window

`content.js` listens passively and never asks the reader to act:

| Signal | Detail |
| --- | --- |
| Duration | 6-second measurement window after natural engagement |
| Page dwell | time since the page became readable |
| Mouse | number of moves and direction changes |
| Scrolling | number of events and maximum depth |
| Visibility | share of the window where the tab is visible |
| Focus | share of the window where the window is active |
| Interactions | clicks and key presses (counters only) |

A window starts only when the tab is visible, the page has been open for at least 2.5 s, and there are fresh interaction signals. After a rejection, it waits for new signals before trying again. No coordinates, typed text, individual key presses, or page content are transmitted.

### The decision

The service worker posts the report to `POST /api/offer`. The server:

1. validates the requested price (`MAX_OFFER_PRICE` cap) and the per-client rate limit;
2. applies **blocking guard rails** and reports each one as a `checks` entry;
3. computes a **0-100 score** with an explicit factor breakdown;
4. withholds the offer if any guard rail fires or the score is below `HUMAN_THRESHOLD`;
5. otherwise debits the advertiser budget, assigns a creative, and credits **70% to the reader** and **30% to the publisher**.

The extension renders the creative only when the response contains `approved: true`. On rejection the slot simply stays empty.

### The payout

Payouts go through the **real PayPal REST Payouts API** in the sandbox, and they
are triggered by the settlement itself:

- a credited attention proof — either an extension `POST /api/offer` or an L402
  `POST /api/l402/settle` — calls the auto-settlement queue; once the reader
  balance crosses `PAYOUT_THRESHOLD` (€0.05 by default) the protocol agent
  creates the batch on its own (`PAYPAL_AUTO_PAYOUT=true`);
- `POST /api/payout` still exists for a manual settlement (terminal button,
  extension popup, curl) and runs the *same* code path;
- it fetches an OAuth2 token from `https://api-m.sandbox.paypal.com/v1/oauth2/token`, then creates a batch with `POST /v1/payments/payouts`, paying the reader share to `PAYPAL_RECEIVER_EMAIL`;
- the publisher's 30% travels in the same batch as a second item, paid to
  `PAYPAL_PUBLISHER_EMAIL` (defaults to the business account, which PayPal
  accepts as a payout receiver);
- the response contains the real `payout_batch_id` and `batch_status`, which the terminal shows verbatim.

All PayPal calls go through the tools defined in
`server/src/paypal-agent-toolkit.js`: `paypal_get_token`,
`paypal_create_payout`, `paypal_get_payout`, `advertiser_authorize_spend` and
`protocol_split_invoice`. They implement what the toolkit's
`skills/paypal-best-practices/references/payouts.md` requires — environment-only
credentials, `sender_item_id`/`PayPal-Request-Id` idempotency, exponential
backoff on HTTP 429 — and the toolkit's MCP endpoint
(`https://mcp.sandbox.paypal.com/sse`) is reported in `/api/toolkit` and the
terminal.

Amounts are floored to whole cents, so any remainder stays on the balance for the next payout. Nothing is debited unless PayPal accepts the batch: a network error or API rejection leaves both balances untouched.

Below the threshold, the API returns `409 THRESHOLD_NOT_REACHED` with the missing amount. Missing credentials return `503 PAYPAL_NOT_CONFIGURED`, and a rejected batch returns the PayPal issue code (for example `RECEIVER_UNREGISTERED`).

### The Solana Devnet rail

The same settlement can be paid on-chain instead. `PAYOUT_RAIL` picks the rail
the automatic queue uses, and `POST /api/payout { "rail": "solana-devnet" }`
forces it per request; the PayPal path is untouched.

Three things happen on-chain (`server/src/solana.js`):

1. **The proof is anchored.** On settle, the invoice's `sha256(preimage)` — the
   same 32 bytes the 402 challenge minted and the macaroon commits to — is
   written into a Memo instruction signed by the treasury. The receipt carries
   the transaction signature, so the hash is now publicly checkable:

   ```
   ADPAL/v1|kind=l402-proof|hash=<64 hex>|ref=l402_cae7b7f8|score=98|offer=attention_session_v1
   ```

2. **The proof is verified.** `POST /api/l402/solana/confirm` re-reads a
   signature from the cluster and checks, individually: the transaction exists,
   is `confirmed`/`finalized`, has no `meta.err`, its memo commits to *this*
   invoice's hash, the expected recipient received it, the amount is exactly the
   expected number of base units, and the signature has not settled anything
   else. Settlement accepts the same proof through `solana_signature`, and an
   invalid chain proof answers `402 SOLANA_PROOF_INVALID` without burning the
   context.

3. **The split is paid on-chain.** One transaction carries two `SystemProgram`
   transfers (or two `transferChecked` instructions for an SPL mint) and a memo
   with the payout reference and the L402 hash. Both legs are in one transaction,
   so the split is atomic: either the reader and the publisher are paid, or
   neither is.

#### Integer base units, no drift

The ledger is denominated in euros at four decimals; Solana amounts are integers.
The conversion is one multiplication, applied once per leg:

```
units = round(euros × SOLANA_UNITS_PER_EUR)      // 1e8 lamports = 0.1 SOL per €1
```

Nothing is floored (unlike PayPal's cent quantiser), and the two integers sum to
the integer image of the total, so no fraction of a unit is lost. `splitUnits()`
also re-derives the 70/30 ratio from the total in base units and reports `drift`
— normally `0`. The legs are never force-balanced against each other, because
doing so would move money the ledger never reserved (a capped reader payout would
drain the publisher balance); the alignment is measured, not manufactured.

#### Funding the treasury

A fresh devnet keypair holds no SOL, and the anchor plus a payout need fees.
`SOLANA_AIRDROP=true` makes the server try the devnet faucet when it needs funds
(once a minute, because the public faucet rate-limits hard). If the faucet
refuses, the rail reports `unfunded` — the settlement still succeeds, the receipt
says the anchor was skipped, and `/api/solana` prints the treasury address to
fund at <https://faucet.solana.com>. With a funded keypair, set
`SOLANA_TREASURY_SECRET` (base58 or JSON bytes) and everything runs from the
first request.

`SOLANA_FALLBACK_TO_PAYPAL=true` keeps a demo alive when devnet cannot confirm a
transfer: the reservation is cancelled, a warning is emitted, and the same 70/30
split is sent through PayPal instead.

---

## API

All responses are JSON. Base URL: `http://localhost:3000`.

### `GET /api/health`

```json
{
  "status": "ok",
  "service": "adpal-simulator",
  "version": "1.0.0",
  "port": 3000,
  "demoUrl": "http://localhost:3000/demo/",
  "uptimeSeconds": 12,
  "toolkit": {
    "present": true,
    "version": "1.2.0",
    "tools": 5,
    "mcp": "https://mcp.sandbox.paypal.com/sse"
  },
  "agents": ["agt_northbound_01", "agt_lumen_02", "agt_terrace_03", "agt_halden_04", "agt_fieldnotes_05"]
}
```

### `GET /api/toolkit`

The capability profile read from `AI-Toolkit-main/`: plugin version, license,
sandbox MCP endpoint and transport, skills, the Payouts reference, the tool
inventory this server exposes, and the retry policy. A missing checkout reports
`present: false` and the simulator still boots.

### `GET /api/agents`

The rotation roster — advertiser agent id, sponsor, objective, campaign budget,
spend and impressions — plus the current 70/30 split and whether automatic
payout is enabled.

### `GET /api/balance`

```json
{
  "currency": "EUR",
  "threshold": 0.05,
  "user": {
    "balance": 0.014,
    "lifetime": 0.014,
    "offersAccepted": 1,
    "offersRejected": 0
  },
  "publisher": {
    "balance": 0.006,
    "lifetime": 0.006,
    "publishers": [
      { "name": "localhost", "balance": 0.006, "lifetime": 0.006, "offers": 1 }
    ]
  },
  "advertiser": {
    "budget": 49.98,
    "initialBudget": 50,
    "spent": 0.02
  },
  "rules": {
    "maxPrice": 0.05,
    "userShare": 0.7,
    "publisherShare": 0.3,
    "threshold": 0.05,
    "humanThreshold": 50,
    "payoutMode": "grouped"
  },
  "recentOffers": [],
  "payouts": [],
  "stats": { "offersTotal": 1, "payoutsTotal": 0 }
}
```

### `GET /api/telemetry?since=<seq>`

Incremental feed used by scripts and tests. Events are sequence-numbered and kept in a 500-event ring buffer.

```json
{
  "seq": 6,
  "events": [
    {
      "seq": 1,
      "at": "2026-10-21T09:22:30.412Z",
      "stage": "request",
      "source": "extension.agent",
      "level": "info",
      "title": "Offer requested",
      "detail": "€0.020 · localhost · The city reinvents its squares",
      "data": { "price": 0.02, "slot": "declared" }
    }
  ],
  "guards": [
    { "id": "automation", "label": "Automation flag" }
  ],
  "rules": {
    "humanThreshold": 50,
    "userShare": 0.7,
    "publisherShare": 0.3,
    "payoutThreshold": 0.05,
    "maxPrice": 0.05
  }
}
```

Stages: `request`, `checks`, `score`, `rotation`, `agent.advertiser`, `agent.protocol`, `decision`, `l402.contract`, `l402.settle`, `l402.challenge`, `l402.issue`, `l402.verify`, `l402.access`, `creative`, `ledger`, `attention`, `payout`, `paypal.oauth`, `paypal.payout`, `paypal.status`, `paypal.retry`, `system`. Levels: `info`, `ok`, `warn`, `error`. Money-moving stages (`ledger`, `payout`, `paypal.*`, `agent.protocol`, acknowledged `l402.settle`) are rendered with the terminal's bright-green transaction accent.

### `GET /api/logs` (SSE)

The same events as `/api/telemetry`, pushed live. Used by `/terminal/`.

- `event: hello` — stream metadata: service, seq, rules, agents, L402 TTL, PayPal profile.
- `event: log` — one event per frame, with `id: <seq>` and the full JSON envelope as `data`.
- `: heartbeat` — comment frame every 15 s to keep intermediaries from timing out.
- A fresh connection replays the last 40 events. A reconnecting `EventSource` sends `Last-Event-ID` and resumes exactly where it stopped; `?since=<seq>` overrides the default.

PayPal credentials are redacted before they reach this stream: OAuth tokens are truncated, client secrets and bearer tokens appear only as `<redacted>`. The one deliberate exception is the L402 macaroon: it is a five-minute demo token, and showing it verbatim is the point of the protocol log.

### `POST /api/client-event`

Silent sink for the content script's aggregated session samples (`kind`, `level`, `title`, `detail`, `data`, `host`). The publication page renders none of it; it exists so the terminal can show what the extension measured while the reader was simply reading.

### `POST /api/offer`

Expected body (the values below produce an approved offer):

```json
{
  "clientId": "demo-client",
  "price": 0.02,
  "signals": {
    "durationMs": 6200,
    "pageDwellMs": 12000,
    "mouseMoves": 32,
    "directionChanges": 11,
    "scrollEvents": 5,
    "scrollDepth": 0.62,
    "clicks": 2,
    "keyPresses": 1,
    "visibleRatio": 1,
    "focusRatio": 1,
    "webdriver": false,
    "clientSentAt": 1792578000000
  },
  "page": {
    "title": "The city reinvents its squares",
    "host": "localhost"
  },
  "slot": {
    "detected": true
  }
}
```

Example with `curl.exe` (Windows) or `curl`:

```bash
curl -X POST http://localhost:3000/api/offer \
  -H "Content-Type: application/json" \
  -d '{"clientId":"demo","price":0.02,"signals":{"durationMs":6200,"mouseMoves":32,"directionChanges":11,"scrollEvents":5,"scrollDepth":0.62,"clicks":2,"keyPresses":1,"visibleRatio":1,"focusRatio":1,"clientSentAt":1792578000000},"page":{"title":"Demo","host":"localhost"},"slot":{"detected":true}}'
```

Approved response (excerpt):

```json
{
  "approved": true,
  "offerId": "ofr_1a2b3c4d",
  "score": 99,
  "verdict": "human",
  "reason": "Attention signal consistent with human browsing.",
  "price": 0.02,
  "checks": [
    { "id": "automation", "label": "Automation flag", "status": "pass", "detail": "navigator.webdriver = false" }
  ],
  "split": {
    "user": 0.014,
    "publisher": 0.006,
    "userRate": 0.7,
    "publisherRate": 0.3
  },
  "creative": {
    "id": "northbound-coffee",
    "sponsor": "Northbound Coffee",
    "headline": "Coffee that wakes up your ideas.",
    "body": "Small-batch roasting, delivered to your door every week.",
    "cta": "Discover Northbound",
    "theme": "coffee"
  },
  "balance": { "...": "full snapshot" }
}
```

Rejected response: status `200`, `approved: false`, with `score`, `reason`, `hint`, `flags`, `checks`, and the full `factors` breakdown. The creative is only assigned on approval.

Errors: `400 INVALID_PRICE`, `400 PRICE_TOO_HIGH`, `429 RATE_LIMITED` (one request per second per client), `402 ADVERTISER_BUDGET_EXHAUSTED`.

---

## L402 protocol surface

`POST /api/offer` is the endpoint the extension uses: it submits signals and gets a decision in one call. Agents, scripts and auditors get a separate, explicit **L402 negotiation**, modelled on CrawlerPal's FastAPI reference server (`server/main.py` + `client/main.py`).

The difference from the reference is that AdPal never sniffs the `User-Agent`. The publication lives at `/demo/` and the contract only at `/api/l402/*`, so a browser can never be mistaken for an agent and an agent can never be served the article.

### `GET /api/l402/offer`

Without a `Bearer` token it answers **HTTP 402** and the offer contract:

```json
{
  "version": "1.0.0",
  "protocol": "L402",
  "payment_request_url": "http://localhost:3000/api/l402/settle",
  "payment_context_token": "aa09327b-252f-4efe-b932-d8da1188bf57",
  "expires_at": "2026-10-25T16:06:11.643Z",
  "selected_offer_id": "attention_impression_v1",
  "offers": [
    {
      "id": "attention_impression_v1",
      "title": "Human Attention Verification",
      "description": "70% reader split / 30% publisher split upon human attention proof",
      "amount": 0.02,
      "currency": "EUR",
      "payment_methods": ["paypal_payouts"]
    },
    {
      "id": "attention_session_v1",
      "title": "Verified Reading Session",
      "description": "Up to 12 verified impressions during one hour of reading, same 70/30 split",
      "amount": 0.05,
      "currency": "EUR",
      "type": "session",
      "duration": "1 hour",
      "max_impressions": 12,
      "payment_methods": ["paypal_payouts"]
    }
  ],
  "payment_request": {
    "method": "POST",
    "url": "http://localhost:3000/api/l402/settle",
    "content_type": "application/json",
    "required_fields": ["payment_context_token", "offer_id", "attention.signals"],
    "body": { "payment_context_token": "aa09327b-…", "offer_id": "attention_impression_v1", "attention": { "signals": {} } },
    "signals_schema": { "durationMs": "integer — measured session length in ms (min 2500)", "…": "…" }
  },
  "challenge": {
    "scheme": "L402",
    "caveat": "viewport-gated",
    "ttl_ms": 300000,
    "payment_hash": "1a086cb0923ce054d768d5a0fcf4d2ecb3d11fcf9b88a4d4a01f1f75e6a4c8b5",
    "www_authenticate": "L402 macaroon=\"pending\", payment_hash=\"1a08…\", caveat=\"viewport-gated\""
  }
}
```

The response also sets `WWW-Authenticate: L402 …`. The payment hash is minted **before** the client pays, so the macaroon issued later is cryptographically bound to the challenge the client actually received.

Add `?offer_id=attention_session_v1` to pin the contract to one offer.

With a valid `Authorization: Bearer <token>` the same URL returns **HTTP 200** and the paid resource: the impression receipt, the 70/30 split, the creative, the agent that bought it, and the current balance.

### `POST /api/l402/challenge`

Same contract, but created explicitly by POST (both `/api/l402/*` and `/l402/*` are mounted). Useful when an agent wants to name the publisher:

```json
{ "offer_id": "attention_impression_v1", "publisher": "localhost" }
```

### `POST /api/l402/settle`

This is the `payment_request_url` advertised in the contract. In L402 terms the "payment" is proven human attention:

```json
{
  "payment_context_token": "aa09327b-252f-4efe-b932-d8da1188bf57",
  "offer_id": "attention_impression_v1",
  "attention": { "signals": { "durationMs": 6400, "mouseMoves": 38, "scrollEvents": 7, "visibleRatio": 0.98, "webdriver": false } }
}
```

Accepted (HTTP 200):

```json
{
  "message": "Payment settled",
  "protocol": "L402",
  "bearer_token": "eyJ2IjoxLCJpIjoibDQwMjpjMDJm…",
  "token_type": "Bearer",
  "payment_context_token": "aa09327b-…",
  "expires_at": "…",
  "macaroon": { "id": "mcr_c02ffc3ab332", "caveats": 8, "caveatList": ["offer_id=…", "…"], "paymentHashFull": "…" },
  "receipt": { "reference": "l402_aa09327b", "split": { "user": 0.014, "publisher": 0.006 }, "creative": { "…": "…" }, "agent": { "…": "…" } },
  "proof": { "score": 100, "verdict": "human", "checks": ["…"] },
  "balance": { "…": "full snapshot" }
}
```

The `bearer_token` is the macaroon: identifier `l402:<sha256(preimage)>` plus eight HMAC-chained caveats, verified before it is returned. Both the macaroon **and** the raw `payment_context_token` work as a `Bearer` credential, so a CrawlerPal-style client works unchanged.

Refused (HTTP 402): settlement re-returns the contract with `error.code = "ATTENTION_NOT_VERIFIED"`, plus `score`, `threshold`, `flags` and `checks`. The context token is **not** burned, so the same token can be retried once the reader actually engages.

Idempotent: repeating the POST on a settled context returns 200 with `"idempotent": true` and the same bearer token — no double credit.

Other errors: `400 OFFER_MISMATCH`, `402 UNKNOWN_PAYMENT_CONTEXT`, `402 CONTEXT_EXPIRED`, `402 ADVERTISER_BUDGET_EXHAUSTED`, `402 INVALID_MACAROON` (tampered caveats on read).

### `GET /api/l402/receipt/:payment_context_token`

The negotiation receipt: state (`issued` → `settled` → `consumed`, or `expired`), attempts, reads, macaroon, proof and ledger receipt. Preimages are never exposed.

### `GET /api/l402/sessions?limit=20`

The offer catalogue, context statistics and the most recent negotiations. The terminal uses the same data via SSE.

### `client/inspect.js`

A dependency-free CLI that walks the whole loop, after CrawlerPal's `client/main.py`:

```bash
node client/inspect.js                 # contract → proof → macaroon → resource → ledger
node client/inspect.js --bot           # prove the refusal path (no credit, context kept)
node client/inspect.js --settle-twice  # prove settlement idempotency
node client/inspect.js --with-auth <bearer>
node client/inspect.js --json          # machine-readable transcript
node client/inspect.js --server http://localhost:3001 --offer attention_session_v1
```

Example run:

```text
[1] Requesting the offer contract (unauthenticated)
    status: 402 Payment Required
    ✓ 402 Payment Required · contract received
    payment_context_token: 1bb0c906-3831-4ff8-9294-8a965817ac02
    payment_hash: c02ffc3ab3321e9cadde7ef8ec1bd9b54975329911250b01374e0b8ee31c748e

[2] Settling with an attention proof
    status: 200 OK
    ✓ settled · bearer token issued
    macaroon id: mcr_c02ffc3ab332 · caveats: 8
    attention: 100/100 · human

[3] Reading the paid resource with the Bearer token
    ✓ resource served · impression · attention_impression_v1
    receipt: l402_a336c313 · €0.014 reader / €0.006 publisher

[4] PayPal ledger state
    reader balance: €0.014 · publisher balance: €0.006 · threshold: €0.100
```

Every step is also streamed to the terminal as `l402.contract`, `l402.settle`, `l402.issue`, `l402.verify` and `l402.access`, so a demo run can be inspected live.

### `POST /api/payout`

No body required. Optional fields:

| field | meaning |
| --- | --- |
| `rail` | `paypal_payouts` (default) or `solana-devnet` |
| `receiverEmail` / `publisherEmail` | PayPal overrides |
| `paymentHash` | 64-hex L402 hash to commit in the Solana memo |
| `reason` | Free-text label shown in the stream |

Creates a **real payout on the selected rail**: a PayPal Sandbox batch, or a
single Solana Devnet transaction carrying both 70/30 legs.

- **PayPal batch accepted** → `200`

```json
{
  "settled": true,
  "payout": {
    "id": "pay_ab12cd34",
    "reference": "ADPAL-MVHV4IK4",
    "method": "paypal",
    "userAmount": 0.11,
    "publisherAmount": 0.04,
    "currency": "EUR",
    "paypal": {
      "batchId": "FVX5YM69EQ89N",
      "status": "PENDING",
      "rawStatus": "PENDING",
      "receiverEmail": "sb-jokak53538300@business.example.com",
      "mode": "sandbox"
    },
    "remainder": { "user": 0.002, "publisher": 0.008 }
  },
  "paypal": {
    "configured": true,
    "mode": "sandbox",
    "batchId": "FVX5YM69EQ89N",
    "status": "PENDING",
    "amount": 0.11,
    "currency": "EUR",
    "receiverEmail": "sb-jokak53538300@business.example.com",
    "selfUrl": "https://api-m.sandbox.paypal.com/v1/payments/payouts/FVX5YM69EQ89N"
  },
  "balance": { "...": "reader and publisher balances debited" }
}
```

- **Threshold not reached** → `409`

```json
{
  "settled": false,
  "error": "THRESHOLD_NOT_REACHED",
  "message": "Payout threshold of €0.100 not reached: €0.086 short.",
  "missing": 0.086
}
```

- **PayPal rejected the batch** → `502`

```json
{
  "settled": false,
  "error": "RECEIVER_UNREGISTERED",
  "message": "The recipient email is not a confirmed PayPal Sandbox account.",
  "issues": [{ "issue": "RECEIVER_UNREGISTERED", "description": "…" }],
  "debugId": "…"
}
```

`POST /api/flush-payout` is kept as an alias so the extension popup uses the same rail.

**Solana Devnet payouts** return the same envelope with `rail: "solana-devnet"`
and a `solana` block instead of `paypal`:

```json
{
  "settled": true,
  "rail": "solana-devnet",
  "payout": {
    "id": "pay_ab12cd34",
    "method": "solana",
    "userAmount": 0.07,
    "publisherAmount": 0.03,
    "solana": {
      "signature": "4h8…",
      "status": "confirmed",
      "cluster": "devnet",
      "memo": "ADPAL/v1|kind=payout|hash=…|ref=ADPAL-…|reader=7000000|publisher=3000000",
      "units": { "reader": 7000000, "publisher": 3000000, "total": 10000000 }
    }
  },
  "solana": { "signature": "4h8…", "explorerUrl": "https://explorer.solana.com/tx/4h8…?cluster=devnet", "…": "…" }
}
```

### `GET /api/payout/:id`

Re-reads a payout so a `PENDING` transfer can be shown as settled once the rail
processed it. `id` is a PayPal batch id **or** a Solana transaction signature —
the rail is inferred from the shape and echoed back as `rail`.

```json
{
  "ok": true,
  "status": {
    "batchId": "FVX5YM69EQ89N",
    "status": "PENDING",
    "rawStatus": "PENDING",
    "amount": 0.11,
    "currency": "EUR",
    "itemStatus": "PENDING",
    "itemId": "6WQGRVHVRLLAC"
  },
  "payout": { "...": "matching ledger payout, status updated" }
}
```

For a signature the `status` object is `{ signature, slot, confirmationStatus,
confirmations, err, explorerUrl }`.

### `GET /api/solana`

The devnet rail profile, plus live balances read from the cluster.

```json
{
  "enabled": true,
  "rail": "solana-devnet",
  "cluster": "devnet",
  "rpcUrl": "https://api.devnet.solana.com",
  "currency": "SOL",
  "unitsPerEuro": 100000000,
  "treasury": "C1VU5k76F43Qvvr9D64ZmjvGxNuwpjmwrRcaaTXQaNby",
  "reader": "6Anfr5dPkpdRn73jXjFQoDYZ8HkQWTTVAK7vcdrUmkb2",
  "publisher": "CFTa5327froMB89kJpokRRXFAPrm1eFBZeXWGrDNVAxw",
  "ready": true,
  "balances": { "treasury": 1000000000, "reader": 0, "publisher": 0, "treasurySol": 1 },
  "faucetUrl": "https://faucet.solana.com?address=C1VU…&network=devnet",
  "payoutRail": "solana-devnet"
}
```

### `POST /api/solana/fund`

Asks the devnet faucet for treasury SOL (`{ "sol": 1 }`, default
`SOLANA_AIRDROP_SOL`). The public faucet is rate-limited per IP; when it refuses,
the response carries the treasury address and a faucet link instead of failing
silently.

### `POST /api/l402/solana/confirm`

Out-of-band confirmation of an on-chain L402 proof. The transaction is re-read
from devnet and every check is returned individually.

```bash
curl -X POST http://localhost:3000/api/l402/solana/confirm \
  -H 'content-type: application/json' \
  -d '{"signature":"4h8…","payment_context_token":"cae7…"}'
```

```json
{
  "verified": true,
  "rail": "solana-devnet",
  "cluster": "devnet",
  "signature": "4h8…",
  "payment_hash": "579fb8ca…",
  "slot": 515067123,
  "confirmation_status": "confirmed",
  "memo": "ADPAL/v1|kind=l402-proof|hash=579fb8ca…|ref=l402_cae7b7f8|score=98",
  "checks": [
    { "id": "replay", "label": "First use of this signature", "passed": true, "detail": "Not seen before" },
    { "id": "exists", "label": "Transaction found on devnet", "passed": true, "detail": "slot 515067123" },
    { "id": "confirmed", "label": "Confirmed on devnet", "passed": true, "detail": "confirmed" },
    { "id": "succeeded", "label": "No on-chain error", "passed": true, "detail": "meta.err = null" },
    { "id": "memo", "label": "Memo commits to the L402 hash", "passed": true, "detail": "hash=579fb8ca365d4e7a…" }
  ],
  "reason": "Transaction confirmed and the memo commits to this L402 hash.",
  "explorerUrl": "https://explorer.solana.com/tx/4h8…?cluster=devnet"
}
```

`payment_hash` may be supplied instead of a context token. A failed check answers
`402` with the failing checks; a signature already used for a settlement answers
`409 SIGNATURE_ALREADY_SETTLED`.

### `server/scripts/solana-smoke.js`

End-to-end smoke test against a running server: health → devnet profile →
challenge → settle (prints the anchor) → `solana/confirm` on the anchor →
a payout forced on each rail.

```bash
cd server
node scripts/solana-smoke.js
```

### `POST /api/dev/reset`

Developer tool: clears the accounts, the history, and the rate limits, and emits a `system` telemetry event.

```bash
curl -X POST http://localhost:3000/api/dev/reset
```

---

## PayPal webhooks

### `POST /api/webhooks/paypal`

The one route a client never calls. Register it in the PayPal dashboard, and
PayPal will `POST` payout notifications (`PAYMENT.PAYOUTS-ITEM.SUCCEEDED`,
`.FAILED`, `.RETURNED`, `.BLOCKED`, `.CANCELED`, `.UNCLAIMED`, `.ONHOLD`,
`.REFUNDED`) as the batch progresses.

```bash
curl -X POST http://localhost:3000/api/webhooks/paypal \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "WH-DEMO-1",
    "event_type": "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    "resource_type": "payouts",
    "resource": { "payout_batch_id": "XKGQ3VT6VDJ2Q", "transaction_status": "SUCCESS" }
  }'
```

```json
{
  "ok": true,
  "received": true,
  "event_id": "WH-DEMO-1",
  "event_type": "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "outcome": "handled",
  "signature": "skipped",
  "signature_reason": "PAYPAL_WEBHOOK_ID is not set, so the signature could not be verified.",
  "rail": "paypal_payouts",
  "batch_id": "XKGQ3VT6VDJ2Q",
  "status": "SUCCESS",
  "reversal": { "reversed": false, "restored": 0 },
  "payout": { "id": "pay_9a1ea53f", "rail": "paypal_payouts" },
  "balance": { "...": "the ledger snapshot" }
}
```

**Acknowledging is part of the contract.** PayPal retries anything that is not a
2xx, so a well-formed event this simulator chooses not to act on still returns
`200` — `outcome` says what happened:

| `outcome` | meaning |
| --- | --- |
| `handled` | the ledger was updated |
| `ignored` | a known type with nothing to apply, or a type this simulator does not model |
| `duplicate` | the event id was already processed, or the payout was already reversed |
| `unmatched` | well-formed, but no ledger record matches the batch id (e.g. after a restart) |

Only three responses are refusals: an unparseable body is `400`, a signature
PayPal rejects is `401`, and strict mode with no way to verify is `503`.

**A failed payout puts the money back.** `commitPayout` debits the balances as
soon as the rail accepts the batch, but payout items can still fail afterwards —
an unregistered receiver, a restricted account. A terminal failure therefore
*reverses* the payout: the reader and publisher balances are restored, because
the money never left. `UNCLAIMED` and `ONHOLD` are deliberately **not** terminal
and only update the status, since reversing early would pay the same share twice.
Both the reversal and the replay guard are idempotent, so a redelivered
notification cannot mint money.

**Signature verification.** The route keeps the raw request body (a `express.raw`
parser is mounted on this path *before* the JSON parser), so the event is parsed
from the exact bytes PayPal signed. Verification itself is a round-trip to
`POST /v1/notifications/verify-webhook-signature` and needs `PAYPAL_WEBHOOK_ID`:

- no id or no credentials → `signature: "skipped"`, event still accepted, so the
  sandbox demo works out of the box;
- `PAYPAL_WEBHOOK_STRICT=true` and nothing to verify against → `503`, which is
  the setting to use anywhere that is not a demo.

---

## Configuration

Copy `server/.env.example` to `server/.env`, then adjust:

```bash
cd server
copy .env.example .env      # Windows (cmd)
# cp .env.example .env      # macOS / Linux
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | *(unset → development)* | `development` serves every view `no-store` with hashed asset URLs; `production` enables `must-revalidate` + validators |
| `PORT` | `3000` | Preferred Express server port |
| `PORT_SCAN_RANGE` | `10` | Ports to try (`3001`, `3002`, …) if `PORT` is taken |
| `PAYOUT_THRESHOLD` | `0.05` | Reader balance that unlocks a PayPal payout, in euros |
| `MAX_OFFER_PRICE` | `0.05` | Maximum price accepted per offer |
| `DEFAULT_OFFER_PRICE` | `0.02` | Informational price exposed in the rules |
| `USER_SHARE` | `0.7` | User share (the remainder goes to the publisher) |
| `ADVERTISER_BUDGET` | `50` | Simulated initial advertiser budget |
| `HUMAN_THRESHOLD` | `50` | Minimum score required to approve an offer |
| `PAYPAL_MODE` | `sandbox` | `sandbox` or `live` (the demo only ever uses sandbox) |
| `PAYPAL_CLIENT_ID` | — | REST app client id from the PayPal developer dashboard |
| `PAYPAL_CLIENT_SECRET` | — | REST app secret (server-side only, never sent to the page) |
| `PAYPAL_BUSINESS_EMAIL` | `sb-jokak53538300@business.example.com` | Sandbox account the batch is sent from |
| `PAYPAL_RECEIVER_EMAIL` | business email | Recipient of the reader (70%) share |
| `PAYPAL_PUBLISHER_EMAIL` | business email | Recipient of the publisher (30%) share, in the same batch |
| `PAYPAL_CURRENCY` | `EUR` | Payout currency |
| `PAYPAL_MAX_PAYOUT` | `5` | Guard rail: largest amount a single demo payout may move |
| `PAYPAL_TIMEOUT_MS` | `15000` | Abort a PayPal HTTP call after this long |
| `PAYPAL_AUTO_PAYOUT` | `true` | Create the batch automatically when a settled invoice crosses the threshold |
| `PAYPAL_AUTO_PAYOUT_DELAY_MS` | `900` | Pause between the settlement event and the PayPal call |
| `PAYPAL_AUTO_PAYOUT_MIN_INTERVAL_MS` | `15000` | Minimum gap between two automatic batches |
| `PAYPAL_WEBHOOK_ID` | *(empty)* | Webhook id from the PayPal dashboard. Without it, notifications are accepted but reported `unverified` |
| `PAYPAL_WEBHOOK_STRICT` | `false` | `true` refuses unverified notifications (503) instead of accepting them — use outside a sandbox demo |
| `PAYPAL_WEBHOOK_REPLAY_WINDOW` | `500` | Event ids remembered to suppress PayPal's retries |
| `PAYOUT_RAIL` | `paypal_payouts` | Active automatic rail: `paypal_payouts` or `solana-devnet` |
| `SOLANA_ENABLED` | `true` | Enable the devnet rail |
| `SOLANA_CLUSTER` | `devnet` | Label used in explorer links |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Devnet RPC endpoint |
| `SOLANA_CURRENCY` / `SOLANA_MINT` / `SOLANA_DECIMALS` | `SOL` / *(empty)* / `9` | Native SOL, or an SPL mint address to pay in that token |
| `SOLANA_UNITS_PER_EUR` | `100000000` | Base units per euro (0.1 SOL per €1); integer by design |
| `SOLANA_TREASURY_SECRET` | *(empty)* | Base58 or JSON byte array; when empty a keypair is generated and persisted |
| `SOLANA_KEYPAIR_FILE` | `server/.solana-devnet-keys.json` | Where generated demo keypairs live (gitignored) |
| `SOLANA_READER_ADDRESS` / `SOLANA_PUBLISHER_ADDRESS` | *(empty)* | Fixed destinations for the two legs |
| `SOLANA_AIRDROP` / `SOLANA_AIRDROP_SOL` | `true` / `1` | Try the devnet faucet when the treasury is short |
| `SOLANA_ANCHOR_PROOFS` | `true` | Anchor `sha256(preimage)` on settle |
| `SOLANA_ANCHOR_TIMEOUT_MS` / `SOLANA_TIMEOUT_MS` | `8000` / `15000` | Confirmation timeouts |
| `SOLANA_MAX_PAYOUT` | `5` | Guard rail for a single devnet payout |
| `SOLANA_FALLBACK_TO_PAYPAL` | `true` | Send the same split through PayPal if devnet cannot confirm |

PayPal credentials are only read by the server. The page and the extension never receive them: the terminal gets the mode, the recipient, and the batch result, nothing more. OAuth tokens are truncated to a prefix before they reach the log.

If a payout stays `PENDING`, that is the sandbox's own processing state. `POST /api/payout` reports exactly what PayPal returned; the **Refresh** action in the terminal re-reads the batch with `GET /v1/payments/payouts/{id}`. Paying the business account itself is useful as a demo, but the batch only completes when the recipient is a separate **personal** Sandbox account — set `PAYPAL_RECEIVER_EMAIL` to that address.

The price actually requested is defined in `extension/content.js` (`CONFIG.price`, €0.02 by default). The server rejects it if it exceeds `MAX_OFFER_PRICE`.

The simulator **never fails because of a busy port**. If `PORT` is already taken (a stale terminal, another app), it walks forward through `PORT_SCAN_RANGE` following ports and prints the one it settled on:

```text
[AdPal] Port 3000 is busy, trying 3001…

  AdPal — local simulator
  API        http://localhost:3001/api/balance
  Demo       http://localhost:3001/demo/
  Note       port 3000 was busy, using 3001
```

The extension does not need reconfiguration when that happens. It resolves the server in this order:

1. the origin of the publisher page that requested the offer (`serverHint`, only sent by local pages);
2. the last known URL cached in `chrome.storage.local`;
3. a scan of `localhost` / `127.0.0.1` on ports 3000-3010.

Every response is validated against `GET /api/health` (`service === 'adpal-simulator'`), so an unrelated app on a scanned port is never mistaken for the simulator. On a network failure the worker re-discovers once and replays the request, which also covers a server restarted on a different port.

The publication is served by the simulator itself, so all of its API calls are relative and follow the active port automatically. The terminal header shows the live host (e.g. `localhost:3001`) and its SSE endpoint.

The passive loop timings live in `CONFIG` at the top of `extension/content.js`:

| Key | Default | Purpose |
| --- | --- | --- |
| `dwellBeforeStartMs` | `2500` | Minimum page dwell before a window can start |
| `sessionMs` | `6000` | Measurement window length |
| `maxPerSlot` | `3` | Paid impressions per placement before it rotates |
| `rotateAfterMs` | `20000` | Gap between a delivered creative and the next rotation |
| `retryCooldownMs` | `10000` | Delay after a rejection |
| `minNewSignals` | `4` | Fresh interactions required before retrying |
| `maxImpressionsPerPage` | `9` | Cap across all placements on one page load |

---

## Attention heuristic

`server/src/heuristic.js` is deliberately readable and deterministic. It is not an AI model: it is an explainable mock with no personal data.

### Blocking guard rails

Any single one of these conditions rejects the offer:

- `webdriver === true` (automated browser);
- session shorter than 2.5 s;
- fewer than 2 mouse moves **and** no scrolling **and** no click;
- tab visible for less than 45% of the session;
- more than 60 mouse moves per second;
- client timestamp off by more than 2 minutes;
- frantic scrolling (more than 200 events at maximum depth).

Every guard rail is returned in `checks` with a `pass`/`fail` status and a human-readable detail. On rejection, the reported score is capped at 35.

### Score (0-100)

| Component | Max points |
| --- | --- |
| Base | 15 |
| Attention duration (6 s = maximum) | 20 |
| Mouse movement (24 = maximum) | 20 |
| Direction changes (8 = maximum) | 10 |
| Reading depth (50% = maximum) | 10 |
| Scroll events (4 = maximum) | 5 |
| Tab visibility | 10 |
| Window focus | 8 |
| Explicit interactions | 2 |
| Penalty when interaction is near zero | −8 |

An offer is approved only if **no guard rail** fires and `score >= HUMAN_THRESHOLD`.

Assumed limits: signals come from the client and remain spoofable. A real system would need publisher-verified impressions, signatures, fraud detection, and explicit consent.

---

## Simulated economics

For a **€0.02** offer:

```text
Advertiser  ── €0.020 ──►  Approved offer
                              ├── 70% ──►  Reader    : €0.014
                              └── 30% ──►  Publisher : €0.006
```

- Amounts are rounded to four decimal places.
- The advertiser starts with a €50 budget; each approved offer debits it.
- The €0.10 threshold is deliberately low: eight approved impressions reach it.
- Balances and history live **in memory**: a restart resets everything.

---

## Privacy

**Sent to the local server**

- aggregated counters: duration, movement, direction changes, scrolling, depth, clicks, key presses;
- visibility and focus ratios;
- the `webdriver` flag;
- page title and host name;
- a random client ID stored in `chrome.storage.local`.

**Relayed silently to the simulator**

- the same aggregated counters, so the agent terminal can display them during a session;
- a compact attention sample every 8 seconds (never raw input);
- lifecycle events (slot detected, session started, creative delivered).

The publication page itself renders none of it.

**Never sent**

- mouse coordinates;
- key or field content;
- full URL, query parameters, cookies;
- page content or form data.

The history keeps only the title, host, score, price, and split.

---

## Placement on other pages

AdPal fills **publisher-declared inventory**. To monetize a page, add:

```html
<div id="adpal-slot" data-adpal-layout="banner"></div>
```

Three shapes are available:

| `data-adpal-layout` | Unit | Where to put it |
| --- | --- | --- |
| `banner` (default) | partner card the width of the reading column | a dedicated full-width frame at the end of an article or section |
| `inline` | compact partner line, no border of its own | the foot of one of the page's own cards |
| `rail` | vertical sponsored card | a sidebar column beside the reading measure |

**Reserve the space, don't create it on delivery.** CLS is the publisher's half of the contract: give every placement a fixed height in your own stylesheet, so the box exists before any creative does. The demo does this in `demo-publisher/style.css`:

```css
.adpal-slot {
  --adpal-frame-h: 196px;            /* the unit is ~173px; leave headroom */
  display: grid;
  place-items: center;
  min-height: var(--adpal-frame-h);
}

/* Optional: the frame is identified while it waits… */
.adpal-slot::before { content: "Partner"; /* … */ }

/* …and drops its chrome once the extension mounts a creative. */
.adpal-slot[data-adpal-state="filled"] { border-color: transparent; background: none; }
.adpal-slot[data-adpal-state="filled"]::before { display: none; }
```

The extension sets `data-adpal-state="filled"` on the host the moment it renders, so the publisher can style the empty and filled states differently without ever changing the frame's height. Keep `min-height`/`height` fixed across both states and the unit's fade-in costs zero layout shift.

Any element carrying `[data-adpal-slot]` works too, so one page can declare several placements.

The extension then behaves exactly as on the demo page: a passive measurement window once the reader engages, and an automatic creative only if the server approves the offer.

Without `#adpal-slot`, the extension stays dormant — it does not create floating ads, overlays, or pop-ups. It also does not run on `chrome://` pages, the Chrome Web Store, or internal browser pages.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Popup shows **Offline** | The server is not running. Check `http://localhost:3000/api/health` (or `3001` if the banner said the port shifted). |
| Inspector says “no extension signal” | The extension is not loaded, or the tab was opened before reloading it. Load `extension/`, then reload the page. |
| Slot stays empty | No approved offer yet. Move the mouse and scroll; check the **Agent negotiation** stream for the failing check. |
| Offer withheld despite interacting | Stay on the tab, keep the window focused, and move the mouse **and** scroll during the 6-second window. |
| `429 RATE_LIMITED` | Only one request per second per client. |
| Payout button disabled | Threshold not reached: four approved impressions at €0.014 reach €0.05. |
| Port 3000 already in use | Nothing to do: the simulator falls back to 3001 and the extension finds it. |
| Page renders unstyled until **Ctrl + F5** | Should no longer happen: views are served `no-store` with `?v=<hash>` assets. Confirm the response headers with `curl -I http://localhost:3000/demo/style.css` — you should see `Cache-Control: no-store` and **no** `ETag`. |
| Styles correct but stale layout still shows | A `NODE_ENV=production` server is running. Restart without it for development. |
| `curl -I` shows `ETag` in development | An old `server.js` is still bound to the port: stop it and restart `npm start`. |
| Garbled console text on Windows | Use Windows Terminal or PowerShell 7; all files are UTF-8. |

Useful commands:

```bash
# Start from scratch without restarting the server
curl -X POST http://localhost:3000/api/dev/reset

# Inspect the negotiation stream
curl http://localhost:3000/api/telemetry?since=0

# Follow server decisions
# ([offer] and [payout] lines appear in the npm start terminal)
```

---

## Limitations and next steps

- **Simulator only**: no authentication, no TLS, no real payments, no persistence.
- The server listens on all network interfaces: keep it on a local machine and do not expose it publicly.
- **A single advertiser** and a single currency; creatives come from a local library and rotate deterministically.
- **Open heuristic**: good enough for a demo, not enough against real fraud.
- The telemetry feed (`/api/telemetry`, `/api/logs`, `/api/client-event`) is intended for the local demo terminal and is not authenticated.
- Possible next steps: SQLite or Postgres for accounts, server-signed offers, multiple publishers and advertisers, WebSockets for live balances, consent and retention policies, and integration with a real payment provider.

---

## License

MIT. Demo project — all brands, articles, and advertisements are fictional.
