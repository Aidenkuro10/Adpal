# AdPal

**An open protocol where autonomous AI agents negotiate, verify, and settle the
price of human attention — 70% to the reader, 30% to the publisher, 0% to a platform.**

AdPal is not an ad network with a chatbot bolted on. It is a multi-agent
financial system: bidding agents representing brands reason about a page and
commit budget, a verification agent reads behavioural telemetry and writes the
justification for a payment, and a protocol agent moves money through PayPal or
Solana under an L402 payment contract.

Every step is observable. Every decision is explainable. No intermediary takes a cut.

---

## 1. Vision & Executive Summary

### The problem with advertising

Programmatic advertising routes roughly half of every dollar through
intermediaries, and it pays for *impressions served* rather than *attention
earned*. The reader — whose time is the actual inventory — is compensated with
nothing and pays for the transaction with personal data. The publisher is paid
late, in aggregate, on numbers they cannot audit.

### What AdPal changes

Attention becomes a priced, verifiable, machine-negotiated asset that settles
directly between the three parties who create the value.

| Party | Contribution | Share | Settlement |
| --- | --- | --- | --- |
| Reader | Verified human attention | **70%** | Personal PayPal account, or a Solana address |
| Publisher | The page and its editorial context | **30%** | Business PayPal account, or a Solana address |
| Platform | Routing and verification only | **0%** | No fee is deducted from the split |

The claim is mechanical, not rhetorical:

- The ledger stores **integer micro-units** of the active currency and computes
  `reader = round(gross × 0.70)`, `publisher = gross − reader`, so
  `reader + publisher === gross` cannot fail.
- A settlement publishes `accounting.readerConserved` and
  `accounting.publisherConserved`; both must hold against accrued, paid,
  reversed and remaining balances.
- When a leg cannot be paid exactly in cents or lamports, the remainder is
  **carried and reported** (`reconciliation.carried`), never rebalanced out of
  the other party's share.

### Why agents, and not a smarter form of targeting

A conventional ad server decides placement from a static rules table. AdPal
delegates the decision to agents with separate mandates, separate budgets, and
separate authorities — because the interesting question in the protocol is not
"which ad fits this page", but "who is allowed to move money, and on what
evidence". The agent layer answers that question in the open: a bid is scored, a
session is judged, a batch is authorised, and each of those appears on the
terminal as a signed-off decision with numbers attached.

---

## 2. The AI & Agentic Layer

Three agent roles cooperate. They never share a mandate, and none of them holds
unbounded authority over money.

| Agent | Mandate | Implementation | Authority |
| --- | --- | --- | --- |
| Advertiser bidding agents | Is this page worth my budget, and at what price | `server/src/agent-cognition.js` | Can bid or decline; cannot settle |
| Attention verification agent | Is this a human reading, and why | `server/src/agent-cognition.js` | Explains a verdict; the heuristic decides |
| Protocol agent | Route a settled invoice to a rail | `server/src/paypal-agent-toolkit.js` | Executes an already-authorised split |

### 2.1 Advertiser bidding agents

Each brand is represented by a named autonomous buyer with its own campaign
budget, objective, and markets — Northbound Coffee (`agt_northbound_01`,
reader-acquisition, USD 18.00), Lumen Audio (`agt_lumen_02`, consideration, USD
14.00), Terrace Greens, Halden Optics, Field Notes Press. The roster lives in
`server/src/creatives.js`, and the terminal prints the agent identity beside the
creative so a judge can match an ad to the agent that paid for it.

When a page is offered, every eligible agent is scored independently:

```
relevance = 0.25 + audienceFit × 0.30 + topicFit × 0.35 + novelty
decide    = affordable && relevance >= AGENT_MIN_RELEVANCE   (default 0.35)
```

- `audienceFit` maps the page's classified type (editorial, commerce, general)
  onto the agent's campaign objective.
- `topicFit` rewards exact vocabulary overlap and, at 0.6 weight, **category
  adjacency** from a small concept graph — so a page titled "The Courier" reads
  as publishing inventory to a stationery brand even though no word matches.
- `novelty` nudges an advertiser that has never appeared on this slot.

The scoring is deterministic and auditable by design. Optionally the same task
is delegated to a hosted model:

