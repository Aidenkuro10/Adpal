'use strict';

/**
 * Recipient resolution for PayPal Payouts.
 *
 * PayPal refuses a payout item whose receiver is the account the call is
 * authenticated as, with `SELF_PAY_NOT_ALLOWED`. A batch cannot pay its own
 * sender, because that is a circular transfer: the money would leave the
 * business account and land back in the same business account, minus a fee.
 *
 * The old configuration walked straight into that. `PAYPAL_PUBLISHER_EMAIL`
 * defaulted to the business account — the sender — so every 70/30 batch carried
 * a 30% item addressed to the payer. The batch was rejected as a whole, so the
 * reader's 70% never moved either, and the ledger had to cancel the
 * reservation.
 *
 * Three cases have to be distinguished, because they need different outcomes:
 *
 *   1. the publisher is the sender, or the same address as the reader
 *      → do not address it in the batch. The 30% stays accrued on the ledger,
 *        where a later publisher settlement can pay it. The reservation must
 *        not debit it (`payPublisher: false`), or the ledger would claim money
 *        moved that never did.
 *
 *   2. the reader is the sender
 *      → the batch cannot exist at all. Refuse before reserving anything, so
 *        there is nothing to revert, and say exactly which variable to fix.
 *
 *   3. both legs have distinct, non-sender receivers
 *      → the split travels in one batch, which is the happy path.
 *
 * Email comparison is the only signal available: PayPal identifies self-payment
 * by account, and the REST credentials do not expose the account's address
 * list. `PAYPAL_SENDER_ALIASES` covers a business account with more than one
 * confirmed email; the caller still has to treat PayPal's own
 * `SELF_PAY_NOT_ALLOWED` as possible for an alias we were never told about.
 */

/** Canonical form for comparing two addresses. */
function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Every address known to belong to the sending (payer) account.
 *
 * @param {{ businessEmail?: string, senderAliases?: string[] }} paypal
 * @returns {Set<string>}
 */
function senderIdentities(paypal = {}) {
  const identities = new Set();
  const add = (value) => {
    const email = normalizeEmail(value);
    if (email) identities.add(email);
  };

  add(paypal.businessEmail);
  for (const alias of Array.isArray(paypal.senderAliases) ? paypal.senderAliases : []) {
    add(alias);
  }
  return identities;
}

/**
 * True when paying `email` would move money from the account to itself.
 *
 * @param {string} email
 * @param {{ businessEmail?: string, senderAliases?: string[] }} paypal
 */
function isSelfPay(email, paypal = {}) {
  const target = normalizeEmail(email);
  return Boolean(target) && senderIdentities(paypal).has(target);
}

/** Machine-readable reason the publisher leg is not in the batch. */
const HOLD = Object.freeze({
  NONE: '',
  NOT_CONFIGURED: 'PUBLISHER_NOT_CONFIGURED',
  SELF_PAY: 'PUBLISHER_IS_SENDER',
  SAME_AS_READER: 'PUBLISHER_IS_READER'
});

/**
 * Decides which recipients the batch may carry, without touching the ledger.
 *
 * Pure and synchronous: the caller reserves exactly what this returns, so the
 * batch and the debit always describe the same transfer.
 *
 * @param {{
 *   receiverEmail?: string,
 *   publisherEmail?: string,
 *   paypal?: { businessEmail?: string, senderAliases?: string[], receiverEmail?: string, publisherEmail?: string }
 * }} input
 */
function planRecipients({ receiverEmail, publisherEmail, paypal = {} } = {}) {
  const reader =
    normalizeEmail(receiverEmail) || normalizeEmail(paypal.receiverEmail) || '';
  const candidate =
    normalizeEmail(publisherEmail) || normalizeEmail(paypal.publisherEmail) || '';

  const readerSelfPay = isSelfPay(reader, paypal);

  let publisher = '';
  let holdReason = HOLD.NONE;

  if (!candidate) {
    holdReason = HOLD.NOT_CONFIGURED;
  } else if (candidate === reader) {
    // Two items to one address is the same circular transfer in miniature, and
    // it would make the reader and publisher legs indistinguishable in PayPal.
    holdReason = HOLD.SAME_AS_READER;
  } else if (isSelfPay(candidate, paypal)) {
    holdReason = HOLD.SELF_PAY;
  } else {
    publisher = candidate;
  }

  return {
    reader,
    publisher,
    readerSelfPay,
    publisherSelfPay: holdReason === HOLD.SELF_PAY,
    publisherHold: holdReason,
    // The only case that makes a batch impossible.
    payable: Boolean(reader) && !readerSelfPay,
    senderEmails: [...senderIdentities(paypal)]
  };
}

/**
 * Human explanation for a held publisher leg, for the terminal and the API.
 *
 * @param {ReturnType<typeof planRecipients>} plan
 */
function describeHold(plan) {
  switch (plan?.publisherHold) {
    case HOLD.SELF_PAY:
      return (
        `PAYPAL_PUBLISHER_EMAIL points at the sending account (${plan.senderEmails.join(', ')}). ` +
        'PayPal refuses a payout to the payer (SELF_PAY_NOT_ALLOWED), so the publisher share ' +
        'stays accrued on the ledger instead of being debited.'
      );
    case HOLD.SAME_AS_READER:
      return (
        'The publisher and reader resolve to the same address, so one item is sent and the ' +
        'publisher share stays accrued on the ledger.'
      );
    case HOLD.NOT_CONFIGURED:
      return (
        'No distinct publisher receiver is configured, so the 30% share stays accrued on the ' +
        'ledger. Set PAYPAL_PUBLISHER_EMAIL to a second PayPal account to move it.'
      );
    default:
      return '';
  }
}

/**
 * True when a failure is PayPal's self-payment refusal.
 *
 * Two shapes exist: our own pre-flight error (already typed) and PayPal's issue
 * code coming back on a rejected batch — which is what happens when the payer
 * account owns an alias we were not configured with.
 */
function isSelfPayError(error) {
  if (!error) return false;
  if (String(error.code || '').toUpperCase() === 'SELF_PAY_NOT_ALLOWED') return true;
  if (
    Array.isArray(error.issues) &&
    error.issues.some((issue) => String(issue?.issue || '').toUpperCase() === 'SELF_PAY_NOT_ALLOWED')
  ) {
    return true;
  }
  return /self.?pay|pay (?:to )?yourself/i.test(String(error.message || ''));
}

module.exports = {
  HOLD,
  normalizeEmail,
  senderIdentities,
  isSelfPay,
  planRecipients,
  describeHold,
  isSelfPayError
};
