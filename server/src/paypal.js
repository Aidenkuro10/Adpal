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
const { isSelfPay, normalizeEmail, planRecipients, describeHold } = require('./payout-recipients');

const { paypal } = config;

/** Refresh a token a little before it expires to avoid mid-flight 401s. */
const TOKEN_SAFETY_WINDOW_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = Math.max(3000, paypal.timeoutMs);

/** @type {{ token: string, expiresAt: number }} */
let tokenCache = { token: '', expiresAt: 0 };

/**
 * Last credential failure, replayed until `until`.
 *
 * A 401 invalid_client is not transient: the same credentials against the same
 * host will be refused again. PayPal retries a refused webhook, so without this
 * every retry would spend another token request on a known-bad configuration.
 * Cleared by the next success, and bypassed with `force`.
 *
 * @type {{ until: number, code: string, message: string, status: number }}
 */
let authFailure = { until: 0, code: '', message: '', status: 0 };

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
  /*
   * The batch PayPal will actually accept, resolved once here so the terminal,
   * the API responses and the payout path all describe the same recipients.
   * `publisherEmail` being empty does not mean the 30% is lost — it means it
   * stays accrued, which `publisherHold` spells out.
   */
  const plan = planRecipients({ paypal });

  return {
    configured: isConfigured(),
    mode: paypal.mode,
    // Reported so a mixed configuration is visible from the page, not only
    // from the server's stdout.
    modeRequested: paypal.modeRequested,
    liveAllowed: paypal.liveAllowed,
    liveDowngraded: paypal.liveDowngraded,
    environment: paypal.mode,
    certHosts: [...paypal.certHosts],
    webhookId: paypal.webhook?.id ? `${paypal.webhook.id.slice(0, 6)}…` : '',
    webhookStrict: Boolean(paypal.webhook?.strict),
    expectedWebhookUrl: paypal.webhook?.expectedUrl || '',
    receiverEmail: paypal.receiverEmail,
    publisherEmail: paypal.publisherEmail,
    publisherConfigured: Boolean(paypal.publisherEmail),
    // What a batch can actually carry. `readerSelfPay` makes the payout
    // impossible, not just degraded, so it is surfaced rather than inferred.
    readerSelfPay: plan.readerSelfPay,
    publisherPayable: Boolean(plan.publisher),
    publisherHold: plan.publisherHold,
    publisherHoldReason: describeHold(plan),
    selfPayAddresses: plan.senderEmails,
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

  /*
   * A known-bad credential set is replayed rather than re-tested. The error is
   * identical to the one PayPal returned, with the code intact, so a caller
   * can still tell an auth failure from an outage.
   */
  if (!force && Date.now() < authFailure.until) {
    throw new PayPalError(
      `${authFailure.message} (not retried for another ` +
        `${Math.max(1, Math.ceil((authFailure.until - Date.now()) / 1000))}s)`,
      { status: authFailure.status, code: authFailure.code }
    );
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

  if (!response.ok || !data?.access_token) {
    const failure = new PayPalError(
      data?.error_description || 'PayPal refused the OAuth2 credentials.',
      {
        status: 502,
        code: data?.error || 'PAYPAL_AUTH_FAILED',
        raw: data
      }
    );

    /*
     * Remember the refusal so a retry storm cannot hammer the token endpoint.
     * The message names the environment, because "invalid_client" against the
     * wrong API host is by far the most common cause and the bare PayPal error
     * never says so.
     */
    authFailure = {
      until: Date.now() + paypal.authFailureBackoffMs,
      code: failure.code,
      status: failure.status,
      message:
        `${failure.message} · obtained against the ${paypal.mode} host ` +
        `${paypal.apiBase}; credentials are environment-specific`
    };

    publish('paypal.oauth', {
      level: 'error',
      title: 'OAuth2 token refused',
      detail: `POST /v1/oauth2/token · HTTP ${response.status} · ${failure.code} · ${paypal.mode}`,
      data: {
        request: {
          method: 'POST',
          url: `${paypal.apiBase}/v1/oauth2/token`,
          headers: { Authorization: 'Basic <client_id:client_secret redacted>' },
          body: { grant_type: 'client_credentials' }
        },
        response: {
          status: response.status,
          ...correlationOf(response),
          body: { error: data?.error || '', error_description: data?.error_description || '' }
        },
        backoffMs: paypal.authFailureBackoffMs
      }
    });

    throw failure;
  }

  authFailure = { until: 0, code: '', message: '', status: 0 };

  publish('paypal.oauth', {
    level: 'info',
    title: 'OAuth2 token issued',
    detail: `POST /v1/oauth2/token · HTTP ${response.status} · ${paypal.mode}`,
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
        body: {
          token_type: data.token_type || 'Bearer',
          expires_in: Number(data.expires_in) || null,
          scope: data.scope || '',
          access_token: redactToken(data.access_token),
          app_id: data.app_id || ''
        }
      }
    }
  });

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

  /*
   * Self-payment is refused before the request leaves the process.
   *
   * PayPal answers SELF_PAY_NOT_ALLOWED for an item addressed to the payer, and
   * it rejects the *whole* batch — so one bad publisher item also cancels the
   * reader's payment. Catching it here turns a round trip that can only fail
   * into an actionable error, and keeps the failure from looking like a PayPal
   * outage in the terminal.
   *
   * The callers that build the split (`runPaypalPayout`, `routeSettlement`)
   * already withhold a self-addressed publisher leg, so reaching this guard
   * means a caller passed an item directly.
   */
  const selfPayItems = items.filter((item) => isSelfPay(item.receiver, paypal));
  if (selfPayItems.length > 0) {
    const addresses = [...new Set(selfPayItems.map((item) => item.receiver))].join(', ');
    throw new PayPalError(
      `PayPal refuses a payout to the sending account (${addresses}). ` +
        'A batch cannot pay the account it was sent from.',
      {
        status: 400,
        code: 'SELF_PAY_NOT_ALLOWED',
        issues: selfPayItems.map((item) => ({
          issue: 'SELF_PAY_NOT_ALLOWED',
          description: `Item receiver ${item.receiver} is the sending account.`,
          field: 'items.receiver'
        }))
      }
    );
  }

  // Two items to one address is the same circular transfer in miniature, and
  // PayPal would fold them into one receiver anyway.
  const seen = new Set();
  for (const item of items) {
    const key = normalizeEmail(item.receiver);
    if (seen.has(key)) {
      throw new PayPalError(
        `A payout batch cannot contain two items for the same receiver (${item.receiver}).`,
        { status: 400, code: 'PAYPAL_DUPLICATE_RECEIVER' }
      );
    }
    seen.add(key);
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
    // Sending to the account the batch is authenticated as is circular, and
    // PayPal rejects the entire batch — the reader's leg included.
    case 'SELF_PAY_NOT_ALLOWED':
      return (
        'PayPal refuses a payout to the sending account. Set PAYPAL_RECEIVER_EMAIL / ' +
        'PAYPAL_PUBLISHER_EMAIL to a different PayPal account than PAYPAL_BUSINESS_EMAIL.'
      );
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
 * The two environments PayPal publishes signing certificates from.
 *
 * Declared once, at module scope, so classification does not depend on which
 * environment this server happens to be configured for — the point of the check
 * is to identify the *other* one.
 */
const PAYPAL_CERT_HOSTS = Object.freeze({
  sandbox: Object.freeze(['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']),
  live: Object.freeze(['api.paypal.com', 'api-m.paypal.com'])
});

/**
 * Which PayPal environment a notification came from, read from its
 * `paypal-cert-url` header.
 *
 * PayPal serves Sandbox and Live from different hosts and stamps each
 * notification with the host that owns the signing certificate. That makes the
 * header the one signal that identifies the mistake which is otherwise
 * invisible: a Live webhook pointed at a Sandbox-configured server (or the
 * reverse). Verification can then only ever return FAILURE — the same answer a
 * forged signature gets — so the notification is retried forever while the real
 * cause stays unlogged.
 *
 * The match is against the exact hostnames PayPal publishes, per environment
 * (`config.paypal.certHosts`). A substring test would be a hole: any attacker
 * can serve a certificate from a host whose name merely contains "sandbox".
 *
 * Returns 'sandbox', 'live', or 'unknown' for a host that is neither. The
 * caller treats 'unknown' as a refusal, because PayPal always signs with one of
 * the four hosts below.
 */
function environmentOfCertUrl(certUrl) {
  let host = '';
  try {
    const url = new URL(String(certUrl || ''));
    // PayPal only ever serves these over TLS; a plaintext cert URL is a forgery
    // or a mangling proxy, and neither is worth classifying.
    if (url.protocol !== 'https:') return 'unknown';
    host = url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'unknown';
  }
  if (!host) return 'unknown';

  if (PAYPAL_CERT_HOSTS.sandbox.includes(host)) return 'sandbox';
  if (PAYPAL_CERT_HOSTS.live.includes(host)) return 'live';
  return 'unknown';
}

/**
 * Verifies an incoming webhook notification with PayPal.
 *
 * PayPal signs the exact bytes it sent. The route keeps the raw buffer for
 * that reason: the event is parsed from the original bytes rather than from a
 * re-serialised copy, so the payload forwarded below is byte-faithful and a
 * local signature check could be added later without re-plumbing the route.
 *
 * The outcomes are kept distinct on purpose, because they call for different
 * HTTP answers and only one of them means "do not trust this event":
 *
 *   { status: 'verified'    } PayPal confirmed the signature
 *   { status: 'failed'      } PayPal rejected it — the event must not be applied
 *   { status: 'mismatch'    } the notification belongs to the other environment,
 *                             so it can never verify here. Our configuration is
 *                             wrong, not the signature. Retryable.
 *   { status: 'unavailable' } the check itself could not run (network, rejected
 *                             credentials, outage). Neither trusted nor disproved.
 *   { status: 'skipped'     } no credentials or no webhook id; nothing was checked
 *
 * `mismatch` exists because folding it into `failed` is what turns one
 * misconfigured variable into an endless retry loop: the route answered 401,
 * PayPal read that as "rejected" and redelivered, and the actual cause — a
 * Sandbox id on a Live endpoint or the reverse — never appeared as an error.
 *
 * @param {{ headers: Record<string, string>, event: object }} input
 */
async function verifyWebhookSignature({ headers, event }) {
  const webhookId = paypal.webhook?.id || '';
  const certUrl = String(headers['paypal-cert-url'] || '').trim();

  if (!isConfigured() || !webhookId) {
    return {
      status: 'skipped',
      attempted: false,
      reason: !isConfigured()
        ? 'PayPal credentials are missing, so the signature could not be verified.'
        : 'PAYPAL_WEBHOOK_ID is not set, so the signature could not be verified.'
    };
  }

  /*
   * Classify the signing host before spending a round trip on it.
   *
   * A host that is neither PayPal's Sandbox nor its Live certificate host is
   * not something to forward: PayPal always signs from one of four hostnames,
   * so anything else is a forgery or a mangling proxy sitting in front of the
   * deployment, and forwarding it just asks PayPal to say no.
   */
  const notificationEnv = environmentOfCertUrl(certUrl);

  if (certUrl && notificationEnv === 'unknown') {
    const reason =
      `The notification names a certificate host this server does not recognise ` +
      `(${certUrl.slice(0, 160)}). PayPal signs from ` +
      `${PAYPAL_CERT_HOSTS.sandbox.concat(PAYPAL_CERT_HOSTS.live).join(' or ')}.`;
    publish('paypal.webhook.verify', {
      level: 'error',
      title: 'Webhook rejected · unrecognised certificate host',
      detail: reason,
      data: { serverMode: paypal.mode, apiBase: paypal.apiBase, certUrl, webhookId }
    });
    return { status: 'failed', attempted: false, reason, code: 'CERT_URL_UNTRUSTED' };
  }

  /*
   * Cross-environment delivery. A Sandbox webhook id is unknown to the Live API
   * and vice versa, so verification can only answer FAILURE; failing closed
   * here keeps that answer out of the signature path and names the real cause.
   */
  if (notificationEnv !== 'unknown' && notificationEnv !== paypal.mode) {
    const reason =
      `This server is configured for ${paypal.mode} (${paypal.apiBase}) but the notification ` +
      `came from ${notificationEnv} (${certUrl}). Webhook ids, credentials and signing hosts ` +
      `are environment-specific, so it can never verify here.`;
    publish('paypal.webhook.verify', {
      level: 'error',
      title: 'Webhook environment mismatch',
      detail: reason,
      data: {
        serverMode: paypal.mode,
        apiBase: paypal.apiBase,
        notificationEnv,
        certUrl,
        webhookId,
        fix: `register the webhook in ${paypal.mode}, or point PAYPAL_MODE at the environment that owns this id`
      }
    });
    return {
      status: 'mismatch',
      attempted: false,
      reason,
      code: 'WEBHOOK_ENVIRONMENT_MISMATCH',
      environmentMismatch: { server: paypal.mode, notification: notificationEnv }
    };
  }

  const body = {
    auth_algo: headers['paypal-auth-algo'] || '',
    cert_url: certUrl,
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
      code: 'SIGNATURE_HEADERS_MISSING',
      reason: `The notification is missing signature headers: ${missing.join(', ')}.`
    };
  }

  /*
   * Credentials are fetched here rather than by the caller so a rejected app
   * keeps its own code. `accessToken` caches the refusal for a while, which is
   * what stops a webhook retry storm from hammering /v1/oauth2/token.
   */
  let token = '';
  try {
    token = await accessToken();
  } catch (error) {
    return {
      status: 'unavailable',
      attempted: true,
      code: error?.code || 'PAYPAL_AUTH_FAILED',
      reason: `${error?.message || 'PayPal credentials could not be used.'} · ${paypal.mode} host ${paypal.apiBase}`
    };
  }

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
    detail: `POST /v1/notifications/verify-webhook-signature · ${verificationStatus} · ${paypal.mode}`,
    data: {
      // Recording the environment on every check is what makes a mixed
      // Sandbox/Live configuration visible instead of merely suspected.
      request: { webhookId, transmissionId: body.transmission_id, apiBase: paypal.apiBase },
      response: { verificationStatus, ...correlationOf(response) }
    }
  });

  return {
    status: verified ? 'verified' : 'failed',
    attempted: true,
    verificationStatus,
    code: verified ? '' : 'SIGNATURE_REJECTED',
    reason: verified
      ? ''
      : `PayPal returned verification_status=${verificationStatus} for a ${paypal.mode} ` +
        `notification verified against ${paypal.apiBase} with webhook id ${webhookId}.`,
    correlationId: correlationOf(response).correlationId
  };
}