| `AGENT_PROVIDER` | Model (default) | Behaviour |
| --- | --- | --- |
| `local` | `adpal-reasoner-v1` | Deterministic feature extraction, weighted scoring, prose synthesis |
| `openai` | `gpt-4o-mini` | Same task sent to the API, JSON reply parsed |
| `anthropic` | `claude-3-5-haiku-latest` | As above |
| `gemini` | `gemini-1.5-flash` | As above |

Even the local reasoner is a real reasoning step: every figure in its rationale
is derived from the page context and the bid, never pre-written. It is
nonetheless not a neural network, and its capability profile says so at
`/api/agents` so nobody mistakes it for one.

Failure semantics are strict, because a demo that lies about its own state is
worse than a demo that admits a failure. A missing key, timeout, 4xx, or
malformed JSON degrades to the local reasoner and reports `fallback: true` with
the provider and the reason. Token counts come from the API `usage` for hosted
models and are flagged `estimated` when derived. Latency is measured, not claimed.

The most important behaviour is the one a rules engine cannot produce: when every
agent declines, **the impression is withheld**. No advertiser cleared the floor,
so nobody is shown an ad. Refusing to sell is the product working.

### 2.2 Attention verification and reasoning agent

The client reduces behaviour to counters — dwell, pointer velocity and direction
reversals, scroll depth, tab visibility, viewport occupancy — and sends no
keystrokes, no coordinates, no cross-site identifier, no fingerprint.

`server/src/heuristic.js` scores those counters across eight guard rails:
automation flag, session length, interaction, tab visibility, ad in viewport,
movement density, timestamp integrity, scroll pattern. The result is a 0-100
score compared against `HUMAN_THRESHOLD` (default 50).

The agent then reads the *same* evidence and produces a written assessment: a
behavioural signature, a confidence value, and a rationale describing reading
cadence, pointer dynamics and viewport discipline. It runs on refused sessions
too, so a rejected reader is told why rather than handed a bare score.

The authority boundary is deliberate and is the central design decision of the
AI layer:

> **The model explains attention. It never approves it.**

`heuristic.js` holds the money decision; the agent's verdict is recorded
alongside it, and a disagreement between the two is surfaced explicitly rather
than resolved in the model's favour. A persuasive or hallucinated narrative
cannot pay anyone.

### 2.3 Protocol agent and the PayPal AI Toolkit (v1.2.0)

`AI-Toolkit-main/` is the official PayPal AI Toolkit checkout. AdPal reads it at
boot and re-exposes its capabilities as callable agent tools with real JSON
schemas in `server/src/paypal-agent-toolkit.js`.

The toolkit declares its own MCP server, which AdPal reports verbatim at
`/api/toolkit`:

```json
{
  "mcpServers": {
    "paypal-sandbox": {
      "type": "sse",
      "url": "https://mcp.sandbox.paypal.com/sse",
      "headers": { "Authorization": "Bearer ${PAYPAL_SANDBOX_ACCESS_TOKEN}" }
    }
  }
}
```

Only the header *name* is ever echoed; the substituted token is never returned by
any endpoint. The server also reads the toolkit's
`skills/paypal-best-practices/references/payouts.md` and reports it as the
governing reference for the rail it implements, so the integration is traceable
to the vendor's own guidance instead of to guesswork.

**Agent tool surface** (`/api/toolkit` returns the live inventory):

| Tool | Agent | Contract |
| --- | --- | --- |
| `advertiser_authorize_spend` | Advertiser | Authorise an impression against remaining campaign budget. Returns `CAMPAIGN_BUDGET_EXHAUSTED` rather than overdrawing |
| `protocol_split_invoice` | Protocol | Split a settled invoice into reader and publisher cents, report drift and `withinTolerance` |
| `paypal_create_payout` | Protocol | Create a Payouts batch, one item per receiver with its own `sender_item_id` for idempotency |
| `paypal_get_payout` | Protocol | Re-read a batch so a `PENDING` settlement can be refreshed to final status |
| `paypal_get_token` | Protocol | Cached OAuth2 client-credentials token for the configured environment |

Tools are dispatched through a single `callTool(name, args)` entry point, with
bounded retry on HTTP 429. Each agent-level invocation — spend authorisation,
split routing, payout creation — emits an `agent.advertiser`, `agent.protocol`
or `agent.reasoning` event carrying the tool name, its inputs and its result, so
the agentic layer is inspectable while it runs, not just afterwards.

### 2.4 The agent pipeline

