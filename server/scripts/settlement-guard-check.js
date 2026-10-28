'use strict';

/**
 * One impression, one payout — the strict settlement guard.
 *
 * The reported failure was two separate payouts for one impression. These
 * checks exercise the guard that makes that impossible in the ledger, because
 * the guard is the only thing standing between a repeated trigger (a retried
 * offer, an L402 settle, double-clicked button, a second deployment replaying
 * the same impression) and a second debit:
 *
 *   1. a payout claims the impressions it settles, so a concurrent reservation
 *      cannot touch the same money;
 *   2. once committed, those impressions are permanently settled and any later
 *      payout is refused with ALREADY_SETTLED — before any rail is called;
 *   3. a cancelled payout releases the claim, so a genuine failure can still be
 *      retried (the fix must not wedge the ledger);
 *   4. the same impression credited twice cannot be paid twice.
 */

const path = require('path');
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

const config = {
  currency: 'EUR',
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

function impression(ledger) {
  return ledger.creditOffer({
    price: 1,
    score: 99,
    reason: 'test',
    publisher: 'courier',
    pageTitle: 'Test',
    pageHost: 'localhost'
  });
}

console.log('Settlement guard · one impression, one payout');

/* ------------------------------------------------------------------ */
/* The happy path, then an immediate second attempt                    */
/* ------------------------------------------------------------------ */
{
  const ledger = new Ledger(config);
  const offer = impression(ledger);

  check('the impression is outstanding', ledger.unsettledOfferIds().includes(offer.id));

  const first = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  check('the first payout is allowed', first.ok === true, first.reason || '');
  check('it settles exactly that impression',
    first.reservation.settlesOffers.length === 1 && first.reservation.settlesOffers[0] === offer.id,
    JSON.stringify(first.reservation.settlesOffers));
  check('the claim is recorded', ledger.claimedOffers.has(offer.id));

  /*
   * The critical assertion: while the first payout is in flight, a second
   * trigger cannot reserve the same money. This is the window in which the two
   * Payouts requests of the bug report were both created.
   */
  const concurrent = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  check('a concurrent payout is refused', concurrent.ok === false, JSON.stringify(concurrent.reason));
  check('it is refused for the right reason',
    concurrent.reason === 'PAYOUT_IN_PROGRESS' || concurrent.reason === 'ALREADY_SETTLED',
    concurrent.reason);

  ledger.commitPayout(first.reservation, { batchId: 'B1', status: 'PENDING', rail: 'paypal_payouts' });
  check('the impression is now settled', ledger.settledOffers.has(offer.id));
  check('the claim was released', !ledger.claimedOffers.has(offer.id));
  check('no impression is outstanding', ledger.unsettledOfferIds().length === 0);
  check('exactly one payout executed', ledger.payoutExecutions === 1, String(ledger.payoutExecutions));

  /*
   * The reported bug, reproduced: the money is asked for again after it has
   * already been paid. The ledger must refuse before any rail call.
   */
  const replay = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  check('a replay of a settled impression is refused', replay.ok === false, JSON.stringify(replay.reason));
  // With the balance emptied, the threshold check refuses first; either refusal
  // is a refusal, and neither reaches the rail.
  check('the refusal never reaches the rail',
    replay.reason === 'ALREADY_SETTLED' || replay.reason === 'THRESHOLD_NOT_REACHED',
    replay.reason);
  check('still exactly one payout executed', ledger.payoutExecutions === 1, String(ledger.payoutExecutions));

  const totals = ledger.audit();
  check('reader was paid exactly once', totals.readerPaid === 0.7, String(totals.readerPaid));
  check('publisher was paid exactly once', totals.publisherPaid === 0.3, String(totals.publisherPaid));
  check('gross paid is 1.00, not 2.00', totals.grossPaid === 1, String(totals.grossPaid));
}

/* ------------------------------------------------------------------ */
/* A cancelled payout must release its claim, or the ledger wedges     */
/* ------------------------------------------------------------------ */
{
  const ledger = new Ledger(config);
  const offer = impression(ledger);

  const prepared = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  check('a payout is prepared', prepared.ok === true, prepared.reason || '');
  ledger.cancelPayout('paypal rejected the batch');

  check('the claim was released on cancel', !ledger.claimedOffers.has(offer.id));
  check('the impression is payable again', ledger.unsettledOfferIds().includes(offer.id));
  check('nothing was settled', ledger.settledOffers.size === 0);
  check('no payout was counted', ledger.payoutExecutions === 0, String(ledger.payoutExecutions));

  const retry = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  check('a genuine retry is still allowed', retry.ok === true, retry.reason || '');
}

/* ------------------------------------------------------------------ */
/* Two impressions are two payouts — the guard must not over-block     */
/* ------------------------------------------------------------------ */
{
  const ledger = new Ledger(config);
  const a = impression(ledger);
  const b = impression(ledger);

  check('both impressions are outstanding', ledger.unsettledOfferIds().length === 2);

  const first = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  check('the first payout covers both', first.ok === true && first.reservation.settlesOffers.length === 2,
    JSON.stringify(first.reservation.settlesOffers));
  ledger.commitPayout(first.reservation, { batchId: 'B1', status: 'PENDING', rail: 'paypal_payouts' });

  check('both are settled', ledger.settledOffers.has(a.id) && ledger.settledOffers.has(b.id));
  check('nothing is outstanding', ledger.unsettledOfferIds().length === 0);
  check('one payout settled two impressions', ledger.payoutExecutions === 1, String(ledger.payoutExecutions));

  const again = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  check('a third attempt is refused', again.ok === false, again.reason);
  check('it never reaches the rail',
    again.reason === 'ALREADY_SETTLED' || again.reason === 'THRESHOLD_NOT_REACHED',
    again.reason);
}

/* ------------------------------------------------------------------ */
/* Money still on the ledger, but every impression already paid        */
/* ------------------------------------------------------------------ */
{
  /*
   * The exact shape of the reported double debit: a balance is present and a
   * trigger fires again. Partial settlement leaves money behind, so this is the
   * one case where ALREADY_SETTLED — not the threshold check — has to refuse.
   */
  const ledger = new Ledger(config);
  const a = impression(ledger);
  const b = impression(ledger);

  const first = ledger.preparePayout({ maxAmount: 5, payPublisher: true, settleOffers: [a.id] });
  check('a payout can settle one impression on its own', first.ok === true, first.reason || '');
  ledger.commitPayout(first.reservation, { batchId: 'B1', status: 'PENDING', rail: 'paypal_payouts' });

  check('money is still on the ledger', ledger.user.balance >= config.payoutThreshold,
    String(ledger.user.balance));
  check('only the second impression is outstanding', ledger.unsettledOfferIds().length === 1);

  const replay = ledger.preparePayout({ maxAmount: 5, payPublisher: true, settleOffers: [a.id] });
  check('replaying the settled impression is refused', replay.ok === false, replay.reason);
  check('the refusal names ALREADY_SETTLED', replay.reason === 'ALREADY_SETTLED', replay.reason);

  const second = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  check('the genuinely unpaid impression can still be paid', second.ok === true, second.reason || '');
  ledger.commitPayout(second.reservation, { batchId: 'B2', status: 'PENDING', rail: 'paypal_payouts' });

  check('two impressions produced two payouts', ledger.payoutExecutions === 2, String(ledger.payoutExecutions));
  const totals = ledger.audit();
  check('gross paid equals gross accrued', totals.grossPaid === totals.grossAccrued,
    `${totals.grossPaid} vs ${totals.grossAccrued}`);
  check('nothing was paid twice', totals.grossPaid === 2, String(totals.grossPaid));
}

/* ------------------------------------------------------------------ */
/* The snapshot exposes the guard                                      */
/* ------------------------------------------------------------------ */
{
  const ledger = new Ledger(config);
  impression(ledger);
  const prepared = ledger.preparePayout({ maxAmount: 5, payPublisher: true });
  ledger.commitPayout(prepared.reservation, { batchId: 'B1', status: 'PENDING', rail: 'paypal_payouts' });

  const stats = ledger.snapshot().stats;
  check('the snapshot reports executions', stats.payoutExecutions === 1, String(stats.payoutExecutions));
  check('the snapshot reports settled impressions', stats.settledImpressions === 1, String(stats.settledImpressions));
  check('the snapshot reports nothing outstanding', stats.unsettledImpressions === 0, String(stats.unsettledImpressions));
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all settlement-guard checks passed');
