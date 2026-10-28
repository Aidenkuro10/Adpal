'use strict';

/**
 * One settlement, one debit.
 *
 * Reproduces the "sender was debited twice" report against a stubbed PayPal, so
 * the accounting can be checked without moving Sandbox money. It asserts the
 * three properties that make a double debit impossible:
 *
 *   1. a retry of the same reservation reuses `sender_batch_id`, so PayPal's
 *      idempotency guard collapses it into the batch that already exists;
 *   2. that guard (`DUPLICATE_REQUEST_ID`) is read as success, so the ledger
 *      commits instead of cancelling the reservation and re-paying;
 *   3. committing a USD 1.00 settlement debits the sender exactly once, and the
 *      recorded items sum back to the batch total rather than on top of it.
 *
 * Also checks the timeout path: an unconfirmed batch must not be cancelled,
 * because releasing the funds is what let the next trigger pay again.
 */

const path = require('path');

const calls = [];
let scenario = 'created';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

/*
 * Stub `fetch` for both endpoints paypal.js uses. The token call is answered
 * unconditionally; the payouts call is answered according to the scenario.
 */
global.fetch = async (url, options = {}) => {
  const href = String(url);

  if (href.includes('/v1/oauth2/token')) {
    return jsonResponse(200, { access_token: 'stub-token', expires_in: 3600 });
  }

  if (href.includes('/v1/payments/payouts')) {
    const body = JSON.parse(options.body || '{}');
    calls.push({
      senderBatchId: body.sender_batch_header?.sender_batch_id,
      requestId: options.headers?.['PayPal-Request-Id'],
      items: body.items || []
    });

    if (scenario === 'timeout') {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    }

    if (scenario === 'duplicate') {
      return jsonResponse(400, {
        name: 'DUPLICATE_REQUEST_ID',
        message: 'The request id has already been used.',
        details: [{ issue: 'DUPLICATE_REQUEST_ID', description: 'already submitted' }]
      });
    }

    return jsonResponse(201, {
      batch_header: { payout_batch_id: 'BATCHSTUB12345', batch_status: 'PENDING' }
    });
  }

  throw new Error(`unexpected request to ${href}`);
};

const paypal = require(path.join(__dirname, '..', 'src', 'paypal'));
const { Ledger } = require(path.join(__dirname, '..', 'src', 'ledger'));

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

const ledgerConfig = {
  currency: 'USD',
  advertiserBudget: 62,
  userShare: 0.7,
  publisherShare: 0.3,
  payoutThreshold: 0.005,
  humanThreshold: 50,
  maxOfferPrice: 1,
  defaultOfferPrice: 1,
  payoutRail: 'paypal_payouts',
  paypal: { mode: 'sandbox' }
};

const READER = 'reader@example.com';
const PUBLISHER = 'publisher@example.com';

function fundOneImpression(ledger) {
  ledger.creditOffer({
    price: 1,
    score: 99,
    reason: 'test',
    publisher: 'courier',
    pageTitle: 'Test',
    pageHost: 'localhost'
  });
}

/** The exact split the batch must carry: USD 0.70 reader + USD 0.30 publisher. */
const SPLIT_ITEMS = [
  { receiver: READER, amount: 0.7, note: 'Reader share 70%' },
  { receiver: PUBLISHER, amount: 0.3, note: 'Publisher share 30%' }
];

