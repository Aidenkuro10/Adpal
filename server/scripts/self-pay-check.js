'use strict';

/**
 * Self-payment checks for the Payouts split.
 *
 * PayPal refuses a payout item whose receiver is the account the batch is sent
 * from (`SELF_PAY_NOT_ALLOWED`), and it refuses the whole batch. That makes a
 * self-addressed publisher item catastrophic rather than cosmetic: the reader's
 * 70% is cancelled too, and the ledger has to cancel a reservation it had
 * already advertised on the terminal.
 *
 * These checks run without a network call, so they pin the decision that
 * matters — what the batch is allowed to carry — independently of PayPal.
 *
 *   node scripts/self-pay-check.js
 */

const config = require('../src/config');
const { planRecipients, describeHold, isSelfPayError, HOLD } = require('../src/payout-recipients');

const SENDER = 'payer@business.example.com';
const READER = 'reader@personal.example.com';
const PUBLISHER = 'publisher@personal.example.com';

let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
}

function paypal(overrides = {}) {
  return {
    businessEmail: SENDER,
    senderAliases: [],
    receiverEmail: READER,
    publisherEmail: '',
    ...overrides
  };
}

console.log('Payout recipients · self-payment guard');

// 1. The regression: the publisher leg defaulted to the account that pays.
{
  const plan = planRecipients({
    paypal: paypal({ publisherEmail: SENDER })
  });
  check('a publisher addressed to the sender is withheld', plan.publisher === '', `publisher=${plan.publisher || '(none)'}`);
  check('the reason names the self-payment', plan.publisherHold === HOLD.SELF_PAY, plan.publisherHold);
  check('the reader leg is still payable', plan.payable === true, `payable=${plan.payable}`);
  check(
    'the hold is explained in plain language',
    /sending account/i.test(describeHold(plan)),
    'message describes the sender'
  );
}

// 2. Case-insensitive, and aliases count: PayPal identifies by account, not
//    by the exact string, so a second confirmed email on the payer is the same
//    circular transfer.
{
  const plan = planRecipients({
    publisherEmail: 'Payer@Business.Example.com',
    paypal: paypal()
  });
  check('the comparison is case-insensitive', plan.publisherHold === HOLD.SELF_PAY, plan.publisherHold);
}

{
  const plan = planRecipients({
    publisherEmail: 'PAYER+alias@business.example.com',
    paypal: paypal({ senderAliases: ['payer+alias@business.example.com'] })
  });
  check('a configured sender alias is treated as the sender', plan.publisherHold === HOLD.SELF_PAY, plan.publisherHold);
}

// 3. The 30% is not debited when it cannot be paid: no publisher means
//    `payPublisher: false` at the ledger, which is what keeps the balance.
{
  const plan = planRecipients({ paypal: paypal() });
  check('no publisher receiver means the share is held', plan.publisherHold === HOLD.NOT_CONFIGURED, plan.publisherHold);
  check('and nothing is payable to a publisher', plan.publisher === '', `publisher=${plan.publisher || '(none)'}`);
}

// 4. Reader == publisher: one item, or the reader is paid twice.
{
  const plan = planRecipients({
    receiverEmail: READER,
    publisherEmail: READER.toUpperCase(),
    paypal: paypal()
  });
  check('a publisher equal to the reader is withheld', plan.publisher === '', `publisher=${plan.publisher || '(none)'}`);
  check('and reported as the same address', plan.publisherHold === HOLD.SAME_AS_READER, plan.publisherHold);
}

// 5. The happy path still carries both legs.
{
  const plan = planRecipients({
    receiverEmail: READER,
    publisherEmail: PUBLISHER,
    paypal: paypal()
  });
  check('two distinct non-sender receivers are both payable', plan.publisher === PUBLISHER, plan.publisher);
  check('and the batch is payable', plan.payable === true, `payable=${plan.payable}`);
}

// 6. The impossible case: the reader is the payer.
{
  const plan = planRecipients({ receiverEmail: SENDER, paypal: paypal() });
  check('a reader addressed to the sender makes the batch impossible', plan.payable === false, `payable=${plan.payable}`);
  check('and is flagged so the payout is refused before reserving', plan.readerSelfPay === true, `readerSelfPay=${plan.readerSelfPay}`);
}

// 7. PayPal's own refusal has to be recognisable, because an alias we were
//    never configured with is only discovered from the response.
{
  check(
    'PayPal issue code is recognised',
    isSelfPayError({ code: 'SELF_PAY_NOT_ALLOWED', message: 'nope' }) === true
  );
  check(
    'a nested issue is recognised',
    isSelfPayError({ code: 'PAYPAL_ERROR', issues: [{ issue: 'SELF_PAY_NOT_ALLOWED' }] }) === true
  );
  check(
    'an unrelated failure is not mistaken for it',
    isSelfPayError({ code: 'INSUFFICIENT_FUNDS', message: 'no money' }) === false
  );
}

// 8. The configured environment must not itself be a self-payment.
{
  const plan = planRecipients({ paypal: config.paypal });
  check(
    'the current PAYPAL_RECEIVER_EMAIL is not the sending account',
    plan.readerSelfPay === false,
    `${plan.reader || '(unset)'} vs ${config.paypal.businessEmail}`
  );
  check(
    'the current publisher share is either payable or deliberately held',
    plan.publisher ? Boolean(plan.publisher) : Boolean(plan.publisherHold),
    plan.publisher ? `publisher=${plan.publisher}` : `hold=${plan.publisherHold}`
  );
  console.log(
    `  ·    reader ${plan.reader || '(unset)'} · publisher ${plan.publisher || `(held: ${plan.publisherHold})`}`
  );
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all self-payment checks passed');
