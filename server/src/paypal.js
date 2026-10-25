'use strict';

/**
 * PayPal REST client for the AdPal demo.
 *
 * Only two calls are used:
 *  - POST /v1/oauth2/token   (client-credentials grant, cached in memory)
 *  - POST /v1/payments/payouts (a single-item payout batch)
 *
 * Sandbox and live share the same code path; only the API host differs, so a
 * demo can be flipped between the two with PAYPAL_MODE.
 */

const config = require('./config');

const { paypal } = config;

/** Refresh a token a little before it expires to avoid mid-flight 401s. */
const TOKEN_SAFETY_WINDOW_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = Math.max(3000, paypal.timeoutMs);

/** @type {{ token: string, expiresAt: number }} */
let tokenCache = { token: '', expiresAt: 0 };

/**
 * Optional observer used by the terminal view. It receives redacted request and
 * response payloads for every PayPal call so a judge can inspect the real rail
 * without ever leaking a bearer token or client secret.
 *
 * @type {null | ((event: object) => void)}
 */
let observer = null;

/** @param {null | ((event: object) => void)} fn */
function observe(fn) {
  observer = typeof fn === 'function' ? fn : null;
}

function publish(stage, payload) {
  if (!observer) return;
  try {
    observer({ stage, at: new Date().toISOString(), ...payload });
  } catch (error) {
    console.error('[paypal] observer failed:', error?.message || error);
  }
}

/** Removes anything that must never reach a log viewer. */
function redactToken(token) {
  const value = String(token || '');
  if (value.length <= 12) return value ? '***' : '';
  return `${value.slice(0, 6)}…${value.slice(-4)} <redacted>`;
}

/** Correlation headers PayPal returns on every response, useful in a demo. */
function correlationOf(response) {
  return {
    correlationId: response.headers.get('paypal-correlation-id') || '',
    debugId: response.headers.get('paypal-debug-id') || '',
    requestId: response.headers.get('paypal-request-id') || ''
  };
}

class PayPalError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = options.status ?? 502;
    this.code = options.code || 'PAYPAL_ERROR';
    this.issues = Array.isArray(options.issues) ? options.issues : [];
    this.debugId = options.debugId || '';
    this.correlationId = options.correlationId || '';
    this.raw = options.raw ?? null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      issues: this.issues,
      debugId: this.debugId,
      correlationId: this.correlationId
    };
  }
}

/** True when both credentials are present, i.e. a real payout can be attempted. */
function isConfigured() {
  return Boolean(paypal.clientId && paypal.clientSecret);
}

/** Safe-to-expose payout settings for the terminal. */
function publicProfile() {
  return {
    configured: isConfigured(),
    mode: paypal.mode,
    receiverEmail: paypal.receiverEmail,
    publisherEmail: paypal.publisherEmail,
    publisherConfigured: Boolean(paypal.publisherEmail),
    senderEmail: paypal.businessEmail,
    currency: paypal.currency,
    apiBase: paypal.apiBase,
    dashboardUrl: paypal.dashboardUrl,
    sandboxDashboardUrl: paypal.dashboardUrl,
    maxPayout: paypal.maxPayout
  };
}

function authHeader() {
  const credentials = Buffer.from(`${paypal.clientId}:${paypal.clientSecret}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Returns a cached OAuth2 access token, fetching a new one when needed.
 * `force` bypasses the cache (used after a 401).
 */
async function accessToken({ force = false } = {}) {
  if (!isConfigured()) {
    throw new PayPalError('PayPal credentials are missing from server/.env.', {
      status: 503,
      code: 'PAYPAL_NOT_CONFIGURED'
    });
  }

  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const response = await request(`${paypal.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: 'grant_type=client_credentials'
  });

  const data = await readJson(response);

  publish('paypal.oauth', {
    level: response.ok ? 'info' : 'error',
    title: response.ok ? 'OAuth2 token issued' : 'OAuth2 token refused',
    detail: `POST /v1/oauth2/token · HTTP ${response.status}`,
    data: {
      request: {
        method: 'POST',
        url: `${paypal.apiBase}/v1/oauth2/token`,
        headers: {
          Authorization: 'Basic <client_id:client_secret redacted>',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: { grant_type: 'client_credentials' }
      },
      response: {
        status: response.status,
        ...correlationOf(response),
        body: response.ok
          ? {
              token_type: data?.token_type || 'Bearer',
              expires_in: Number(data?.expires_in) || null,
              scope: data?.scope || '',
              access_token: redactToken(data?.access_token),
              app_id: data?.app_id || ''
            }
          : { error: data?.error || '', error_description: data?.error_description || '' }
      }
    }
  });

  if (!response.ok || !data?.access_token) {
    throw new PayPalError(
      data?.error_description || 'PayPal refused the OAuth2 credentials.',
      {
        status: 502,
        code: 'PAYPAL_AUTH_FAILED',
        raw: data
      }
    );
  }

  const expiresInMs = (Number(data.expires_in) || 300) * 1000;
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(30_000, expiresInMs - TOKEN_SAFETY_WINDOW_MS)
  };

  return tokenCache.token;
}

