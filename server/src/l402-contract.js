'use strict';

/**
 * L402 offer contract and payment-context store.
 *
 * Modelled on CrawlerPal's FastAPI server (`server/main.py`): an
 * unauthenticated programmatic request receives
 *
 *   HTTP/1.1 402 Payment Required
 *   {
 *     "version": "1.0.0",
 *     "protocol": "L402",
 *     "payment_request_url": "...",
 *     "payment_context_token": "<uuid>",
 *     "offers": [ ... ]
 *   }
 *
 * then POSTs to `payment_request_url` with that context token and receives a
 * bearer token it can present on the same URL to read the paid resource.
 *
 * AdPal keeps the exact envelope and adds the part CrawlerPal leaves implicit:
 * the context token is tracked through an explicit state machine
 * (issued → settled → consumed, or expired/failed), so the negotiation is
 * inspectable at every step and idempotent on retry.
 *
 * One deliberate difference: CrawlerPal decides between HTML and 402 by
 * sniffing the User-Agent. AdPal does not sniff — the browser path is a
 * different URL (/demo/) from the programmatic path (/api/l402/offer). That
 * removes a whole class of misdetection bugs and makes the 402 contract
 * stable for agents.
 */

const { randomUUID } = require('crypto');

const config = require('./config');

const PROTOCOL = 'L402';
const VERSION = '1.0.0';

/** Context tokens are single-use challenges; five minutes is plenty. */
const DEFAULT_CONTEXT_TTL_MS = 5 * 60 * 1000;
const MAX_CONTEXTS = 500;

const STATES = Object.freeze({
  ISSUED: 'issued',
  SETTLED: 'settled',
  CONSUMED: 'consumed',
  EXPIRED: 'expired',
  FAILED: 'failed'
});

/**
 * The offer catalog advertised inside the 402 contract.
 *
 * `attention_impression_v1` is the one-shot offer the extension negotiates;
 * `attention_session_v1` mirrors CrawlerPal's subscription offer so the
 * `offers` array is genuinely a choice rather than a single hardcoded entry.
 */
const OFFERS = Object.freeze([
  Object.freeze({
    id: 'attention_impression_v1',
    title: 'Human Attention Verification',
    description: '70% reader split / 30% publisher split upon human attention proof',
    // Same price the extension requests: one advertiser bid drives both paths.
    amount: config.defaultOfferPrice,
    currency: 'EUR',
    payment_methods: Object.freeze(['paypal_payouts'])
  }),
  Object.freeze({
    id: 'attention_session_v1',
    title: 'Verified Reading Session',
    description: 'Up to 12 verified impressions during one hour of reading, same 70/30 split',
    amount: 0.05,
    currency: 'EUR',
    type: 'session',
    duration: '1 hour',
    max_impressions: 12,
    payment_methods: Object.freeze(['paypal_payouts'])
  })
]);

const DEFAULT_OFFER_ID = 'attention_impression_v1';

/** Offer as it appears inside the contract (frozen catalog → plain JSON). */
function offerPayload(offer) {
  const payload = {
    id: offer.id,
    title: offer.title,
    description: offer.description,
    amount: offer.amount,
    currency: offer.currency
  };

  if (offer.type) payload.type = offer.type;
  if (offer.duration) payload.duration = offer.duration;
  if (offer.max_impressions) payload.max_impressions = offer.max_impressions;

  payload.payment_methods = [...offer.payment_methods];
  return payload;
}

function findOffer(offerId) {
  const id = String(offerId || '').trim();
  if (!id) return OFFERS.find((offer) => offer.id === DEFAULT_OFFER_ID) || null;
  return OFFERS.find((offer) => offer.id === id) || null;
}

/**
 * Payment contexts, in memory. A restart drops every challenge, which is the
 * correct behaviour for a five-minute negotiation token.
 */
class L402Contexts {
  constructor({ ttlMs = DEFAULT_CONTEXT_TTL_MS, limit = MAX_CONTEXTS } = {}) {
    this.ttlMs = Math.max(10_000, Number(ttlMs) || DEFAULT_CONTEXT_TTL_MS);
    this.limit = Math.max(10, Number(limit) || MAX_CONTEXTS);
    /** @type {Map<string, object>} */
    this.store = new Map();
  }

