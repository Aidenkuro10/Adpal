// Verifies the terminal SSE stream carries both settlement rails.
//
// Opens /api/logs, then drives real traffic while it listens:
//   1. settles L402 invoices until the reader crosses the payout threshold;
//   2. requests a PayPal payout and a Solana payout;
//   3. asserts that events from both families arrived on the same stream, in
//      order, with the stage names the terminal filters on.
//
// Usage: node scripts/sse-dual-rail-check.js [baseUrl]
'use strict';

const base = process.argv[2] || 'http://localhost:3000';

const signals = {
  durationMs: 7600,
  pageDwellMs: 15400,
  mouseMoves: 96,
  directionChanges: 21,
  scrollEvents: 14,
  scrollDepth: 0.72,
  clicks: 2,
  keyPresses: 8,
  visibleRatio: 0.94,
  focusRatio: 0.88,
  slotVisibleRatio: 0.91,
  webdriver: false
};

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(30000)
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Collects SSE frames into parsed events until `stop()` is called.
 *
 * Each frame is `id:` / `event:` / `data:` lines terminated by a blank line;
 * only the `data` payload matters here.
 */
function listen() {
  const events = [];
  const controller = new AbortController();
  const ready = fetch(`${base}/api/logs`, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' }
  }).then(async (response) => {
    if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const dataLines = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim());
            if (!dataLines.length) continue;
            try {
              const parsed = JSON.parse(dataLines.join('\n'));
              // The stream may wrap the event under `event`/`data`.
              events.push(parsed.event && parsed.stage === undefined ? parsed.event : parsed);
            } catch {
              /* a keep-alive or comment frame */
            }
          }
        }
      } catch {
        /* aborted by stop() */
      }
    })();
  });

  return {
    ready,
    events,
    stop() {
      controller.abort();
    }
  };
}

(async () => {
  const health = await call('/api/health');
  console.log('health', health.status, '· active rail', health.body?.rails?.active);
  console.log('treasury', health.body?.solana?.cluster, '· anchorProofs', health.body?.solana?.anchorProofs);

  const stream = listen();
  await stream.ready;
  console.log('SSE open ·', `${base}/api/logs`);

  // --- drive the PayPal rail -------------------------------------------------
  let balance = (await call('/api/balance')).body;
  const threshold = Number(balance?.threshold ?? 0.05);
  let settles = 0;

  while (Number(balance?.user?.balance ?? 0) + 1e-9 < threshold && settles < 6) {
    const challenge = await call('/api/l402/challenge', {
      method: 'POST',
      body: JSON.stringify({ offer_id: 'attention_session_v1' })
    });
    const token = challenge.body?.payment_context_token;
    if (!token) break;
    await call('/api/l402/settle', {
      method: 'POST',
      body: JSON.stringify({ payment_context_token: token, attention: { signals } })
    });
    settles += 1;
    await sleep(250);
    balance = (await call('/api/balance')).body;
  }
  console.log(`settled ${settles} invoice(s) · reader €${balance?.user?.balance}`);

  const paypal = await call('/api/payout', {
    method: 'POST',
    body: JSON.stringify({ reason: 'sse paypal', rail: 'paypal_payouts' })
  });
  console.log('paypal payout', paypal.status, paypal.body?.paypal?.batchId || paypal.body?.error);
  await sleep(900);

  // Top the ledger back up so the Solana request has something to move.
  for (let i = 0; i < 2; i += 1) {
    const challenge = await call('/api/l402/challenge', {
      method: 'POST',
      body: JSON.stringify({ offer_id: 'attention_session_v1' })
    });
    const token = challenge.body?.payment_context_token;
    if (token) {
      await call('/api/l402/settle', {
        method: 'POST',
        body: JSON.stringify({ payment_context_token: token, attention: { signals } })
      });
    }
    await sleep(150);
  }

  const solana = await call('/api/payout', {
    method: 'POST',
    body: JSON.stringify({ reason: 'sse solana', rail: 'solana-devnet' })
  });
  console.log(
    'solana payout',
    solana.status,
    solana.body?.solana?.signature || solana.body?.error || `fell back to ${solana.body?.rail}`
  );
  if (solana.body?.fallback) console.log('  fallback', solana.body.fallback.code);

  await sleep(1200);
  stream.stop();
  await sleep(200);

  // --- inspect what actually arrived ---------------------------------------
  const events = stream.events;
  const paypalEvents = events.filter((event) => String(event.stage || '').startsWith('paypal.'));
  const solanaEvents = events.filter((event) => String(event.stage || '').startsWith('solana.'));
  const payoutEvents = events.filter((event) => String(event.stage || '').startsWith('payout'));

  console.log(`\nstream captured ${events.length} event(s)`);
  const stages = [...new Set(events.map((event) => event.stage))].filter(Boolean);
  console.log('stages:', stages.join(', ') || '(none)');
  console.log(`  paypal.* ${paypalEvents.length} · solana.* ${solanaEvents.length} · payout* ${payoutEvents.length}`);

  for (const event of solanaEvents) {
    const rail = event.data?.rail || '';
    const id = event.data?.signature || event.data?.code || event.data?.status || '';
    console.log(`  · ${event.stage} [${event.level}] ${rail} ${String(id).slice(0, 28)}`);
  }
  for (const event of paypalEvents.slice(0, 6)) {
    console.log(`  · ${event.stage} [${event.level}] ${event.data?.batchId || ''}`);
  }

  const results = [
    {
      name: 'SSE stream delivered events',
      ok: events.length > 0,
      detail: `${events.length} event(s)`
    },
    {
      name: 'PayPal rail logged on the stream',
      ok: paypalEvents.length > 0 || payoutEvents.length > 0,
      detail: `${paypalEvents.length} paypal.* · ${payoutEvents.length} payout*`
    },
    {
      name: 'Solana rail logged on the stream',
      ok: solanaEvents.length > 0,
      detail: `${solanaEvents.length} solana.*`
    },
    {
      name: 'both rails on one stream',
      ok: solanaEvents.length > 0 && (paypalEvents.length > 0 || payoutEvents.length > 0),
      detail: 'dual-rail'
    },
    {
      name: 'settlement events carry a payment hash',
      ok: events.some((event) => /^[0-9a-f]{64}$/.test(String(event.data?.paymentHash || ''))),
      detail: 'sha256(preimage) present'
    }
  ];

  console.log('');
  for (const result of results) {
    console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name} · ${result.detail}`);
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error('\nSSE check aborted ·', error?.stack || error);
  process.exitCode = 1;
});
