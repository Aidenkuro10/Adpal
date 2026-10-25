'use strict';

const { randomUUID } = require('crypto');

function round4(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/**
 * In-memory ledger for the simulator.
 *
 * Accounts:
 *  - user      : their share of approved offers (70% by default);
 *  - publisher : the page's share (30% by default);
 *  - advertiser: the budget spent to buy impressions.
 */
class Ledger {
  constructor(config) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.startedAt = new Date().toISOString();
    this.user = { balance: 0, lifetime: 0, offersAccepted: 0, offersRejected: 0 };
    this.publisher = { balance: 0, lifetime: 0 };
    this.publishers = new Map();
    this.advertiser = {
      budget: round4(this.config.advertiserBudget),
      initialBudget: round4(this.config.advertiserBudget),
      spent: 0
    };
    this.offers = [];
    this.payouts = [];
    // A payout awaiting the PayPal API response (see preparePayout/commit).
    this.pendingPayout = null;
    return this;
  }

  /**
   * Re-bases the aggregate advertiser escrow.
   *
   * Impressions are gated by each campaign's own budget in the rotation, so the
   * aggregate pool has to equal the sum of those campaigns; otherwise the two
   * checks drift apart and a funded campaign can be refused by a stale total.
   */
  setAdvertiserBudget(total) {
    const amount = round4(Math.max(0, Number(total) || 0));
    this.advertiser.budget = amount;
    this.advertiser.initialBudget = amount;
    this.advertiser.spent = 0;
    return this;
  }

  snapshot() {
    return {
      currency: this.config.currency,
      updatedAt: new Date().toISOString(),
      startedAt: this.startedAt,
      threshold: this.config.payoutThreshold,
      user: {
        balance: round4(this.user.balance),
        lifetime: round4(this.user.lifetime),
        offersAccepted: this.user.offersAccepted,
        offersRejected: this.user.offersRejected
      },
      publisher: {
        balance: round4(this.publisher.balance),
        lifetime: round4(this.publisher.lifetime),
        publishers: [...this.publishers.values()]
          .map((entry) => ({
            name: entry.name,
            balance: round4(entry.balance),
            lifetime: round4(entry.lifetime),
            offers: entry.offers
          }))
          .sort((a, b) => b.lifetime - a.lifetime)
          .slice(0, 5)
      },
      advertiser: {
        budget: round4(this.advertiser.budget),
        initialBudget: round4(this.advertiser.initialBudget),
        spent: round4(this.advertiser.spent)
      },
      rules: {
        maxPrice: this.config.maxOfferPrice,
        defaultPrice: this.config.defaultOfferPrice,
        userShare: this.config.userShare,
        publisherShare: this.config.publisherShare,
        threshold: this.config.payoutThreshold,
        humanThreshold: this.config.humanThreshold,
        payoutMode: 'grouped',
        // Was hardcoded to 'paypal', which contradicted both `balance.payoutRail`
        // and the rail names used everywhere else. Read it from config so the
        // snapshot cannot disagree with the rail that will actually settle.
        payoutRail: this.config.payoutRail || 'paypal_payouts'
      },
      stats: {
        offersTotal: this.offers.length,
        payoutsTotal: this.payouts.length,
        payoutPending: Boolean(this.pendingPayout),
        payoutRail: this.pendingPayout?.rail || this.payouts[this.payouts.length - 1]?.rail || null
      },
      recentOffers: this.offers.slice(-8).reverse(),
      payouts: this.payouts.slice(-5).reverse()
    };
  }

  recordRejection({ score, reason, publisher, pageTitle, pageHost }) {
    this.user.offersRejected += 1;

    const offer = {
      id: `ofr_${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      approved: false,
      score,
      reason,
      price: 0,
      publisher: publisher || 'unknown',
      pageTitle: pageTitle || 'Untitled page',
      pageHost: pageHost || '',
      split: {
        user: 0,
        publisher: 0,
        userRate: this.config.userShare,
        publisherRate: this.config.publisherShare
      }
    };

    this.offers.push(offer);
    this.#trim();
    return offer;
  }

  creditOffer({ price, score, reason, publisher, pageTitle, pageHost }) {
    const amount = round4(price);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (this.advertiser.budget + 1e-9 < amount) return null;

    const userAmount = round4(amount * this.config.userShare);
    const publisherAmount = round4(amount - userAmount);

    this.advertiser.budget = round4(this.advertiser.budget - amount);
    this.advertiser.spent = round4(this.advertiser.spent + amount);

    this.user.balance = round4(this.user.balance + userAmount);
    this.user.lifetime = round4(this.user.lifetime + userAmount);
    this.user.offersAccepted += 1;

    this.publisher.balance = round4(this.publisher.balance + publisherAmount);
    this.publisher.lifetime = round4(this.publisher.lifetime + publisherAmount);

    const key = publisher || 'unknown';
    const entry = this.publishers.get(key) || {
      name: key,
      balance: 0,
      lifetime: 0,
      offers: 0
    };
    entry.balance = round4(entry.balance + publisherAmount);
    entry.lifetime = round4(entry.lifetime + publisherAmount);
    entry.offers += 1;
    this.publishers.set(key, entry);

    const offer = {
      id: `ofr_${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      approved: true,
      score,
      reason,
      price: amount,
      publisher: key,
      pageTitle: pageTitle || 'Untitled page',
      pageHost: pageHost || '',
      split: {
        user: userAmount,
        publisher: publisherAmount,
        userRate: this.config.userShare,
        publisherRate: this.config.publisherShare
      }
    };

    this.offers.push(offer);
    this.#trim();
    return offer;
  }

  /**
   * Reserves a payout before the PayPal call is made.
   *
   * Nothing is debited here: the caller either commits the reservation once
   * PayPal has accepted the batch, or cancels it when the API call fails. That
   * keeps the ledger honest if the network drops mid-request.
   *
   * Amounts are floored to whole cents because PayPal payouts are denominated
   * in 2-decimal currency units; any remainder stays on the balance.
   */
  /**
   * Reserves a payout before the rail call is made.
   *
   * Nothing is debited here: the caller either commits the reservation once the
   * rail accepted the transfer/batch, or cancels it when the call fails. That
   * keeps the ledger honest if the network drops mid-request.
   *
   * `quantize` is the rail's denomination. PayPal pays in whole cents, so its
   * quantizer floors to two decimals; Solana pays in integer base units, so its
   * quantizer rounds to the nearest base-unit equivalent in euros. Both keep
   * every remainder on the balance instead of silently moving it.
   *
   * @param {{
   *   maxAmount?: number,
   *   payPublisher?: boolean,
   *   quantize?: (value: number) => number,
   *   minAmount?: number,
   *   rail?: string
   * }} options
   */
  preparePayout({
    maxAmount = Infinity,
    payPublisher = false,
    quantize = floor2,
    minAmount = 0.01,
    rail = 'paypal_payouts'
  } = {}) {
    const threshold = this.config.payoutThreshold;
    const userBalance = round4(this.user.balance);
    const quantum = typeof quantize === 'function' ? quantize : floor2;
    const minimum = Math.max(0, Number(minAmount) || 0);

    if (this.pendingPayout) {
      return {
        ok: false,
        reason: 'PAYOUT_IN_PROGRESS',
        message: 'A payout is already being processed.',
        threshold,
        balance: userBalance
      };
    }

    if (userBalance + 1e-9 < threshold) {
      return {
        ok: false,
        reason: 'THRESHOLD_NOT_REACHED',
        threshold,
        balance: userBalance,
        missing: round4(threshold - userBalance)
      };
    }

    const cap = Math.max(minimum, Number(maxAmount) || Infinity);
    const userPayable = quantum(Math.min(userBalance, cap));
    // The publisher's 30% is only moved when the rail can address a second
    // recipient. Otherwise it stays on the ledger, where a monthly publisher
    // settlement can pick it up — it must never be debited without a transfer.
    const publisherPayable = payPublisher
      ? quantum(Math.min(round4(this.publisher.balance), cap))
      : 0;
    const publisherAmount = publisherPayable >= minimum ? publisherPayable : 0;

    if (userPayable < minimum) {
      return {
        ok: false,
        reason: 'AMOUNT_TOO_SMALL',
        message:
          rail === 'solana-devnet'
            ? `The reader share is below the Solana minimum of ${minimum}.`
            : 'The reader share is below the PayPal minimum of €0.01.',
        threshold,
        balance: userBalance
      };
    }

    const reservation = {
      id: `pay_${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      reference: `ADPAL-${Date.now().toString(36).toUpperCase()}`,
      rail,
      userAmount: userPayable,
      publisherAmount,
      total: round4(userPayable + publisherAmount),
      userRemainder: round4(userBalance - userPayable),
      publisherRemainder: round4(round4(this.publisher.balance) - publisherAmount),
      capped: userPayable + 1e-9 < userBalance,
      // The 70/30 rule is applied per impression, so the two balances already
      // hold the split; this block states it explicitly for the terminal and
      // lets the payout layer assert it before touching a rail.
      split: this.#splitOf(userPayable, publisherAmount, rail)
    };

    this.pendingPayout = reservation;
    return { ok: true, reservation, threshold, balance: this.snapshot() };
  }

  /**
   * Describes the split a batch would move. `withinTolerance` is one cent:
   * PayPal amounts are two-decimal, so an exact 70/30 is not always expressible
   * on a small balance, and rounding the last cent either way is expected.
   */
  #splitOf(userAmount, publisherAmount, rail = 'paypal_payouts') {
    const userRate = this.config.userShare;
    const publisherRate = this.config.publisherShare;
    const total = round4(userAmount + publisherAmount);
    const readerCents = Math.round(userAmount * 100);
    const publisherCents = Math.round(publisherAmount * 100);
    const expectedReaderCents = Math.round((readerCents + publisherCents) * userRate);

    return {
      userRate,
      publisherRate,
      reader: userAmount,
      publisher: publisherAmount,
      total,
      readerCents,
      publisherCents,
      withinTolerance: Math.abs(readerCents - expectedReaderCents) <= 1,
      rail,
      publisherRail: publisherAmount > 0 ? rail : 'ledger-held'
    };
  }

  /** Releases a reservation without moving any money. */
  cancelPayout(reason = '') {
    const reservation = this.pendingPayout;
    this.pendingPayout = null;
    return reservation ? { ...reservation, cancelled: true, reason } : null;
  }

  /**
   * Debits the reserved amounts and records the payout with the details of
   * whichever rail moved the money (a PayPal batch or a Solana transaction).
   */
  commitPayout(reservation, settlement = {}) {
    if (!reservation || this.pendingPayout?.id !== reservation.id) return null;

    this.user.balance = round4(Math.max(0, this.user.balance - reservation.userAmount));
    this.publisher.balance = round4(
      Math.max(0, this.publisher.balance - reservation.publisherAmount)
    );
    // Keep the per-publisher breakdown. A later failure webhook has to restore
    // exactly what was taken, and re-deriving it from the aggregate would lose
    // which publisher contributed which share.
    const publisherDebits = this.#deductPublishers(reservation.publisherAmount);

    this.pendingPayout = null;

    const rail = settlement.rail || reservation.rail || 'paypal_payouts';
    const payout = {
      id: reservation.id,
      at: new Date().toISOString(),
      method: rail === 'solana-devnet' ? 'solana' : 'paypal',
      rail,
      reference: reservation.reference,
      userAmount: reservation.userAmount,
      publisherAmount: reservation.publisherAmount,
      total: reservation.total,
      currency: settlement.currency || this.config.currency,
      // What stayed on the balance because of cent / base-unit rounding or the
      // demo cap.
      remainder: {
        user: reservation.userRemainder,
        publisher: reservation.publisherRemainder
      },
      // Exact per-publisher debits, so a failure webhook can put the money back
      // where it came from. `reversal` stays null until a rail reports failure.
      publisherDebits,
      reversal: null
    };

    if (rail === 'solana-devnet') {
      payout.solana = {
        cluster: settlement.cluster || '',
        signature: settlement.signature || '',
        slot: settlement.slot ?? null,
        status: settlement.status || 'UNKNOWN',
        pending: Boolean(settlement.pending),
        memo: settlement.memo || '',
        units: settlement.units || null,
        mint: settlement.mint || null,
        decimals: settlement.decimals ?? null,
        reader: settlement.reader || null,
        publisher: settlement.publisher || null,
        treasury: settlement.treasury || '',
        explorerUrl: settlement.explorerUrl || '',
        fee: settlement.fee ?? null,
        checkedAt: new Date().toISOString()
      };
      payout.paypal = null;
    } else {
      payout.paypal = {
        batchId: settlement.batchId || '',
        senderBatchId: settlement.senderBatchId || '',
        status: settlement.status || 'UNKNOWN',
        rawStatus: settlement.rawStatus || '',
        receiverEmail: settlement.receiverEmail || '',
        mode: settlement.mode || this.config.paypal.mode,
        amount: settlement.amount ?? reservation.userAmount,
        currency: settlement.currency || this.config.currency,
        selfUrl: settlement.selfUrl || '',
        links: Array.isArray(settlement.links) ? settlement.links : [],
        checkedAt: new Date().toISOString()
      };
    }

    this.payouts.push(payout);
    if (this.payouts.length > 50) this.payouts.shift();

    return payout;
  }

  /** Applies a later status refresh to a stored payout, by batch id or signature. */
  updatePayoutStatus(identifier, status) {
    if (!identifier) return null;
    const payout = [...this.payouts].reverse().find(
      (entry) => entry.paypal?.batchId === identifier || entry.solana?.signature === identifier
    );
    if (!payout) return null;
    if (payout.paypal) {
      payout.paypal.status = status;
      payout.paypal.checkedAt = new Date().toISOString();
    }
    if (payout.solana) {
      payout.solana.status = status;
      payout.solana.pending = status === 'processed';
      payout.solana.checkedAt = new Date().toISOString();
    }
    return payout;
  }

  /**
   * Reverses a committed payout after a rail reports a terminal failure.
   *
   * `commitPayout` debits the balances when the rail *accepts* the batch. Payout
   * items can still fail afterwards (unregistered receiver, account restriction),
   * and when they do the money never moved — so leaving the debit in place would
   * quietly delete a reader's balance.
   *
   * Idempotent: PayPal retries webhooks, and a second reversal of the same payout
   * would mint money. Anything not yet final (UNCLAIMED, ONHOLD) must be handled
   * by the caller as a status update only, never as a reversal.
   *
   * @returns {null | { payout: object, reversed: boolean, alreadyReversed: boolean, restored: number }}
   */
  reversePayout(identifier, { reason = '' } = {}) {
    if (!identifier) return null;
    const payout = [...this.payouts].reverse().find(
      (entry) => entry.paypal?.batchId === identifier || entry.solana?.signature === identifier
    );
    if (!payout) return null;

    if (payout.reversal) {
      return { payout, reversed: false, alreadyReversed: true, restored: 0 };
    }

    this.user.balance = round4(this.user.balance + payout.userAmount);
    this.publisher.balance = round4(this.publisher.balance + payout.publisherAmount);

    for (const debit of payout.publisherDebits || []) {
      const entry = this.publishers.get(debit.name);
      if (entry) entry.balance = round4(entry.balance + debit.amount);
    }

    const at = new Date().toISOString();
    payout.reversal = {
      at,
      reason,
      userAmount: payout.userAmount,
      publisherAmount: payout.publisherAmount
    };

    if (payout.paypal) {
      payout.paypal.status = 'FAILED';
      payout.paypal.checkedAt = at;
    }
    if (payout.solana) {
      payout.solana.status = 'FAILED';
      payout.solana.pending = false;
      payout.solana.checkedAt = at;
    }

    return {
      payout,
      reversed: true,
      alreadyReversed: false,
      restored: round4(payout.userAmount + payout.publisherAmount)
    };
  }

  #deductPublishers(amount) {
    let remaining = round4(amount);
    if (remaining <= 0) return [];

    const debits = [];

    for (const entry of this.publishers.values()) {
      if (remaining <= 0) break;
      const take = round4(Math.min(entry.balance, remaining));
      if (take > 0) debits.push({ name: entry.name, amount: take });
      entry.balance = round4(entry.balance - take);
      remaining = round4(remaining - take);
    }

    return debits;
  }

  #trim() {
    if (this.offers.length > 200) this.offers.shift();
  }
}

function floor2(value) {
  return Math.floor((Number(value) + 1e-9) * 100) / 100;
}

module.exports = { Ledger, round4 };