/* ------------------------------------------------------------------ */
/* Environment diagnostics                                             */
/* ------------------------------------------------------------------ */

/**
 * The environment this process will talk to, and what it will accept.
 *
 * Exposed so the banner, the terminal and the env-check script all describe the
 * same thing instead of each deriving it.
 */
function describeEnvironment() {
  return {
    mode: paypal.mode,
    modeRequested: paypal.modeRequested,
    liveAllowed: paypal.liveAllowed,
    liveDowngraded: paypal.liveDowngraded,
    apiBase: paypal.apiBase,
    certHosts: [...paypal.certHosts],
    webhookId: paypal.webhook?.id || '',
    webhookStrict: Boolean(paypal.webhook?.strict),
    expectedWebhookUrl: paypal.webhook?.expectedUrl || ''
  };
}

/**
 * Reads the registered webhook from PayPal, to prove the id and the callback URL
 * belong to this environment and to this deployment.
 *
 * Two failures this catches, neither of which says anything useful at delivery
 * time:
 *  - the id was registered in the other environment, so verification can never
 *    succeed (PayPal answers 404 here, FAILURE there);
 *  - the id is valid but its `url` still points at an old hostname, so PayPal
 *    delivers nowhere and the server logs nothing at all.
 *
 * Never throws: this is a startup diagnostic, and a demo must boot even when
 * PayPal is unreachable.
 */
