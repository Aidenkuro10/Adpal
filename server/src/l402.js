'use strict';

/**
 * L402-style macaroons for the AdPal agent negotiation.
 *
 * This is a real, verifiable token format, not a decorative label:
 *
 *  - an identifier commits to a payment hash (`sha256(preimage)`), exactly as
 *    an L402 macaroon does before the reader "pays" with proven attention;
 *  - each caveat is appended to the signature with a chained HMAC-SHA256, so
 *    any tampering with the caveat list invalidates the token;
 *  - verification re-chains the signature with the server root key, checks the
 *    caveats against the offer being settled, and enforces the expiry.
 *
 * The token is serialised as base64url(JSON) for readability in the demo
 * terminal. A production macaroon library would use the binary format; the
 * cryptographic properties (chained HMAC, caveat enforcement, payment-hash
 * binding) are the same.
 */

const { createHmac, randomBytes, createHash, timingSafeEqual } = require('crypto');

class L402Issuer {
  /**
   * @param {{ rootKey: string, ttlMs?: number }} options
   */
  constructor({ rootKey, ttlMs = 5 * 60 * 1000 }) {
    if (!rootKey) throw new Error('L402Issuer requires a root key');
    this.rootKey = rootKey;
    this.ttlMs = ttlMs;
  }

  /**
   * Builds the L402 challenge a server returns before it will serve paid
   * content: a payment hash plus the caveats the eventual macaroon will carry.
   * The preimage is generated here and handed to `issue`, so the macaroon is
   * cryptographically bound to the challenge the client received.
   *
   * @param {{ offerId: string, price: number, publisher: string, agentId?: string, ttlMs?: number }} input
   */
  challenge({ offerId, price, publisher, agentId = '', ttlMs }) {
    const preimage = randomBytes(32).toString('hex');
    const paymentHash = createHash('sha256').update(preimage).digest('hex');
    const ttl = Math.max(1000, Number(ttlMs) || this.ttlMs);

    return {
      preimage,
      paymentHash,
      identifier: `l402:${paymentHash}`,
      header: `L402 macaroon="pending", payment_hash="${paymentHash}", caveat="viewport-gated"`,
      offerId,
      price,
      publisher,
      agentId,
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttl
    };
  }
  /**
   * Issues a macaroon for an approved offer.
   *
   * Pass the object returned by `challenge` to keep the token bound to the
   * challenge the client saw; without it a fresh preimage is generated.
   *
   * @param {{ offerId: string, price: number, publisher: string, agentId?: string, preimage?: string, issuedAt?: number, expiresAt?: number }} input
   */
  issue({ offerId, price, publisher, agentId = '', preimage, issuedAt, expiresAt }) {
    const secret = typeof preimage === 'string' && /^[0-9a-f]{64}$/i.test(preimage)
      ? preimage
      : randomBytes(32).toString('hex');

    const paymentHash = createHash('sha256').update(secret).digest('hex');
    const issuedAtMs = Number(issuedAt) || Date.now();
    const expiresAtMs = Number(expiresAt) || issuedAtMs + this.ttlMs;

    const identifier = `l402:${paymentHash}`;

    const caveats = [
      `offer_id=${offerId}`,
      `agent_id=${agentId}`,
      `publisher=${publisher}`,
      `max_price=${round4(price)}`,
      `currency=EUR`,
      `issued_at=${new Date(issuedAtMs).toISOString()}`,
      `expires_at=${new Date(expiresAtMs).toISOString()}`,
      `attenuation=viewport-gated`
    ];

    const signature = this.#chain(this.#rootSignature(identifier), caveats);

    const serialized = {
      v: 1,
      i: identifier,
      c: caveats,
      s: signature
    };

    return {
      token: base64url(JSON.stringify(serialized)),
      id: `mcr_${paymentHash.slice(0, 12)}`,
      paymentHash,
      // Returned to the caller only so the demo can prove the preimage matches;
      // it is never rendered into the article.
      preimage: secret,
      caveats,
      issuedAt: issuedAtMs,
      expiresAt: expiresAtMs,
      status: 'issued'
    };
  }