  /**
   * Creates a fresh context and returns it with the contract that should be
   * sent with the 402 response.
   *
   * @param {{
   *   offerId?: string,
   *   paymentRequestUrl: string,
   *   client?: string,
   *   publisher?: string,
   *   pageTitle?: string,
   *   pageHost?: string
   * }} input
   */
  create(input = {}) {
    const offer = findOffer(input.offerId);
    if (!offer) {
      const error = new Error(`Unknown offer_id: ${input.offerId}`);
      error.code = 'UNKNOWN_OFFER';
      throw error;
    }

    const now = Date.now();
    const context = {
      payment_context_token: randomUUID(),
      protocol: PROTOCOL,
      version: VERSION,
      offer_id: offer.id,
      amount: offer.amount,
      currency: offer.currency,
      payment_request_url: input.paymentRequestUrl,
      state: STATES.ISSUED,
      attempts: 0,
      reads: 0,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      settledAt: null,
      consumedAt: null,
      lastSeenAt: now,
      client: String(input.client || '').slice(0, 40),
      publisher: String(input.publisher || 'localhost').slice(0, 80),
      pageTitle: String(input.pageTitle || 'The Attention Revolution').slice(0, 120),
      pageHost: String(input.pageHost || 'localhost').slice(0, 120),
      bearer_token: '',
      macaroon: null,
      receipt: null,
      proof: null,
      lastError: null
    };

    this.store.set(context.payment_context_token, context);
    this.#trim();
    return context;
  }

  /** Returns a live context, expiring it lazily on access. */
  get(token) {
    const key = String(token || '').trim();
    if (!key) return null;

    const context = this.store.get(key);
    if (!context) return null;

    if (this.#expireIfStale(context)) return context;

    context.lastSeenAt = Date.now();
    return context;
  }

  /**
   * Records a failed settlement attempt.
   *
   * The context is deliberately *not* burned: a low attention score is a
   * retryable condition (the reader may simply not have interacted yet), so
   * the same context token stays valid until its own expiry.
   */
  recordFailure(context, code, message, details = {}) {
    if (!context) return null;
    context.attempts += 1;
    context.lastError = { code, message, at: new Date().toISOString(), ...details };
    this.store.set(context.payment_context_token, context);
    return context;
  }

  /**
   * Moves a context to `settled` and attaches the macaroon + ledger receipt.
   * Idempotent: calling it twice keeps the first result.
   */
  settle(context, { bearerToken, macaroon, receipt, proof }) {
    if (!context) return null;
    if (context.state === STATES.SETTLED || context.state === STATES.CONSUMED) return context;

    context.state = STATES.SETTLED;
    context.settledAt = Date.now();
    context.bearer_token = bearerToken || '';
    context.macaroon = macaroon || null;
    context.receipt = receipt || null;
    context.proof = proof || null;
    context.lastError = null;
    this.store.set(context.payment_context_token, context);
    return context;
  }

  /**
   * Attaches a verified Solana proof (or its anchor) to a context.
   *
   * Kept separate from `settle` because an on-chain proof can be presented both
   * before settlement and afterwards (a payment confirmed late), and neither
   * should overwrite the attention proof that authorised the invoice.
   */
  attachSolanaProof(context, proof = {}) {
    if (!context) return null;
    context.proof = {
      ...(context.proof || {}),
      solana: { ...(context.proof?.solana || {}), ...proof }
    };
    this.store.set(context.payment_context_token, context);
    return context;
  }

  /** Marks the paid resource as read; repeated reads are allowed until expiry. */
  markConsumed(context) {
    if (!context) return null;
    context.reads += 1;
    if (context.state === STATES.SETTLED) {
      context.state = STATES.CONSUMED;
      context.consumedAt = Date.now();
    }
    this.store.set(context.payment_context_token, context);
    return context;
  }

  /** Finds a context by the payment hash carried in a macaroon identifier. */
  findByPaymentHash(paymentHash) {
    const hash = String(paymentHash || '').trim();
    if (!hash) return null;

    for (const context of this.store.values()) {
      if (context.challenge?.paymentHash === hash) {
        this.#expireIfStale(context);
        return context;
      }
    }
    return null;
  }

  /** Public, sanitised view for CLI output and the terminal rail. */
  view(context, { includeToken = true } = {}) {
    if (!context) return null;
    this.#expireIfStale(context);

    return {
      payment_context_token: includeToken ? context.payment_context_token : `${context.payment_context_token.slice(0, 8)}…`,
      protocol: context.protocol,
      version: context.version,
      offer_id: context.offer_id,
      amount: context.amount,
      currency: context.currency,
      state: context.state,
      attempts: context.attempts,
      reads: context.reads,
      createdAt: new Date(context.createdAt).toISOString(),
      expiresAt: new Date(context.expiresAt).toISOString(),
      settledAt: context.settledAt ? new Date(context.settledAt).toISOString() : null,
      consumedAt: context.consumedAt ? new Date(context.consumedAt).toISOString() : null,
      macaroon: context.macaroon,
      receipt: context.receipt,
      proof: context.proof,
      lastError: context.lastError
    };
  }

  /** Most recent contexts, newest first. */
  snapshot(limit = 20) {
    const contexts = [...this.store.values()].sort((a, b) => b.createdAt - a.createdAt);
    return contexts.slice(0, Math.max(1, Math.min(limit, 100))).map((context) => this.view(context));
  }

  stats() {
    const counts = {};
    for (const context of this.store.values()) {
      this.#expireIfStale(context);
      counts[context.state] = (counts[context.state] || 0) + 1;
    }
    return { contexts: this.store.size, states: counts, ttlMs: this.ttlMs };
  }

  clear() {
    this.store.clear();
  }

  #expireIfStale(context) {
    if (context.state === STATES.EXPIRED) return true;
    if (Date.now() <= context.expiresAt) return false;

    // A settled token has its own macaroon expiry; only unspent challenges
    // become hard-expired.
    if (context.state === STATES.ISSUED || context.state === STATES.FAILED) {
      context.state = STATES.EXPIRED;
    }
    return true;
  }

