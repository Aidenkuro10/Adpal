'use strict';

/**
 * Reconciliation checks for PayPal payout webhooks.
 *
 * Runs the real ledger and the real reconciler; no network, no credentials.
 * This is the regression test for "unmatched" warnings: an event may arrive
 * before its batch is committed, and it must still be applied on the first
 * delivery rather than reported as unmatched.
 */

const { Ledger } = require('../src/ledger');
const { createWebhookReconciler } = require('../src/webhook-reconciler');

const config = {
  currency: 'EUR',
  advertiserBudget: 62,
  userShare: 0.7,
  publisherShare: 0.3,
  payoutThreshold: 0.005,
  humanThreshold: 50,
  maxOfferPrice: 0.05,
  defaultOfferPrice: 0.05,
  payoutRail: 'paypal_payouts',
  paypal: { mode: 'sandbox' }
};

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

function makeWorld() {
  const ledger = new Ledger(config);
  const reports = [];
  const reconciler = createWebhookReconciler({
    ledger,
    report: (event) => reports.push(event),
    money: (value) => Number(value).toFixed(2)
  });
  return { ledger, reconciler, reports };
}

function commitOnePayout(ledger, { batchId, senderBatchId, reference }) {
  ledger.creditOffer({
    price: 0.05,
    score: 99,
    reason: 'test',
    publisher: 'courier',
    pageTitle: 'Test',
    pageHost: 'localhost'
  });
  const prepared = ledger.preparePayout({ payPublisher: true, maxAmount: 5 });
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`);
  return ledger.commitPayout(prepared.reservation, {
    batchId,
    senderBatchId,
    reference,
    status: 'PENDING',
    rail: 'paypal_payouts'
  });
}

console.log('Webhook reconciliation · deferred delivery');
{
  const { ledger, reconciler } = makeWorld();

  // The batch id a webhook would carry, before the payout exists.
  const early = reconciler.receive({
    eventId: 'WH-EARLY-1',
    eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    status: 'SUCCESS',
    identifiers: {
      batchId: 'BATCH-EARLY',
      senderBatchId: 'ADPAL-EARLY-SENDER',
      senderItemId: 'ADPAL-EARLY-SENDER-1',
      itemId: ''
    }
  });
  check('early event is deferred, not unmatched', early.outcome === 'deferred', early.outcome);
  check('early event is held', reconciler.size >= 1, `size=${reconciler.size}`);

  const payout = commitOnePayout(ledger, {
    batchId: 'BATCH-EARLY',
    senderBatchId: 'ADPAL-EARLY-SENDER',
    reference: 'ADPAL-EARLY-REF'
  });
  const applied = reconciler.flush(payout);
  check('flush applies the held event', applied === 1, `applied=${applied}`);
  check('ledger status is now SUCCESS', payout.paypal.status === 'SUCCESS', payout.paypal.status);
  check('buffer is empty afterwards', reconciler.size === 0, `size=${reconciler.size}`);

  // A redispatched copy of the same event must not re-apply.
  const replay = reconciler.receive({
    eventId: 'WH-EARLY-1',
    eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    status: 'SUCCESS',
    identifiers: { batchId: 'BATCH-EARLY' }
  });
  check('redelivery still matches (handled, not unmatched)', replay.outcome === 'handled', replay.outcome);
}

console.log('\nWebhook reconciliation · identifier coverage');
{
  const { ledger, reconciler } = makeWorld();
  const payout = commitOnePayout(ledger, {
    batchId: 'BATCH-IDS',
    senderBatchId: 'ADPAL-IDS-SENDER',
    reference: 'ADPAL-IDS-REF'
  });

  const byBatch = reconciler.receive({
    eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    status: 'SUCCESS',
    identifiers: { batchId: 'BATCH-IDS' }
  });
  check('matches on payout_batch_id', byBatch.outcome === 'handled', byBatch.outcome);

  const bySender = reconciler.receive({
    eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    status: 'SUCCESS',
    identifiers: { batchId: '', senderBatchId: 'ADPAL-IDS-SENDER' }
  });
  check('matches on sender_batch_id', bySender.outcome === 'handled', bySender.outcome);

  const byItem = reconciler.receive({
    eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    status: 'SUCCESS',
    identifiers: { batchId: '', senderBatchId: '', senderItemId: 'ADPAL-IDS-SENDER-2' }
  });
  check('matches on sender_item_id prefix', byItem.outcome === 'handled', byItem.outcome);
  check('resolved to the same payout', byItem.payout?.id === payout.id);
}

console.log('\nWebhook reconciliation · terminal failure');
{
  const { ledger, reconciler } = makeWorld();
  const payout = commitOnePayout(ledger, {
    batchId: 'BATCH-FAIL',
    senderBatchId: 'ADPAL-FAIL-SENDER',
    reference: 'ADPAL-FAIL-REF'
  });

  const before = ledger.user.balance;
  const micros = (value) => Math.round(Number(value) * 1e6);
  const failed = reconciler.receive({
    eventId: 'WH-FAIL-1',
    eventType: 'PAYMENT.PAYOUTS-ITEM.FAILED',
    status: 'FAILED',
    identifiers: { batchId: 'BATCH-FAIL' }
  });
  check('failure reverses the payout', failed.reversal?.reversed === true);
  check('reader balance is restored', micros(ledger.user.balance) === micros(before) + micros(payout.userAmount),
    `${before} -> ${ledger.user.balance}`);

  const retry = reconciler.receive({
    eventId: 'WH-FAIL-2',
    eventType: 'PAYMENT.PAYOUTS-ITEM.FAILED',
    status: 'FAILED',
    identifiers: { batchId: 'BATCH-FAIL' }
  });
  check('retried failure is idempotent', retry.outcome === 'duplicate', retry.outcome);
  check('balance was not restored twice', micros(ledger.user.balance) === micros(before) + micros(payout.userAmount));

  const audit = ledger.audit();
  check('invariants hold after a reversal', audit.invariants.readerConserved && audit.invariants.publisherConserved);
}

console.log('\nWebhook reconciliation · genuinely unattributable');
{
  const { reconciler } = makeWorld();
  const orphan = reconciler.receive({
    eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    status: 'SUCCESS',
    identifiers: { batchId: '', senderBatchId: '', senderItemId: '', itemId: '' }
  });
  check('no identifiers means unmatched, not deferred', orphan.outcome === 'unmatched', orphan.outcome);
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all reconciliation checks passed');