/**
 * Normalizes the single-item and multi-item payout forms into a validated
 * list. Every item must name a receiver and carry at least one cent.
 */
function normalizePayoutItems(input, currency) {
  const raw =
    Array.isArray(input.items) && input.items.length > 0
      ? input.items
      : [
          {
            receiver: input.receiverEmail || paypal.receiverEmail,
            amount: input.amount,
            note: input.note
          }
        ];

  const items = raw.map((item, index) => {
    const receiver = String(item.receiver || '').trim();
    const amount = round2(item.amount);

    if (!receiver.includes('@')) {
      throw new PayPalError(
        index === 0
          ? 'No valid recipient email was configured for the payout.'
          : `Payout item ${index + 1} has no valid recipient email.`,
        { status: 400, code: 'PAYPAL_RECEIVER_MISSING' }
      );
    }

    if (!Number.isFinite(amount) || amount < 0.01) {
      throw new PayPalError(
        `Payout item ${index + 1} must be at least 0.01 ${currency}.`,
        { status: 400, code: 'PAYPAL_AMOUNT_TOO_SMALL' }
      );
    }

    return {
      receiver,
      amount,
      note: String(item.note || input.note || 'AdPal attention payout').slice(0, 500)
    };
  });

  if (items.length === 0) {
    throw new PayPalError('A payout batch needs at least one item.', {
      status: 400,
      code: 'PAYPAL_RECEIVER_MISSING'
    });
  }

  return items;
}

/**
 * Creates a payout batch.
 *
 * `items` is the preferred form: every entry becomes one item in the batch, so
 * the reader share and the publisher share travel together with their own
 * receivers and notes. The single `amount` + `receiverEmail` form is kept for
 * callers that only pay the reader.
 *
 * @param {{
 *   amount?: number,
 *   currency?: string,
 *   receiverEmail?: string,
 *   note?: string,
 *   items?: Array<{ receiver?: string, amount: number, note?: string }>,
 *   emailSubject?: string,
 *   emailMessage?: string,
 *   reference: string
 * }} input
 */
async function createPayout(input) {
  const currency = String(input.currency || paypal.currency).toUpperCase();
  const items = normalizePayoutItems(input, currency);
  const senderBatchId = buildSenderBatchId(input.reference);
  const total = round2(items.reduce((sum, item) => sum + item.amount, 0));

  const body = {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: String(input.emailSubject || 'Your AdPal attention payout').slice(0, 255),
      email_message: String(
        input.emailMessage ||
          'Thanks for reading. This payout is the reader share of the ad you saw on The Courier.'
      ).slice(0, 1000)
    },
    items: items.map((item, index) => ({
      recipient_type: 'EMAIL',
      amount: { value: item.amount.toFixed(2), currency },
      receiver: item.receiver,
      note: item.note,
      sender_item_id: `${senderBatchId}-${index + 1}`.slice(0, 63),
      notification_language: 'en-US'
    }))
  };

  let response = await payoutsRequest(body);

  // A expired/revoked token is recoverable once: refresh and retry.
  if (response.status === 401) {
    await accessToken({ force: true });
    response = await payoutsRequest(body);
  }

  const data = await readJson(response);

  publish('paypal.payout', {
    level: response.ok ? 'info' : 'error',
    title: response.ok ? 'Payout batch created' : 'Payout batch rejected',
    detail: `POST /v1/payments/payouts · HTTP ${response.status}`,
    data: {
      request: {
        method: 'POST',
        url: `${paypal.apiBase}/v1/payments/payouts`,
        headers: {
          Authorization: 'Bearer <access_token redacted>',
          'Content-Type': 'application/json',
          'PayPal-Request-Id': body.sender_batch_header.sender_batch_id
        },
        body
      },
      response: {
        status: response.status,
        ...correlationOf(response),
        body: data
      }
    }
  });

  if (!response.ok) {
    throw errorFromResponse(response, data);
  }

  const header = data?.batch_header || {};
  const batchId = header.payout_batch_id || '';

  return {
    batchId,
    senderBatchId,
    status: normalizeBatchStatus(header.batch_status),
    rawStatus: header.batch_status || 'UNKNOWN',
    amount: total,
    currency,
    receiverEmail: items[0].receiver,
    items,
    mode: paypal.mode,
    correlationId: header.payout_batch_id || '',
    links: Array.isArray(data?.links) ? data.links : [],
    selfUrl: `${paypal.apiBase}/v1/payments/payouts/${batchId}`,
    raw: {
      batch_header: header,
      links: data?.links ?? []
    }
  };
}

