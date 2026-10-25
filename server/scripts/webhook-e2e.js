'use strict';

/**
 * End-to-end webhook matching check.
 *
 * Creates one real sandbox payout through the normal offer path, then delivers
 * PayPal's item notifications the way PayPal actually sends them and asserts
 * that the *first* delivery matches a local ledger entry — the failure mode the
 * terminal used to report as "no matching payout".
 *
 *   node scripts/webhook-e2e.js http://localhost:3101
 *
 * The target server must have `PAYPAL_WEBHOOK_ID` empty so signature
 * verification is skipped; on a deployed instance PayPal signs the call and
 * verification runs for real. Everything after that point is the same code.
 */

const http = require('http');

const BASE = process.argv[2] || 'http://localhost:3101';
const CLIENT_ID = `webhook-e2e-${Date.now().toString(36)}`;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let out = '';
        res.on('data', (chunk) => (out += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(out);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed, raw: out });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  console.log(`Webhook matching · end to end against ${BASE}`);

  await request('POST', '/api/presence', {
    clientId: CLIENT_ID,
    state: 'active',
    page: { title: 'Webhook check', host: 'localhost' }
  });

  const offer = await request('POST', '/api/offer', {
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
      clientSentAt: Date.now()
    },
    page: { title: 'Webhook check', host: 'localhost' },
    slot: { detected: true, index: 1, lastCreativeId: '' }
  });

  check('impression approved', offer.status === 200 && offer.body?.approved === true, `HTTP ${offer.status}`);
  if (offer.body?.approved !== true) {
    console.log(`cannot continue without an approved impression: ${offer.raw.slice(0, 200)}`);
    process.exit(1);
  }

  // The batch is created asynchronously right after the impression; wait for it
  // to appear with an actual PayPal id rather than assuming a fixed delay.
  let payout = null;
  for (let attempt = 0; attempt < 20 && !payout; attempt += 1) {
    await sleep(500);
    const balance = await request('GET', '/api/balance');
    payout = (balance.body?.payouts || []).find(
      (entry) => entry.rail === 'paypal_payouts' && entry.paypal?.batchId
    );
  }

  check('a PayPal batch was created', Boolean(payout), 'no batch id on the ledger');
  if (!payout) process.exit(1);

  const { batchId, senderBatchId } = payout.paypal;
  console.log(`  ·    batch ${batchId} · sender ${senderBatchId} · €${payout.total}`);

  // 1. The shape PayPal sends for an item event: no payout_batch_id on the
  //    resource, only sender_batch_id inside payout_item. This is the case that
  //    used to fall through to "unmatched".
  const senderOnly = await request('POST', '/api/webhooks/paypal', {
    id: `WH-${Date.now().toString(36)}-a`,
    event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    resource_type: 'payouts_item',
    resource: {
      payout_item_id: 'ITEM-1',
      transaction_status: 'SUCCESS',
      payout_item: {
        payout_item_id: 'ITEM-1',
        transaction_id: 'TX-1',
        sender_item_id: `${payout.paypal.senderBatchId}-1`,
        sender_batch_id: senderBatchId,
        payout_item_fee: { currency: 'EUR', value: '0.00' }
      }
    }
  });
  check(
    'sender_batch_id alone resolves on the first delivery',
    senderOnly.body?.outcome === 'handled',
    `outcome=${senderOnly.body?.outcome}`
  );
  check('the match is reported as a known payout', senderOnly.body?.payout?.id === payout.id, `payout=${senderOnly.body?.payout?.id}`);

  // 2. The batch-id shape must resolve too, and an item already final is a
  //    duplicate rather than a second credit.
  const byBatch = await request('POST', '/api/webhooks/paypal', {
    id: `WH-${Date.now().toString(36)}-b`,
    event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    resource_type: 'payouts_item',
    resource: {
      payout_batch_id: batchId,
      payout_item_id: 'ITEM-1',
      transaction_status: 'SUCCESS',
      payout_item: { payout_item_id: 'ITEM-1', transaction_status: 'SUCCESS' }
    }
  });
  check(
    'payout_batch_id resolves and is idempotent',
    byBatch.body?.outcome === 'handled' || byBatch.body?.outcome === 'duplicate',
    `outcome=${byBatch.body?.outcome}`
  );

  // 3. A redelivery of the same event id is a duplicate, never a second credit.
  const replay = await request('POST', '/api/webhooks/paypal', {
    id: senderOnly.body?.event_id,
    event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    resource: { payout_batch_id: batchId, payout_item_id: 'ITEM-1' }
  });
  check('redelivered event id is a duplicate', replay.body?.outcome === 'duplicate', `outcome=${replay.body?.outcome}`);

  // 4. A batch that is not ours is *held* (out-of-order delivery is the case the
  //    buffer exists for) rather than applied or dropped — and the hold is
  //    reported as held, never as a clean match.
  const before = await request('GET', '/api/balance');
  const unknown = await request('POST', '/api/webhooks/paypal', {
    id: `WH-${Date.now().toString(36)}-c`,
    event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    resource: { payout_batch_id: 'NOT-OURS', payout_item: { sender_batch_id: 'NOT-OURS-EITHER' } }
  });
  check(
    'an unknown batch is held, not matched',
    unknown.body?.outcome === 'deferred',
    `outcome=${unknown.body?.outcome}`
  );
  check(
    'the held event moves no money',
    unknown.body?.balance?.accounting?.readerPaid === before.body?.accounting?.readerPaid &&
      unknown.body?.balance?.accounting?.publisherPaid === before.body?.accounting?.publisherPaid,
    `reader ${before.body?.accounting?.readerPaid} → ${unknown.body?.balance?.accounting?.readerPaid}`
  );

  const final = await request('GET', '/api/balance');
  const accounted = final.body?.accounting || {};
  check(
    'ledger invariants still hold after all deliveries',
    accounted.invariants?.readerConserved === true &&
      accounted.invariants?.publisherConserved === true &&
      accounted.unexplainedMicros?.reader === 0 &&
      accounted.unexplainedMicros?.publisher === 0,
    JSON.stringify(accounted.unexplainedMicros || {})
  );

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all webhook matching checks passed');
})().catch((error) => {
  console.error(`webhook check failed: ${error.message}`);
  process.exit(1);
});
