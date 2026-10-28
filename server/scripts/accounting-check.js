'use strict';

/**
 * Exact 70/30 accounting checks.
 *
 * Runs the real ledger, no network. Verifies the two properties the demo claims:
 *
 *  1. every impression splits to the micro-unit (reader + publisher === gross);
 *  2. the payout rail's whole-cent quantisation carries the remainder instead of
 *     losing it, and the cumulative total converges on exactly 70/30.
 */

const { Ledger, MICROS_PER_CENT } = require('../src/ledger');

const config = {
  currency: 'USD',
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

const micros = (euros) => Math.round(Number(euros) * 1e6);

function impression(ledger, price = 0.05) {
  return ledger.creditOffer({
    price,
    score: 99,
    reason: 'test',
    publisher: 'courier',
    pageTitle: 'Test',
    pageHost: 'localhost'
  });
}

console.log('Accounting · one impression');
{
  const ledger = new Ledger(config);
  const offer = impression(ledger);

  check('split totals the gross', offer.split.micros.reader + offer.split.micros.publisher === offer.split.micros.gross);
  check('reader is exactly 70%', offer.split.micros.reader === 35000, String(offer.split.micros.reader));
  check('publisher is exactly 30%', offer.split.micros.publisher === 15000, String(offer.split.micros.publisher));
  check('balances mirror the split', micros(ledger.user.balance) === 35000 && micros(ledger.publisher.balance) === 15000);
  check('sub-cent carry is reported per leg',
    offer.split.carryMicros.reader === MICROS_PER_CENT / 2 && offer.split.carryMicros.publisher === MICROS_PER_CENT / 2);

  const prepared = ledger.preparePayout({ payPublisher: true, maxAmount: 5 });
  check('payable is floored to whole cents', prepared.reservation.userAmount === 0.03, String(prepared.reservation.userAmount));
  check('carry is explicit', prepared.reservation.reconciliation.carried.gross === 0.01);
  check('no fee is deducted from a leg', prepared.reservation.reconciliation.fees.deductedFromSplit === 0);

  ledger.commitPayout(prepared.reservation, { batchId: 'B1', status: 'SUCCESS' });
  const audit = ledger.audit();
  check('accrued is conserved after commit', audit.invariants.readerConserved && audit.invariants.publisherConserved);
  check('carry stays on the ledger', micros(ledger.user.balance) === 5000);
  check(
    'nothing is unexplained after commit',
    audit.unexplainedMicros.reader === 0 && audit.unexplainedMicros.publisher === 0,
    JSON.stringify(audit.unexplainedMicros)
  );
  check(
    'carry equals the half cent the rail could not move',
    audit.carryMicros.reader === 5000 && audit.carryMicros.publisher === 5000,
    JSON.stringify(audit.carryMicros)
  );
}

console.log('\nAccounting · demo baseline ($1.00 impression)');
{
  // This is the shipped default: DEFAULT_OFFER_PRICE=1.00, USER_SHARE=0.7.
  const baseline = { ...config, maxOfferPrice: 1, defaultOfferPrice: 1 };
  const ledger = new Ledger(baseline);
  const offer = impression(ledger, 1);

  check('reader is exactly $0.70', offer.split.micros.reader === 700000, String(offer.split.micros.reader));
  check('publisher is exactly $0.30', offer.split.micros.publisher === 300000, String(offer.split.micros.publisher));
  check(
    'split totals exactly $1.00',
    offer.split.micros.reader + offer.split.micros.publisher === 1000000,
    String(offer.split.micros.reader + offer.split.micros.publisher)
  );
  check(
    'both legs are whole cents · nothing to carry',
    offer.split.carryMicros.reader === 0 && offer.split.carryMicros.publisher === 0,
    JSON.stringify(offer.split.carryMicros)
  );

  const prepared = ledger.preparePayout({ payPublisher: true, maxAmount: 5 });
  check('reader pays exactly $0.70', prepared.reservation.userAmount === 0.7, String(prepared.reservation.userAmount));
  check('publisher pays exactly $0.30', prepared.reservation.publisherAmount === 0.3, String(prepared.reservation.publisherAmount));
  check('total payout is exactly $1.00', prepared.reservation.total === 1, String(prepared.reservation.total));
  check('nothing is carried at the new baseline', prepared.reservation.reconciliation.carried.gross === 0);

  ledger.commitPayout(prepared.reservation, { batchId: 'B-demo', status: 'SUCCESS' });
  const audit = ledger.audit();
  check(
    'all invariants hold after the $1.00 payout',
    Object.values({
      splitIsExact: audit.invariants.splitIsExact,
      readerConserved: audit.invariants.readerConserved,
      publisherConserved: audit.invariants.publisherConserved,
      ratioWithinOneCent: audit.invariants.ratioWithinOneCent
    }).every(Boolean)
  );
  check(
    'both balances drain to zero',
    micros(ledger.user.balance) === 0 && micros(ledger.publisher.balance) === 0,
    `${ledger.user.balance} / ${ledger.publisher.balance}`
  );
  check(
    'no micro-cent is lost on a cent-exact split',
    audit.unexplainedMicros.reader === 0 && audit.unexplainedMicros.publisher === 0,
    JSON.stringify(audit.unexplainedMicros)
  );
}

console.log('\nAccounting · convergence across impressions');
{
  const ledger = new Ledger(config);
  for (let i = 0; i < 2; i += 1) {
    impression(ledger);
    const prepared = ledger.preparePayout({ payPublisher: true, maxAmount: 5 });
    if (!prepared.ok) {
      failures += 1;
      console.log(`  FAIL payout ${i + 1} not available · ${prepared.reason}`);
      continue;
    }
    ledger.commitPayout(prepared.reservation, { batchId: `B${i + 1}`, status: 'SUCCESS' });
  }

  const audit = ledger.audit();
  check('gross accrued is 0.10', audit.grossAccrued === 0.1, String(audit.grossAccrued));
  check('reader paid exactly 0.07', audit.readerPaid === 0.07, String(audit.readerPaid));
  check('publisher paid exactly 0.03', audit.publisherPaid === 0.03, String(audit.publisherPaid));
  check('nothing is carried after two impressions', audit.grossCarried === 0, String(audit.grossCarried));
  check('cumulative ratio is exactly 70/30', audit.invariants.readerDriftMicros === 0);
  check(
    'no micro-cent is lost across the two batches',
    audit.unexplainedMicros.reader === 0 && audit.unexplainedMicros.publisher === 0,
    JSON.stringify(audit.unexplainedMicros)
  );
  check('all invariants hold', Object.values({
    splitIsExact: audit.invariants.splitIsExact,
    readerConserved: audit.invariants.readerConserved,
    publisherConserved: audit.invariants.publisherConserved,
    ratioWithinOneCent: audit.invariants.ratioWithinOneCent
  }).every(Boolean));
}

console.log('\nAccounting · Solana rail (no cent quantisation)');
{
  const ledger = new Ledger({ ...config, payoutRail: 'solana-devnet', solana: { unitsPerEuro: 100000000 } });
  impression(ledger);

  const quantumMicros = Math.max(1, Math.round(1e6 / 100000000));
  const prepared = ledger.preparePayout({
    maxAmount: 5,
    payPublisher: true,
    quantize: (value) => Math.round(value / quantumMicros) * quantumMicros,
    minMicros: quantumMicros,
    rail: 'solana-devnet'
  });

  check('solana pays the exact split', prepared.reservation.userAmount === 0.035 && prepared.reservation.publisherAmount === 0.015);
  check('solana carries nothing', prepared.reservation.reconciliation.carried.gross === 0);
  ledger.commitPayout(prepared.reservation, { rail: 'solana-devnet', signature: 'sig', status: 'confirmed' });
  const audit = ledger.audit();
  check('solana invariants hold', audit.invariants.readerConserved && audit.invariants.publisherConserved);
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all accounting checks passed');