/**
 * Reads the current state of a batch, so the terminal can show SUCCESS after
 * a PENDING response without a page reload.
 */
async function getPayout(batchId) {
  const id = String(batchId || '').trim();
  if (!/^[A-Za-z0-9]{8,40}$/.test(id)) {
    throw new PayPalError('Invalid PayPal batch id.', {
      status: 400,
      code: 'PAYPAL_BATCH_ID_INVALID'
    });
  }

  let response = await authorizedGet(`${paypal.apiBase}/v1/payments/payouts/${encodeURIComponent(id)}`);
  if (response.status === 401) {
    await accessToken({ force: true });
    response = await authorizedGet(`${paypal.apiBase}/v1/payments/payouts/${encodeURIComponent(id)}`);
  }

  const data = await readJson(response);

  publish('paypal.status', {
    level: response.ok ? 'info' : 'error',
    title: response.ok ? 'Batch status read' : 'Batch status failed',
    detail: `GET /v1/payments/payouts/${id} · HTTP ${response.status}`,
    data: {
      request: {
        method: 'GET',
        url: `${paypal.apiBase}/v1/payments/payouts/${id}`,
        headers: { Authorization: 'Bearer <access_token redacted>' }
      },
      response: {
        status: response.status,
        ...correlationOf(response),
        body: data
      }
    }
  });

  if (!response.ok) throw errorFromResponse(response, data);

  const header = data?.batch_header || {};
  const item = Array.isArray(data?.items) ? data.items[0] : null;

  return {
    batchId: header.payout_batch_id || id,
    status: normalizeBatchStatus(header.batch_status),
    rawStatus: header.batch_status || 'UNKNOWN',
    amount: Number(header?.amount?.value) || null,
    currency: header?.amount?.currency || paypal.currency,
    itemStatus: item?.transaction_status || null,
    itemId: item?.payout_item_id || null,
    fees: item?.payout_item_fee ? Number(item.payout_item_fee.value) : null,
    time: header.time_completed || header.time_created || null,
    errors: item?.errors ?? null,
    raw: { batch_header: header, items: data?.items ?? [] }
  };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

async function payoutsRequest(body) {
  const token = await accessToken();
  return request(`${paypal.apiBase}/v1/payments/payouts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // Makes retries safe if the demo double-clicks settle.
      'PayPal-Request-Id': body.sender_batch_header.sender_batch_id
    },
    body: JSON.stringify(body)
  });
}

async function authorizedGet(url) {
  const token = await accessToken();
  return request(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  });
}

async function request(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new PayPalError(
      timedOut
        ? `PayPal did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`
        : `Could not reach PayPal: ${error?.message || 'network error'}.`,
      { status: 504, code: timedOut ? 'PAYPAL_TIMEOUT' : 'PAYPAL_UNREACHABLE' }
    );
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 400) };
  }
}

function errorFromResponse(response, data) {
  const issues = Array.isArray(data?.details)
    ? data.details.map((detail) => ({
        issue: detail.issue || '',
        description: detail.description || '',
        field: detail.field || ''
      }))
    : [];

  const primary = issues.find((issue) => issue.issue) || null;
  const message =
    friendlyIssue(primary?.issue) ||
    data?.message ||
    data?.error_description ||
    `PayPal returned HTTP ${response.status}.`;

  return new PayPalError(message, {
    status: response.status === 401 ? 502 : response.status,
    code: primary?.issue || data?.name || 'PAYPAL_ERROR',
    issues,
    debugId: data?.debug_id || '',
    correlationId: response.headers.get('paypal-correlation-id') || '',
    raw: data
  });
}

/** Turns raw PayPal issue codes into something a judge can read. */
function friendlyIssue(issue) {
  switch (issue) {
    case 'RECEIVER_UNREGISTERED':
    case 'PAYEE_ACCOUNT_INVALID':
      return 'The recipient email is not a confirmed PayPal Sandbox account.';
    case 'PAYEE_ACCOUNT_RESTRICTED':
      return 'The recipient Sandbox account cannot receive payouts.';
    case 'INSUFFICIENT_FUNDS':
      return 'The Sandbox business account has no funds for this payout.';
    case 'SENDER_ACCOUNT_RESTRICTED':
      return 'The Sandbox business account is not allowed to send payouts.';
    case 'AUTHENTICATION_FAILURE':
    case 'AUTHORIZATION_ERROR':
      return 'PayPal rejected the API credentials for this environment.';
    case 'DUPLICATE_REQUEST_ID':
      return 'This payout batch was already submitted.';
    default:
      return '';
  }
}

/** PROCESSING and PENDING both read as "PENDING" to the demo. */
function normalizeBatchStatus(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'SUCCESS') return 'SUCCESS';
  if (value === 'PENDING' || value === 'PROCESSING' || value === 'NEW') return 'PENDING';
  if (value === 'DENIED' || value === 'FAILED' || value === 'CANCELED' || value === 'CANCELLED') {
    return 'FAILED';
  }
  return value || 'UNKNOWN';
}

/** PayPal sender_batch_id: unique per submission, printable, <= 256 chars. */
function buildSenderBatchId(reference) {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  const base = String(reference || 'ADPAL').replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
  return `${base.slice(0, 20)}-${stamp}-${random}`.slice(0, 60);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Verifies an incoming webhook notification with PayPal.
 *
 * PayPal signs the exact bytes it sent. The route keeps the raw buffer for
 * that reason: the event is parsed from the original bytes rather than from a
 * re-serialised copy, so the payload forwarded below is byte-faithful and a
 * local signature check could be added later without re-plumbing the route.
 *
 * Returns one of three outcomes rather than throwing for the "cannot check"
 * case, because a missing webhook id is a configuration gap, not a failure:
 *
 *   { status: 'verified' }    PayPal confirmed the signature
 *   { status: 'failed'    }   PayPal rejected it — the caller must not trust the event
 *   { status: 'unavailable' } the check itself failed (network, 4xx/5xx, outage);
 *                             the signature is neither trusted nor disproved
 *   { status: 'skipped'   }   no credentials or no webhook id; nothing was checked
 *
 * @param {{ headers: Record<string, string>, event: object }} input
 */
async function verifyWebhookSignature({ headers, event }) {
  const webhookId = paypal.webhook?.id || '';

  if (!isConfigured() || !webhookId) {
    return {
      status: 'skipped',
      attempted: false,
      reason: !isConfigured()
        ? 'PayPal credentials are missing, so the signature could not be verified.'
        : 'PAYPAL_WEBHOOK_ID is not set, so the signature could not be verified.'
    };
  }

  const body = {
    auth_algo: headers['paypal-auth-algo'] || '',
    cert_url: headers['paypal-cert-url'] || '',
    transmission_id: headers['paypal-transmission-id'] || '',
    transmission_sig: headers['paypal-transmission-sig'] || '',
    transmission_time: headers['paypal-transmission-time'] || '',
    webhook_id: webhookId,
    // PayPal expects the parsed event object here, not a JSON string.
    webhook_event: event
  };

  const missing = ['transmission_id', 'transmission_sig', 'transmission_time', 'auth_algo'].filter(
    (field) => !body[field]
  );
  if (missing.length) {
    return {
      status: 'failed',
      attempted: false,
      reason: `The notification is missing signature headers: ${missing.join(', ')}.`
    };
  }

  const token = await accessToken();
  const response = await request(`${paypal.apiBase}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await readJson(response);

  if (!response.ok) {
    /*
     * A 4xx/5xx from the verification API is not a verdict on the signature —
     * it means the check could not be performed (bad credentials, an expired
     * app, a PayPal outage, a proxy). Reporting that as `failed` would answer
     * 401, which PayPal interprets as "rejected" and retries indefinitely,
     * while the real cause stays invisible. Return `unavailable` instead so the
     * route can answer with a retryable status and log the actual error.
     */
    const failure = errorFromResponse(response, data);
    publish('paypal.webhook.verify', {
      level: 'error',
      title: 'Webhook verification could not be performed',
      detail: `POST /v1/notifications/verify-webhook-signature · HTTP ${response.status} · ${failure.message}`,
      data: {
        request: { webhookId, transmissionId: body.transmission_id },
        response: { status: response.status, error: failure.toJSON(), ...correlationOf(response) }
      }
    });
    return {
      status: 'unavailable',
      attempted: true,
      httpStatus: response.status,
      reason: failure.message,
      code: failure.code,
      correlationId: correlationOf(response).correlationId
    };
  }

  const verificationStatus = String(data?.verification_status || 'UNKNOWN').toUpperCase();
  const verified = verificationStatus === 'SUCCESS';

  publish('paypal.webhook.verify', {
    level: verified ? 'ok' : 'warn',
    title: verified ? 'Webhook signature verified' : 'Webhook signature rejected',
    detail: `POST /v1/notifications/verify-webhook-signature · ${verificationStatus}`,
    data: {
      request: { webhookId, transmissionId: body.transmission_id },
      response: { verificationStatus, ...correlationOf(response) }
    }
  });

  return {
    status: verified ? 'verified' : 'failed',
    attempted: true,
    verificationStatus,
    reason: verified ? '' : `PayPal returned verification_status=${verificationStatus}.`,
    correlationId: correlationOf(response).correlationId
  };
}

module.exports = {
  isConfigured,
  publicProfile,
  accessToken,
  createPayout,
  getPayout,
  verifyWebhookSignature,
  observe,
  PayPalError,
  normalizeBatchStatus
};
