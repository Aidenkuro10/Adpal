'use strict';

const path = require('path');

/*
 * Captured *before* dotenv runs. A PORT already in the environment came from
 * the hosting platform (Render, Fly and Railway all inject one), not from
 * `.env`; dotenv never overwrites an existing variable, so the platform's value
 * is what ends up in `config.port`. That value is the only port the platform
 * routes traffic to, so it must never be abandoned for "the next free one".
 */
const portFromPlatform = typeof process.env.PORT === 'string' && process.env.PORT.trim() !== '';

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function textFromEnv(name, fallback) {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

const paypalMode = textFromEnv('PAYPAL_MODE', 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
const paypalBusinessEmail = textFromEnv(
  'PAYPAL_BUSINESS_EMAIL',
  'sb-jokak53538300@business.example.com'
);

const userShare = clamp(numberFromEnv('USER_SHARE', 0.7), 0.1, 0.9);
const maxOfferPrice = Math.max(0.001, numberFromEnv('MAX_OFFER_PRICE', 0.05));

/*
 * Solana Devnet rail.
 *
 * The demo ledger is denominated in euros with four decimals, while Solana
 * amounts are integers. `unitsPerEuro` is the fixed bridge between the two:
 * one euro of attention is worth this many base units (lamports for SOL, or
 * token base units for an SPL mint). Keeping it an integer means every euro
 * amount maps to a whole number of base units, so the 70/30 split can be
 * computed exactly instead of accumulating float drift.
 *
 * 1e8 lamports = 0.1 SOL per euro, which is large enough to read on Explorer
 * and small enough that a single 1 SOL devnet airdrop funds hundreds of demo
 * payouts.
 */
const solanaMint = textFromEnv('SOLANA_MINT', '');
const solanaUnitsPerEuro = Math.max(
  1,
  Math.round(
    numberFromEnv('SOLANA_UNITS_PER_EUR', solanaMint ? 1_000_000 : 100_000_000)
  )
);
const defaultOfferPrice = clamp(
  numberFromEnv('DEFAULT_OFFER_PRICE', 0.05),
  0.001,
  maxOfferPrice
);

module.exports = Object.freeze({
  version: require('../package.json').version,
  // The simulator is a local demo: absent an explicit NODE_ENV it runs in
  // development mode, which serves assets `no-store` (see src/view-assets.js).
  isProduction: process.env.NODE_ENV === 'production',
  port: Math.round(clamp(numberFromEnv('PORT', 3000), 1, 65535)),
  // True when the port was injected by the platform, in which case it is not
  // negotiable: see startListening in server.js.
  portFromPlatform,
  // If the preferred port is taken, the simulator tries the next ones instead
  // of failing to start (useful when a stale process or another app holds it).
  portScanRange: Math.round(clamp(numberFromEnv('PORT_SCAN_RANGE', 10), 1, 100)),
  payoutThreshold: Math.max(0.001, numberFromEnv('PAYOUT_THRESHOLD', 0.05)),
  maxOfferPrice,
  defaultOfferPrice,
  userShare: Math.round(userShare * 1000) / 1000,
  publisherShare: Math.round((1 - userShare) * 1000) / 1000,
  advertiserBudget: Math.max(1, numberFromEnv('ADVERTISER_BUDGET', 50)),
  humanThreshold: Math.round(clamp(numberFromEnv('HUMAN_THRESHOLD', 50), 10, 90)),
  currency: 'EUR',
  demoDir: path.join(__dirname, '..', '..', 'demo-publisher'),

  /* ------------------------------------------------------------------ */
  /* Agent cognition (bid reasoning + attention explanation)            */
  /* ------------------------------------------------------------------ */
  agent: Object.freeze({
    // `local` runs the deterministic reasoner. `openai`, `anthropic` or
    // `gemini` send the same task to a hosted model and fall back to the local
    // reasoner on any failure. See src/agent-cognition.js.
    provider: textFromEnv('AGENT_PROVIDER', 'local').toLowerCase(),
    model: textFromEnv('AGENT_MODEL', ''),
    // Falls back to the provider-native env vars when AGENT_API_KEY is unset.
    apiKey: textFromEnv('AGENT_API_KEY', ''),
    baseUrl: textFromEnv('AGENT_BASE_URL', ''),
    enabled: textFromEnv('AGENT_ENABLED', 'true').toLowerCase() !== 'false',
    // Minimum relevance an advertiser needs before it will spend money.
    minRelevance: clamp(numberFromEnv('AGENT_MIN_RELEVANCE', 0.35), 0, 1),
    timeoutMs: Math.round(clamp(numberFromEnv('AGENT_TIMEOUT_MS', 6000), 1000, 30000)),
    maxTokens: Math.round(clamp(numberFromEnv('AGENT_MAX_TOKENS', 512), 64, 4096)),
    temperature: clamp(numberFromEnv('AGENT_TEMPERATURE', 0.4), 0, 1)
  }),

  /* ------------------------------------------------------------------ */
  /* L402 macaroons (agent negotiation)                                 */
  /* ------------------------------------------------------------------ */
  l402: Object.freeze({
    // Demo root key. Set L402_ROOT_KEY in .env to keep tokens valid across
    // restarts; otherwise every boot mints a fresh key.
    rootKey: textFromEnv('L402_ROOT_KEY', '') || `adpal-demo-${require('crypto').randomBytes(16).toString('hex')}`,
    ttlMs: Math.max(30_000, numberFromEnv('L402_TTL_MS', 5 * 60 * 1000))
  }),

  /* ------------------------------------------------------------------ */
  /* PayPal Payouts                                                     */
  /* ------------------------------------------------------------------ */
  paypal: Object.freeze({
    mode: paypalMode,
    clientId: textFromEnv('PAYPAL_CLIENT_ID', ''),
    clientSecret: textFromEnv('PAYPAL_CLIENT_SECRET', ''),
    apiBase:
      paypalMode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
    dashboardUrl:
      paypalMode === 'live'
        ? 'https://www.paypal.com/'
        : 'https://www.sandbox.paypal.com/',
    businessEmail: paypalBusinessEmail,
    // Where the reader share is sent. Defaults to the demo business account so
    // the sandbox flow works out of the box; set PAYPAL_RECEIVER_EMAIL to a
    // personal Sandbox account to see the money land in that wallet.
    receiverEmail: textFromEnv('PAYPAL_RECEIVER_EMAIL', paypalBusinessEmail),
    // Receiver of the publisher's 30% share in the same batch. Defaults to the
    // business account: a Payouts batch can send to more than one receiver, and
    // PayPal accepts its own account as an item, so the split is actually moved
    // instead of being left on the ledger.
    publisherEmail: textFromEnv('PAYPAL_PUBLISHER_EMAIL', paypalBusinessEmail),
    currency: textFromEnv('PAYPAL_CURRENCY', 'EUR').toUpperCase(),
    // Guard rail so a demo can never move a large amount of sandbox money.
    maxPayout: Math.max(0.01, numberFromEnv('PAYPAL_MAX_PAYOUT', 5)),
    timeoutMs: Math.round(clamp(numberFromEnv('PAYPAL_TIMEOUT_MS', 15000), 3000, 60000)),
    // L402-driven settlement: when attention proof settles an invoice and the
    // reader balance crosses the threshold, the protocol agent creates the
    // Payouts batch without a human pressing a button.
    autoPayout: textFromEnv('PAYPAL_AUTO_PAYOUT', 'true').toLowerCase() !== 'false',
    // Pause after a settle before the batch is created, so the terminal shows
    // the settlement and the payout as two distinct moments.
    autoPayoutDelayMs: Math.round(clamp(numberFromEnv('PAYPAL_AUTO_PAYOUT_DELAY_MS', 900), 0, 10000)),
    // Never create two batches back to back, even across rapid settlements.
    autoPayoutMinIntervalMs: Math.round(
      clamp(numberFromEnv('PAYPAL_AUTO_PAYOUT_MIN_INTERVAL_MS', 15000), 0, 600000)
    ),

    /*
     * Asynchronous webhook notifications.
     *
     * `id` is the webhook id PayPal assigns when you register
     * `POST /api/webhooks/paypal`. Signature verification is a round-trip to
     * PayPal's verify-webhook-signature API and needs that id; without it the
     * route still accepts events but labels them `unverified`, because refusing
     * every event would make the demo unusable out of the box.
     *
     * Set PAYPAL_WEBHOOK_STRICT=true to refuse unverified events instead. That
     * is the setting to use anywhere other than a sandbox demo.
     */
    webhook: Object.freeze({
      id: textFromEnv('PAYPAL_WEBHOOK_ID', ''),
      strict: textFromEnv('PAYPAL_WEBHOOK_STRICT', 'false').toLowerCase() === 'true',
      // Bounded replay guard: PayPal retries, and an unbounded Set is a leak.
      replayWindow: Math.round(clamp(numberFromEnv('PAYPAL_WEBHOOK_REPLAY_WINDOW', 500), 50, 5000))
    })
  }),

  /* ------------------------------------------------------------------ */
  /* Solana Devnet rail                                                 */
  /* ------------------------------------------------------------------ */
  solana: Object.freeze({
    enabled: textFromEnv('SOLANA_ENABLED', 'true').toLowerCase() !== 'false',
    cluster: textFromEnv('SOLANA_CLUSTER', 'devnet'),
    rpcUrl: textFromEnv('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
    // Currency label and base units. SOL uses 9 decimals; an SPL mint carries
    // its own decimals, so both are configurable.
    currency: textFromEnv('SOLANA_CURRENCY', 'SOL').toUpperCase(),
    mint: solanaMint,
    decimals: Math.round(clamp(numberFromEnv('SOLANA_DECIMALS', solanaMint ? 6 : 9), 0, 9)),
    unitsPerEuro: solanaUnitsPerEuro,
    // Treasury signs anchors and payouts. When unset, a keypair is generated
    // once and persisted to `keypairFile` so the devnet address stays stable.
    treasurySecret: textFromEnv('SOLANA_TREASURY_SECRET', ''),
    keypairFile: textFromEnv('SOLANA_KEYPAIR_FILE', path.join(__dirname, '..', '.solana-devnet-keys.json')),
    readerAddress: textFromEnv('SOLANA_READER_ADDRESS', ''),
    publisherAddress: textFromEnv('SOLANA_PUBLISHER_ADDRESS', ''),
    // Devnet faucet: a payout needs a funded treasury, and the demo should not
    // require a manual airdrop before it can run.
    airdrop: textFromEnv('SOLANA_AIRDROP', 'true').toLowerCase() !== 'false',
    airdropSol: Math.max(0.01, numberFromEnv('SOLANA_AIRDROP_SOL', 1)),
    anchorProofs: textFromEnv('SOLANA_ANCHOR_PROOFS', 'true').toLowerCase() !== 'false',
    anchorTimeoutMs: Math.round(clamp(numberFromEnv('SOLANA_ANCHOR_TIMEOUT_MS', 8000), 1000, 30000)),
    timeoutMs: Math.round(clamp(numberFromEnv('SOLANA_TIMEOUT_MS', 15000), 3000, 60000)),
    maxPayout: Math.max(0.01, numberFromEnv('SOLANA_MAX_PAYOUT', 5)),
    // If the devnet transfer cannot be confirmed, fall back to the PayPal rail
    // instead of losing the demo. Set to false to surface the failure only.
    fallbackToPaypal: textFromEnv('SOLANA_FALLBACK_TO_PAYPAL', 'true').toLowerCase() !== 'false',
    explorerBase: 'https://explorer.solana.com',
    memoProgram: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
  }),

  /*
   * Which rail `queueAutoPayout` uses when nobody names one:
   *   paypal_payouts  → the PayPal Sandbox batch (default)
   *   solana-devnet   → an on-chain 70/30 transfer on Solana Devnet
   * Both remain callable per request through `POST /api/payout { rail }`.
   */
  payoutRail: textFromEnv('PAYOUT_RAIL', 'paypal_payouts').toLowerCase()
});
