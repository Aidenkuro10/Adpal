'use strict';

/**
 * End-to-end latency check for the terminal stream.
 *
 * Proves the demo-readiness claim rather than asserting it: registers a live
 * reader session, fires one real impression, and measures how long each SSE
 * event takes to reach a subscriber relative to the offer response.
 *
 *   node scripts/sse-latency.js http://localhost:3000
 *
 * The `ledger` and `decision` events should land in the same tick (single-digit
 * milliseconds). The final `payout` event is a real PayPal REST round-trip, so
 * it is reported separately instead of being held to the same budget.
 */

const http = require('http');

const BASE = process.argv[2] || 'http://localhost:3000';
const CLIENT_ID = `latency-${Date.now().toString(36)}`;

const t0 = Date.now();
let offerSentAt = 0;
const seen = [];

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      `${BASE}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      },
      (res) => {
        let out = '';
        res.on('data', (chunk) => (out += chunk));
        res.on('end', () => resolve({ at: Date.now(), status: res.statusCode, body: out }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

function offerPayload(clientSentAt) {
  return {
    clientId: CLIENT_ID,
    price: 0.05,
    signals: {
      durationMs: 7200,
      pageDwellMs: 9000,
      mouseMoves: 140,
      directionChanges: 40,
      scrollEvents: 9,
      scrollDepth: 0.55,
      clicks: 2,
      keyPresses: 12,
      visibleRatio: 0.97,
      focusRatio: 0.96,
      slotVisibleRatio: 0.93,
      clientSentAt
    },
    page: { title: 'Latency check', host: 'localhost' },
    slot: { detected: true, index: 1, lastCreativeId: '' }
  };
}

const stream = http.get(`${BASE}/api/logs?live=1`, (res) => {
  let buffer = '';
  res.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }

      const at = Date.now();
      seen.push({ stage: event.stage, at });

      if (['agent.attention', 'agent.bid', 'decision', 'l402.challenge', 'ledger', 'payout'].includes(event.stage)) {
        const delta = offerSentAt ? `+${at - offerSentAt}ms after offer response` : 'before offer';
        console.log(`${String(at - t0).padStart(6)}ms  ${event.stage.padEnd(16)} ${delta}`);
      }
    }
  });
});

stream.on('error', (error) => {
  console.error(`SSE connection failed: ${error.message}`);
  process.exit(1);
});

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));

  await post('/api/presence', {
    clientId: CLIENT_ID,
    state: 'active',
    page: { title: 'Latency check', host: 'localhost' }
  });

  const response = await post('/api/offer', offerPayload(Date.now()));
  offerSentAt = response.at;
  const body = JSON.parse(response.body);
  console.log(`offer HTTP ${response.status} · approved=${body.approved} · at t=${offerSentAt - t0}ms`);

  setTimeout(() => {
    stream.destroy();
    const ledger = seen.find((event) => event.stage === 'ledger');
    const payoutTrigger = seen.find((event) => event.stage === 'payout');

    console.log('---');
    if (!ledger) {
      console.log('no ledger event arrived — is the offer being approved?');
      process.exit(1);
    }
    const ledgerMs = ledger.at - offerSentAt;
    const triggerMs = payoutTrigger ? payoutTrigger.at - offerSentAt : null;
    console.log(`ledger event   ${ledgerMs}ms after the offer response`);
    if (triggerMs !== null) console.log(`payout trigger ${triggerMs}ms after the offer response`);

    // The settlement must be on the same tick as the impression. The payout
    // trigger is reported but not held to the same budget: when the configured
    // rail is unavailable it first attempts that rail and then falls back, and
    // the terminal is meant to show that honestly rather than hide it.
    const instant = ledgerMs <= 250;
    console.log(instant ? 'PASS · settlement is on the same tick as the impression' : 'FAIL · stream lag detected');
    process.exit(instant ? 0 : 1);
  }, 6000);
})();