  #trim() {
    if (this.store.size <= this.limit) return;
    const oldest = [...this.store.values()].sort((a, b) => a.createdAt - b.createdAt);
    const excess = this.store.size - this.limit;
    for (let index = 0; index < excess; index += 1) {
      this.store.delete(oldest[index].payment_context_token);
    }
  }
}

/** The signal shape the settle endpoint accepts, documented inline. */
const SIGNAL_SCHEMA = Object.freeze({
  durationMs: 'integer — measured session length in ms (min 2500)',
  pageDwellMs: 'integer — time on page in ms',
  mouseMoves: 'integer — pointer movements',
  directionChanges: 'integer — pointer direction reversals',
  scrollEvents: 'integer — scroll events fired',
  scrollDepth: 'number 0..1 — furthest scroll depth reached',
  clicks: 'integer',
  keyPresses: 'integer',
  visibleRatio: 'number 0..1 — fraction of the session with the tab visible',
  focusRatio: 'number 0..1 — fraction of the session with window focus',
  slotVisibleRatio: 'number 0..1 or null — fraction of the session with the slot in view',
  webdriver: 'boolean — must be false',
  clientSentAt: 'epoch ms — client clock'
});

/**
 * Builds the exact 402 body.
 *
 * When the caller did not choose an offer, the whole catalog is advertised so
 * an agent can decide without a second round trip (`offers` is a real choice,
 * as in CrawlerPal). When it did choose, only that offer is echoed back.
 *
 * @param {{
 *   context: object,
 *   offerId?: string,
 *   baseUrl: string
 * }} input
 */
function buildContract({ context, offerId, baseUrl }) {
  const catalog = offerId ? [findOffer(offerId)].filter(Boolean) : OFFERS.map(offerPayload);
  const selected = catalog[0] || offerPayload(findOffer(DEFAULT_OFFER_ID));

  return {
    version: VERSION,
    protocol: PROTOCOL,
    payment_request_url: context.payment_request_url,
    payment_context_token: context.payment_context_token,
    expires_at: new Date(context.expiresAt).toISOString(),
    selected_offer_id: context.offer_id,
    offers: catalog,
    // The exact request shape the settle endpoint expects. `signals` is left
    // empty on purpose: an empty proof must be refused, so there is no
    // placeholder that could be accidentally mistaken for real measurements.
    payment_request: {
      method: 'POST',
      url: context.payment_request_url,
      content_type: 'application/json',
      required_fields: ['payment_context_token', 'offer_id', 'attention.signals'],
      body: {
        payment_context_token: context.payment_context_token,
        offer_id: selected.id,
        attention: { signals: {} }
      },
      signals_schema: SIGNAL_SCHEMA
    },
    challenge: {
      scheme: 'L402',
      caveat: 'viewport-gated',
      ttl_ms: Math.max(0, context.expiresAt - Date.now()),
      base_url: baseUrl
    }
  };
}

/**
 * Parses `Authorization: Bearer <token>`.
 * @returns {string} token or ''
 */
function readBearer(headerValue) {
  const value = String(headerValue || '').trim();
  if (!value) return '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : '';
}

module.exports = {
  PROTOCOL,
  VERSION,
  STATES,
  OFFERS,
  DEFAULT_OFFER_ID,
  L402Contexts,
  buildContract,
  findOffer,
  offerPayload,
  readBearer
};