```
 1. A page is offered with its title, host and slot
        |
        v
 +----------------------+     +------------------------+     +----------------------+
 | ADVERTISER AGENTS    |     | ATTENTION AGENT        |     | PROTOCOL AGENT       |
 | agent-cognition.js   |     | agent-cognition.js     |     | paypal-agent-toolkit |
 |                      |     |                        |     |                      |
 | score 5 advertisers  |     | 8 guard rails          |     | authorize_spend      |
 | relevance + budget   |     | 0-100 score            |     | split_invoice        |
 | bid or decline       |     | narrative + confidence |     | create_payout        |
 +----------------------+     +------------------------+     +----------------------+
        |                             |                             |
        | winner funds the price      | verdict + rationale         | executes the split
        v                             v                             v
   creative shown               L402 bearer issued          PayPal batch | Solana tx
        |                             |                             |
        +=========== SSE: agent.bid | agent.reasoning | agent.attention ==========+
                    agent.advertiser | agent.protocol
```

Terminal event stages, in the order a settlement produces them:
`agent.bid`, `agent.reasoning`, `agent.attention`, `agent.advertiser`,
`agent.protocol`.

---

## 3. Complete Technology Stack

| Layer | Technology | Role in AdPal |
| --- | --- | --- |
| Payments (fiat) | PayPal REST Payouts API | One batch, two items, `PayPal-Request-Id` for idempotent retry |
| Payments (agent) | PayPal AI Toolkit v1.2.0, MCP over SSE | Tool contracts, agent spend authorisation, payouts reference |
| Payments (on-chain) | Solana Devnet, `@solana/web3.js`, `@solana/spl-token` | Atomic two-leg transfer plus memo proof, best-effort anchoring |
| Protocol | L402 (HTTP 402 + Macaroons) | Paid-resource negotiation, chained-HMAC caveats, single-use contexts |
| Cryptography | HMAC-SHA256, `crypto.timingSafeEqual` | Caveat chaining and constant-time macaroon verification |
| Reasoning | OpenAI, Anthropic, Gemini, or local reasoner | Bid scoring and attention narrative, with mandatory fallback |
| Backend | Node.js 18+, Express | HTTP surface, payout orchestration, webhook ingestion |
| Telemetry | Server-Sent Events | `/api/logs` live stream; `/api/telemetry?since=` pollable feed |
| Web client | Vanilla JS publication agent | Reads a page without any install, no PII |
| Extension | Chrome Manifest V3 | Optional same-protocol client with browser UI |
| Deployment | Render (`RENDER_EXTERNAL_URL`, `$PORT`) | Public base URL and port are read from the platform |
| API tooling | OpenAPI 3.0, Postman collection, APIMatic validator | `scripts/apimatic-validate.js` enforces import constraints on the spec |

### Settlement rails in detail

**PayPal REST Payouts.** `POST /v1/payments/payouts` creates one batch containing
both legs, each with a distinct `sender_item_id`, and a `PayPal-Request-Id`
derived from our reference so a retry is idempotent on PayPal's side. OAuth
tokens are cached and refreshed once on a 401; a rejected credential set is
cached too, so a webhook retry storm cannot hammer the token endpoint.

Webhooks (`PAYMENT.PAYOUTS-ITEM.*`) are verified with
`POST /v1/notifications/verify-webhook-signature` against the **raw request
bytes**, then reconciled by `server/src/webhook-reconciler.js`. A delivery that
arrives before our create-response is held and replayed when the payout commits;
a terminal failure reverses the payout exactly once, restoring the precise
per-publisher debits that were taken. `UNCLAIMED` and `ONHOLD` set status without
reversing, because the item can still settle.

**Solana Devnet.** The same 70/30 split executes as two transfers in a single
atomic transaction, with a memo committing to the L402 `sha256(preimage)` — the
32 bytes in the macaroon and the 32 bytes on-chain are identical. Settlement is
all-or-nothing. Anchoring is best-effort: an unfunded devnet treasury degrades
the receipt to `anchored: false` rather than failing a settlement that verified
attention already justified.

---

## 4. System Architecture & the 70/30 Flow

