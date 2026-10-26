'use strict';

/**
 * Webhook signature-path checks.
 *
 * The route has five distinct refusals and they are easy to conflate, which is
 * exactly how one misconfigured variable becomes an endless retry loop. This
 * script pins the mapping:
 *
 *   cross-environment delivery  → 503 (our configuration, retryable)
 *   unrecognised cert host      → 401 (not something PayPal signed)
 *   lookalike cert host         → 401
 *   missing signature headers   → 401
 *   empty body                  → 400
 *
 * It also proves the mismatch is logged once per window rather than once per
 * retry: PayPal redelivers a refused event, so a per-delivery log line makes the
 * terminal look like the outage it is reporting.
 *
 * Requires a running server with PAYPAL_WEBHOOK_ID set, otherwise verification
 * is skipped and every case above answers 200 by design.
 *
 *   node scripts/webhook-signature-check.js [baseUrl]
 */

const BASE = process.argv[2] || 'http://localhost:3000';

let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
}

async function post(body, headers = {}) {
  const response = await fetch(`${BASE}/api/webhooks/paypal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === null ? '' : JSON.stringify(body)
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* a non-JSON error page is still a valid answer to inspect by status */
  }

  return { status: response.status, body: data, retryAfter: response.headers.get('retry-after') };
}

/** Counts the mismatch log lines currently in the SSE ring buffer. */
async function mismatchLogCount() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  let text = '';

  try {
    const response = await fetch(`${BASE}/api/logs?since=0`, { signal: controller.signal });
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
      if (text.length > 400_000) break;
    }
  } catch {
    /* aborted on purpose: the stream never ends */
  } finally {
    clearTimeout(timer);
  }

  return (text.match(/Webhook refused · environment mismatch/g) || []).length;
}

const EVENT = {
  id: `WH-SIG-${Date.now().toString(36)}`,
  event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  resource_type: 'payouts_item',
  resource: {
    payout_batch_id: 'NOT-OURS',
    payout_item_id: 'ITEM-1',
    payout_item: { sender_batch_id: 'NOT-OURS-EITHER' }
  }
};

const SIGNATURE_HEADERS = {
  'paypal-transmission-id': '3b1c2f10-1111-2222-3333-444455556666',
  'paypal-transmission-sig': 'abc123',
  'paypal-transmission-time': new Date().toISOString(),
  'paypal-auth-algo': 'SHA256withRSA'
};

(async () => {
  console.log(`Webhook signature path · ${BASE}`);

  // 1. A Live-signed notification arriving at a Sandbox-configured server.
  const live = await post(EVENT, {
    ...SIGNATURE_HEADERS,
    'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594'
  });
  check(
    'cross-environment delivery is a configuration mismatch, not a bad signature',
    live.status === 503 && live.body?.error === 'WEBHOOK_ENVIRONMENT_MISMATCH',
    `HTTP ${live.status} ${live.body?.error || ''}`
  );
  check(
    'the refusal names the environment the notification came from',
    live.body?.notification_environment === 'live',
    `notification_environment=${live.body?.notification_environment}`
  );
  check(
    'the refusal is retryable with a stated wait',
    Number(live.retryAfter) > 0,
    `Retry-After=${live.retryAfter}`
  );

  // 2. Repeating it must not produce a second log line.
  const before = await mismatchLogCount();
  const again = await post(EVENT, {
    ...SIGNATURE_HEADERS,
    'paypal-cert-url': 'https://api-m.paypal.com/v1/notifications/certs/CERT-x'
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await mismatchLogCount();
  check('a repeated mismatch is still refused', again.status === 503, `HTTP ${again.status}`);
  check(
    'the repeat is not re-logged inside the window',
    after === before && before > 0,
    `${before} → ${after} line(s)`
  );

  // 3. A host that merely contains "sandbox" is not PayPal.
  const lookalike = await post(EVENT, {
    ...SIGNATURE_HEADERS,
    'paypal-cert-url': 'https://api.sandbox.paypal.com.evil.example/cert'
  });
  check(
    'a lookalike certificate host is refused',
    lookalike.status === 401 && lookalike.body?.error === 'WEBHOOK_SIGNATURE_INVALID',
    `HTTP ${lookalike.status} ${lookalike.body?.error || ''}`
  );

  const plaintext = await post(EVENT, {
    ...SIGNATURE_HEADERS,
    'paypal-cert-url': 'http://api.sandbox.paypal.com/cert'
  });
  check('a plaintext certificate URL is refused', plaintext.status === 401, `HTTP ${plaintext.status}`);

  // 4. Correct environment, nothing to verify with.
  const unsigned = await post(EVENT, {
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42'
  });
  check(
    'a same-environment notification without signature headers is refused',
    unsigned.status === 401,
    `HTTP ${unsigned.status} ${unsigned.body?.error || ''}`
  );

  // 5. A body that cannot be trusted is a 400, never a retryable 503.
  const empty = await post(null);
  check('an empty body is a 400', empty.status === 400, `HTTP ${empty.status}`);

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all webhook signature checks passed');
})().catch((error) => {
  console.error(`webhook signature check failed: ${error.message}`);
  process.exit(1);
});