  /**
   * Verifies a token against the offer context. Never throws: callers get a
   * status they can display.
   *
   * @param {string} token
   * @param {{ price: number, publisher: string, offerId?: string, preimage?: string }} context
   */
  verify(token, context = {}) {
    const parsed = parse(token);
    if (!parsed) {
      return failure('malformed', 'The macaroon could not be decoded.');
    }

    const { i: identifier, c: caveats, s: signature } = parsed;
    if (typeof identifier !== 'string' || !Array.isArray(caveats) || typeof signature !== 'string') {
      return failure('malformed', 'The macaroon is missing its identifier, caveats or signature.');
    }

    // 1. Signature chain — any edited caveat breaks this.
    const expected = this.#chain(this.#rootSignature(identifier), caveats);
    if (!safeEqual(signature, expected)) {
      return failure('invalid_signature', 'The macaroon signature does not match its caveats.');
    }

    // 2. Payment-hash binding: the preimage must hash to the identifier.
    if (context.preimage) {
      const digest = createHash('sha256').update(context.preimage).digest('hex');
      if (`l402:${digest}` !== identifier) {
        return failure('preimage_mismatch', 'The preimage does not match the payment hash.');
      }
    }

    // 3. Caveat enforcement.
    const map = toMap(caveats);

    if (map.expires_at) {
      const expiry = Date.parse(map.expires_at);
      if (!Number.isFinite(expiry) || Date.now() > expiry) {
        return failure('expired', 'The macaroon has expired.', { caveats: map });
      }
    }

    if (context.offerId && map.offer_id && map.offer_id !== context.offerId) {
      return failure('caveat_failed', 'The macaroon was issued for a different offer.', { caveats: map });
    }

    if (context.publisher && map.publisher && map.publisher !== context.publisher) {
      return failure('caveat_failed', 'The macaroon was issued for a different publisher.', { caveats: map });
    }

    if (typeof context.price === 'number' && map.max_price) {
      const cap = Number(map.max_price);
      if (!Number.isFinite(cap) || context.price > cap + 1e-9) {
        return failure('caveat_failed', 'The offer exceeds the price authorised by the macaroon.', {
          caveats: map
        });
      }
    }

    return {
      valid: true,
      status: 'verified',
      id: `mcr_${identifier.slice(5, 17)}`,
      caveats: map,
      expiresAt: map.expires_at || null,
      reason: 'Signature chain, caveats and expiry all valid.'
    };
  }

  #rootSignature(identifier) {
    return createHmac('sha256', this.rootKey).update(identifier).digest('hex');
  }

  #chain(signature, caveats) {
    return caveats.reduce(
      (current, caveat) => createHmac('sha256', this.rootKey).update(current).update(caveat).digest('hex'),
      signature
    );
  }
}

/** Truncated, page-safe summary of an issued token. */
function describe(issued, verification) {
  return {
    id: issued.id,
    status: verification?.status || issued.status,
    valid: Boolean(verification?.valid),
    token: truncate(issued.token, 28),
    caveats: issued.caveats.length,
    caveatList: issued.caveats,
    issuedAt: new Date(issued.issuedAt).toISOString(),
    expiresAt: new Date(issued.expiresAt).toISOString(),
    paymentHash: issued.paymentHash.slice(0, 16),
    reason: verification?.reason || ''
  };
}

function parse(token) {
  if (typeof token !== 'string' || !token) return null;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function toMap(caveats) {
  const map = {};
  for (const caveat of caveats) {
    const index = caveat.indexOf('=');
    if (index <= 0) continue;
    map[caveat.slice(0, index)] = caveat.slice(index + 1);
  }
  return map;
}

function failure(status, reason, extra = {}) {
  return { valid: false, status, reason, ...extra };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function base64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

module.exports = { L402Issuer, describe, parse };