```
              Advertiser agent budget (campaign escrow)
                            |
                            |  bid, capped by MAX_OFFER_PRICE
                            v
   +--------------------------------------------------------+
   |                    AdPal Protocol                      |
   |                                                        |
   |   L402 challenge              AI attention engine      |
   |   402 Payment Required        8 guard rails + agent    |
   |   payment_context_token       0-100 score + narrative  |
   |          |                          |                  |
   |          +--- verified human -------+                  |
   |              attention proof                           |
   |                                                        |
   |   ledger: integer micro-units, 1:1 invariants          |
   +--------------------------------------------------------+
                |                            |
          70%   v                      30%   v
    Reader (personal)              Publisher (business)
    attention reward               content reward
                \                            /
                 +---- one atomic settlement --+
                      (PayPal batch | Solana tx)
```

No step in that path holds a commission. The rail moves the two legs the ledger
already recorded.

### Three distinct PayPal Sandbox accounts

A Payouts batch cannot pay the account whose credentials created it: PayPal
answers `SELF_PAY_NOT_ALLOWED` and **rejects the entire batch** — so one bad
publisher address can cancel the reader's payment too. AdPal therefore models
three roles explicitly and refuses the conflict before reserving any money.

| Role | Config | Rule |
| --- | --- | --- |
| Advertiser / payer | `PAYPAL_BUSINESS_EMAIL`, `PAYPAL_CLIENT_ID` | Owns the REST credentials. Never a payout receiver |
| Reader / personal | `PAYPAL_RECEIVER_EMAIL` | Must be a *different* account, or the payout is refused with `409` before any reservation |
| Publisher / business | `PAYPAL_PUBLISHER_EMAIL` | A third, distinct account. Empty, equal to the reader, or equal to the payer means the 30% stays accrued on the ledger |

`server/src/payout-recipients.js` is the single decision point used by every call
path. It treats `PAYPAL_SENDER_ALIASES` as the payer, because PayPal matches by
account rather than by string; and if PayPal still refuses an alias the process
was never told about, the reservation is re-planned without the publisher leg and
retried once — reader paid, nothing reversed.

### Money invariants

- A reservation is created only after every recipient check passes, and is
  committed only when the rail accepts the transfer. A reservation that is never
  accepted is cancelled, so a mid-request network failure leaves balances intact.
- `preparePayout` and `commitPayout` are the only two places money can move.
- A payout failed by webhook is reversed exactly once, from the recorded
  per-publisher debits rather than an aggregate.
- `UNCLAIMED` and `ONHOLD` never reverse: reversing early would pay the same
  share twice.

---

## 5. Quick Start & Local Setup

Requires Node.js 18+.

```bash
cd server
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Open **http://localhost:3000/demo/** and read for a few seconds. Then open
**http://localhost:3000/terminal/** beside it: the bid reasoning, the attention
narrative, the 70/30 split and the payout batch appear as they happen.

The shipped baseline prices one impression at **$1.00**, so every approved
settlement moves **$0.70 to the reader and $0.30 to the publisher** — enough for
Sandbox balances to change visibly on a single impression, and both legs are
whole cents, so nothing is held back as rounding.

| Surface | Purpose |
| --- | --- |
| `/demo/` | The publication. Editorial, no debug chrome, no telemetry panel |
| `/terminal/` | The agent console. Live reasoning, scores, ledger, batches, webhooks |
| `/api/agents` | Advertiser roster, budgets, cognition profile, rail readiness |
| `/api/toolkit` | Detected toolkit version, MCP endpoint, callable tool names |
| `/api/balance` | Ledger snapshot with the accounting invariants |
| `/api/logs` | SSE stream of every event the terminal renders |

Without PayPal credentials the simulator still runs, and says so: the balance
panel reports `configured: false` and payouts stop with an explicit reason
instead of pretending to have moved money. Add `PAYPAL_CLIENT_ID` and
`PAYPAL_CLIENT_SECRET` from the PayPal developer dashboard to execute real
Sandbox batches.

```bash
# environment consistency: credentials, API host and webhook id
npm run check:paypal-env

# offline invariants (no network)
npm run check:accounting      # 1:1 ledger and carry handling
npm run check:webhooks        # hold-and-replay reconciliation
npm run check:self-pay        # recipient planning, self-payment refusal