(async () => {
  console.log('Payout · one settlement, one debit');

  /* ---------------------------------------------------------------- */
  /* 1. sender_batch_id is derived from the reference, not the clock   */
  /* ---------------------------------------------------------------- */
  const first = paypal.buildSenderBatchId('ADPAL-M6ABCDEF');
  const second = paypal.buildSenderBatchId('ADPAL-M6ABCDEF');
  const other = paypal.buildSenderBatchId('ADPAL-M6ABCDEG');

  check('a retry reuses the same sender_batch_id', first === second, `${first} vs ${second}`);
  check('a different settlement gets a different id', first !== other);
  check('the id is printable and short enough', /^[A-Z0-9-]{8,60}$/.test(first), first);

  /* ---------------------------------------------------------------- */
  /* 2. A fresh batch is created once, with both items in one request  */
  /* ---------------------------------------------------------------- */
  scenario = 'created';
  calls.length = 0;
  const created = await paypal.createPayout({
    items: SPLIT_ITEMS,
    currency: 'USD',
    reference: 'ADPAL-M6ABCDEF'
  });

  check('exactly one Payouts request was sent', calls.length === 1, String(calls.length));
  check('the request carries both legs', calls[0].items.length === 2, JSON.stringify(calls[0].items));
  check('the request total is 1.00', created.amount === 1, String(created.amount));
  check(
    'PayPal-Request-Id matches sender_batch_id',
    calls[0].requestId === calls[0].senderBatchId,
    `${calls[0].requestId} vs ${calls[0].senderBatchId}`
  );
  check('one debit is declared', created.senderDebit.debits === 1);
  check('the declared debit is 1.00', created.senderDebit.amount === 1, String(created.senderDebit.amount));
  check('it is not marked duplicate', created.duplicate === false);

  /* ---------------------------------------------------------------- */
  /* 3. DUPLICATE_REQUEST_ID is success, and the same id was reused     */
  /* ---------------------------------------------------------------- */
  scenario = 'duplicate';
  calls.length = 0;
  const duplicate = await paypal.createPayout({
    items: SPLIT_ITEMS,
    currency: 'USD',
    reference: 'ADPAL-M6ABCDEF'
  });

  check('a duplicate does not throw', Boolean(duplicate), 'threw');
  check('the duplicate is flagged', duplicate.duplicate === true);
  check(
    'the resubmission reused the original sender_batch_id',
    calls[0].senderBatchId === first,
    calls[0].senderBatchId
  );
  check('the duplicate still reports the same 1.00', duplicate.amount === 1, String(duplicate.amount));

  /* ---------------------------------------------------------------- */
  /* 4. Committing that batch debits the sender exactly once           */
  /* ---------------------------------------------------------------- */
  scenario = 'created';
  const ledger = new Ledger(ledgerConfig);
  fundOneImpression(ledger);

  const prepared = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  check('a 1.00 settlement is payable', prepared.ok === true, prepared.reason || '');
  check('the reservation is 1.00', prepared.reservation.total === 1, String(prepared.reservation.total));
  check('the reservation splits 0.70 / 0.30',
    prepared.reservation.userAmount === 0.7 && prepared.reservation.publisherAmount === 0.3,
    `${prepared.reservation.userAmount} / ${prepared.reservation.publisherAmount}`);

  const batch = await paypal.createPayout({
    items: SPLIT_ITEMS,
    currency: 'USD',
    reference: prepared.reservation.reference
  });

  const payout = ledger.commitPayout(prepared.reservation, { ...batch, rail: 'paypal_payouts' });
  check('the payout was committed', Boolean(payout), 'not committed');

  const debit = payout.paypal.senderDebit;
  check('the sender was debited once', debit.debits === 1, String(debit.debits));
  check('the single debit is 1.00', debit.amount === 1, String(debit.amount));
  check('the single debit equals the batch total', debit.amount === payout.total, `${debit.amount} vs ${payout.total}`);
  check(
    'the items sum to the debit, they do not add to it',
    Math.round(debit.items.reduce((sum, item) => sum + item.amount, 0) * 100) === Math.round(debit.amount * 100),
    JSON.stringify(debit.items)
  );
  check('the ledger total is 1.00, not 2.00', payout.total === 1, String(payout.total));
  check('the reader leg is exactly 0.70', payout.userAmount === 0.7, String(payout.userAmount));
  check('the publisher leg is exactly 0.30', payout.publisherAmount === 0.3, String(payout.publisherAmount));
  check(
    'both balances are empty afterwards',
    payout.remainder.user === 0 && payout.remainder.publisher === 0,
    JSON.stringify(payout.remainder)
  );
  check('no second debit was recorded', ledger.payouts.length === 1, String(ledger.payouts.length));

  /* ---------------------------------------------------------------- */
  /* 5. A duplicate commit cannot double-debit                         */
  /* ---------------------------------------------------------------- */
  const again = ledger.commitPayout(prepared.reservation, { ...batch, rail: 'paypal_payouts' });
  check('a replayed commit is refused', again === null, JSON.stringify(again));
  check('still exactly one payout', ledger.payouts.length === 1, String(ledger.payouts.length));
  check(
    'the balances did not move again',
    ledger.user.balance === 0 && ledger.publisher.balance === 0,
    `${ledger.user.balance} / ${ledger.publisher.balance}`
  );

  /* ---------------------------------------------------------------- */
  /* 6. A timeout is unconfirmed, never a cancellation                  */
  /* ---------------------------------------------------------------- */
  scenario = 'timeout';
  let timedOut = null;
  try {
    await paypal.createPayout({
      items: SPLIT_ITEMS,
      currency: 'USD',
      reference: 'ADPAL-TIMEOUT1'
    });
  } catch (error) {
    timedOut = error;
  }

  check('a timeout throws', Boolean(timedOut), 'did not throw');
  check('the timeout is classified as unconfirmed', paypal.isUnconfirmedError(timedOut) === true, timedOut?.code);
  check(
    'a plain rejection is not unconfirmed',
    paypal.isUnconfirmedError({ code: 'RECEIVER_UNREGISTERED', status: 400 }) === false
  );

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all single-debit checks passed');
})().catch((error) => {
  console.error('check crashed:', error);
  process.exit(1);
});