async function describeWebhook() {
  const id = paypal.webhook?.id || '';
  if (!isConfigured()) {
    return { ok: false, skipped: true, reason: 'PayPal credentials are missing.' };
  }
  if (!id) {
    return { ok: false, skipped: true, reason: 'PAYPAL_WEBHOOK_ID is not set.' };
  }

  try {
    const token = await accessToken();
    const response = await request(
      `${paypal.apiBase}/v1/notifications/webhooks/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      }
    );
    const data = await readJson(response);

    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        status: response.status,
        mode: paypal.mode,
        apiBase: paypal.apiBase,
        reason:
          response.status === 404
            ? `The webhook id does not exist in ${paypal.mode} (${paypal.apiBase}). ` +
              'It was probably registered in the other environment.'
            : `PayPal returned HTTP ${response.status} for the webhook lookup.`,
        code: data?.name || ''
      };
    }

    return {
      ok: true,
      skipped: false,
      status: response.status,
      mode: paypal.mode,
      apiBase: paypal.apiBase,
      id: data?.id || id,
      url: data?.url || '',
      eventTypes: Array.isArray(data?.event_types)
        ? data.event_types.map((entry) => entry.name).filter(Boolean)
        : []
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      mode: paypal.mode,
      apiBase: paypal.apiBase,
      reason: error?.message || 'The webhook lookup could not be completed.',
      code: error?.code || ''
    };
  }
}

module.exports = {
  isConfigured,
  publicProfile,
  accessToken,
  createPayout,
  getPayout,
  verifyWebhookSignature,
  environmentOfCertUrl,
  describeEnvironment,
  describeWebhook,
  observe,
  PayPalError,
  normalizeBatchStatus
};