# against a running server
npm run check                 # health, rails, telemetry
npm run check:webhooks:signature
npm run check:webhooks:e2e
npm run check:stream          # SSE latency
```

`adpal.openapi.json` and `adpal.postman_collection.json` describe the HTTP
surface; `node scripts/apimatic-validate.js` checks that the spec still satisfies
APIMatic import constraints. `client/inspect.js` is a dependency-free L402 CLI
for negotiating a paid resource from a shell.

---

## 6. Key Environment Variables

`server/.env.example` is the annotated reference. These change behaviour
materially.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. The platform's `$PORT` wins when injected |
| `PUBLIC_BASE_URL` | `RENDER_EXTERNAL_URL` | Base URL embedded in the 402 contract and webhook checks |
| `USER_SHARE` | `0.7` | Reader share. Publisher share is `1 − USER_SHARE` |
| `CURRENCY` | `USD` | Application currency (ISO 4217). Read by `/api/health`, the L402 contract, the payout payload and every UI glyph |
| `PAYOUT_THRESHOLD` | `0.05` | Minimum reader balance for a payout. `server/.env.example` ships `0.005`, so the first $0.70 credit settles immediately |
| `MAX_OFFER_PRICE` | `1.00` | Hard ceiling on a single impression bid. Must be `>= DEFAULT_OFFER_PRICE` |
| `DEFAULT_OFFER_PRICE` | `1.00` | Unit price of one impression: $0.70 to the reader, $0.30 to the publisher |
| `HUMAN_THRESHOLD` | `50` | Minimum attention score for approval |
| `PRESENCE_TTL_MS` | `12000` | How long a reader session stays live without a heartbeat |
| `PAYOUT_RAIL` | `paypal_payouts` | `paypal_payouts` or `solana-devnet` |
| `AGENT_PROVIDER` | `local` | `local`, `openai`, `anthropic` or `gemini` |
| `AGENT_MODEL` | provider default | Override the model named in the table above |
| `AGENT_MIN_RELEVANCE` | `0.35` | Relevance floor below which an agent declines |
| `AGENT_TIMEOUT_MS` | `6000` | Hosted-model timeout before falling back to local |
| `AGENT_ENABLED` | `true` | `false` forces the deterministic reasoner everywhere |
| `PAYPAL_MODE` | `sandbox` | `sandbox` or `live`. Sandbox is enforced |
| `PAYPAL_ALLOW_LIVE` | `false` | Required to leave Sandbox; prevents a half-flipped environment |
| `PAYPAL_CLIENT_ID` | — | REST app client id (the payer) |
| `PAYPAL_CLIENT_SECRET` | — | REST app secret, server-side only |
| `PAYPAL_BUSINESS_EMAIL` | Sandbox business account | The payer. Must not appear as a receiver |
| `PAYPAL_SENDER_ALIASES` | *(empty)* | Other confirmed emails on the payer account, comma-separated |
| `PAYPAL_RECEIVER_EMAIL` | payer email | Reader recipient. Must be a different account |
| `PAYPAL_PUBLISHER_EMAIL` | *(empty)* | Publisher recipient. Empty means the 30% stays accrued |
| `PAYPAL_CURRENCY` | `$CURRENCY` (`USD`) | ISO code sent in the batch payload. Should match `CURRENCY` |
| `PAYPAL_WEBHOOK_ID` | *(empty)* | Enables signature verification of payout webhooks |
| `PAYPAL_WEBHOOK_STRICT` | `false` | `true` refuses unverified webhooks with `503` |
| `SOLANA_ENABLED` | `true` | Enable the Devnet rail |
| `SOLANA_UNITS_PER_FIAT` | `100000000` | Base units per whole currency unit: `1e8` lamports = 0.1 SOL per $1.00. `SOLANA_UNITS_PER_EUR` is still honoured |
| `SOLANA_ANCHOR_PROOFS` | `true` | Anchor `sha256(preimage)` on-chain when an invoice settles |
| `L402_TTL_MS` | `300000` | Payment-context lifetime before it expires |

Two details prevent the most common misconfiguration. `PAYPAL_ALLOW_LIVE` gates
the mode switch because that one variable also moves the API host and the
certificate host. At boot the server prints mode, API base and webhook id on one
line, then reads the registered webhook and warns if its callback URL no longer
points at this deployment.

---

## 7. L402 API & Agent Tools Surface

The protocol is mounted twice — `/api/l402/*` (advertised inside the contract) and
`/l402/*` (protocol-native) — resolving to the same handlers. The browser path is
separate by design: `/demo/` is never content-sniffed into a `402`, which removes
a class of misdetection bugs and keeps the contract stable for agents.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/l402/offer` | Without a bearer token: `402` with the contract. With one: the paid resource |
| `POST` | `/api/l402/challenge` | Issue a fresh contract for an offer |
| `POST` | `/api/l402/settle` | Submit attention proof (and optional Solana proof); returns a macaroon |
| `POST` | `/api/l402/solana/confirm` | Verify an on-chain transaction against the invoice's payment hash |
| `GET` | `/api/l402/receipt/:token` | The negotiation receipt for a context token |
| `GET` | `/api/l402/sessions` | Live contexts, offer catalogue and aggregate stats |

### The negotiation cycle

```
1. GET /api/l402/offer
     402 Payment Required
     { protocol, version, payment_request_url, payment_context_token,
       offers: [...], payment_request: { required_fields, signals_schema } }

2. POST /api/l402/settle
     { payment_context_token, offer_id, attention: { signals }, solana_signature? }
     402 ATTENTION_NOT_VERIFIED   -> score below HUMAN_THRESHOLD, context still valid
     200  { bearer_token, receipt, solana, proof, balance }

3. GET /api/l402/offer
     Authorization: Bearer <macaroon>
     200  { resource, grant, impression, balance }
```

The contract publishes its own required fields and signal schema, so an agent can
negotiate with no out-of-band documentation. A refused settlement does not burn
the context, so the same token can be retried once the reader genuinely engages;
a successful one consumes it.

### Credential model

The payment credential is a macaroon, not a session cookie. Each caveat — offer
id, publisher, authorised price, expiry — is appended to the signature with a
chained HMAC-SHA256:

```
signature = HMAC(root, identifier)
signature = HMAC(root, signature || caveat_1)
signature = HMAC(root, signature || caveat_2)  ...
```

Editing or reordering any caveat invalidates the token, verification is
constant-time, and the payment context is additionally tracked through an
explicit state machine (`issued -> settled -> consumed`, or `expired`/`failed`)
so every negotiation is inspectable and idempotent on retry.

### What one settlement returns

```json
{
  "protocol": "L402",
  "bearer_token": "<macaroon>",
  "resource_url": "http://localhost:3000/api/l402/offer",
  "receipt": {
    "reference": "l402_9f3c1a2b",
    "amount": 1,
    "currency": "USD",
    "score": 99,
    "verdict": "human",
    "split": { "user": 0.7, "publisher": 0.3 }
  },
  "solana": {
    "anchorSignature": "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ...",
    "anchorExplorerUrl": "https://explorer.solana.com/tx/...?cluster=devnet"
  },
  "proof": { "threshold": 50, "checks": ["..."] },
  "balance": { "reader": { "balance": 0 } }
}
```

Settlement and transfer are two distinct events on purpose: `/api/l402/settle`
returns as soon as the payment is proven, and the batch or transaction identifier
appears on the same tick in the SSE stream and in `/api/balance`.

---

## Project layout

```
server/
  server.js                  HTTP surface, payout orchestration, webhook route
  src/
    config.js                Environment parsing; the two PayPal hosts
    heuristic.js             0-100 attention score and the eight guard rails
    agent-cognition.js       Advertiser bidding agents and attention narrative
    paypal-agent-toolkit.js  MCP-shaped agent tools over the official toolkit
    l402.js                  HMAC-chained macaroon issue and verification
    l402-contract.js         402 envelope and payment-context state machine
    ledger.js                Integer micro-unit accounts, split, reversals
    payout-recipients.js     Recipient planning; refuses self-payment
    paypal.js                OAuth2, Payouts, webhook signature verification
    webhook-reconciler.js    Hold-and-replay event matching
    solana.js                Devnet transfers, proof verification, anchoring
    presence.js              Live reader sessions; the impression gate
    rotation.js              Per-slot advertiser rotation
    creatives.js             Brand agent roster, campaign budgets, creatives
    telemetry.js             Event bus behind the SSE stream
demo-publisher/              The publication served at /demo/
  adpal-agent.js             Page-side attention agent (no extension required)
  terminal/                  The control room served at /terminal/
extension/                   Optional Manifest V3 client: same protocol, browser UI
AI-Toolkit-main/             Official PayPal AI Toolkit checkout (v1.2.0)
client/inspect.js            Standalone L402 inspection CLI
scripts/apimatic-validate.js OpenAPI import validation with live probes
```

---

**AdPal pays the people who make attention worth buying — and it lets autonomous
agents prove, price and settle that attention in the open.** The protocol is the
product: open, measurable, and settled directly between advertiser, reader and
publisher.
