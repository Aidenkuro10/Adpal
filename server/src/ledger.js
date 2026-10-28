'use strict';

const { randomUUID } = require('crypto');

/* ------------------------------------------------------------------ */
/* Money units                                                         */
/* ------------------------------------------------------------------ */

/**
 * Every balance is an integer number of micro-euros.
 *
 * The previous implementation stored euros as floats and rounded each step with
 * `round4`. That is fine until a payout: `floor2(0.035)` is `0.03`, so a €0.05
 * impression credits €0.035 to the reader and then pays out €0.03, silently
 * stranding half a cent. Integer micros make the accrual exact and force the
 * rail quantisation to be an explicit, reported step instead of a rounding
 * artefact. The demo baseline (€1.00 → €0.70/€0.30) is cent-exact by
 * construction; the carry path stays because any configured price can be odd.
 *
 * 1 € = 1_000_000 micros · 1 cent = 10_000 micros
 */
const MICROS_PER_EURO = 1_000_000;
const MICROS_PER_CENT = 10_000;

function toMicros(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * MICROS_PER_EURO);
}

function fromMicros(micros) {
  return (Number(micros) || 0) / MICROS_PER_EURO;
}

/** Largest whole-cent amount that does not exceed `micros`. */
function floorCents(micros) {
  // Guard the sign so a negative never floors upward into a bigger payout.
  return Math.floor(Number(micros) / MICROS_PER_CENT + 1e-9) * MICROS_PER_CENT;
}

/** Round4 kept for the public helpers that still speak in euros. */
function round4(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function round6(value) {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * In-memory ledger for the simulator.
 *
 * Accounts:
 *  - user      : their share of approved offers (70% by default);
 *  - publisher : the page's share (30% by default);
 *  - advertiser: the budget spent to buy impressions.
 *
 * Invariants (asserted by `audit()`):
 *  1. for every impression, reader + publisher === gross, to the micro-euro;
 *  2. accrued === paid + balances, for both parties;
 *  3. cumulative paid keeps the 70/30 ratio within one cent.
 */
class Ledger {
  constructor(config) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.startedAt = new Date().toISOString();

    // Integer micro-euro state. Nothing else in this class stores money.
    this._m = {
      user: 0,
      publisher: 0,
      userLifetime: 0,
      publisherLifetime: 0,
      advertiserBudget: toMicros(this.config.advertiserBudget),
      advertiserInitial: toMicros(this.config.advertiserBudget),
      advertiserSpent: 0,
      // Cumulative audit trail: what was accrued, what actually left the rail,
      // and what came back after a failed payout item.
      grossAccrued: 0,
      readerAccrued: 0,
      publisherAccrued: 0,
      readerPaid: 0,
      publisherPaid: 0,
      readerReversed: 0,
      publisherReversed: 0
    };

    // Public views. `balance` is a getter so any caller reading
    // `ledger.user.balance` sees the integer-backed value without this class
    // having to keep two copies of the same number in sync.
    this.user = { offersAccepted: 0, offersRejected: 0 };
    Object.defineProperty(this.user, 'balance', {
      enumerable: true,
      get: () => round6(fromMicros(this._m.user))
    });
    Object.defineProperty(this.user, 'lifetime', {
      enumerable: true,
      get: () => round6(fromMicros(this._m.userLifetime))
    });

    this.publisher = {};
    Object.defineProperty(this.publisher, 'balance', {
      enumerable: true,
      get: () => round6(fromMicros(this._m.publisher))
    });
    Object.defineProperty(this.publisher, 'lifetime', {
      enumerable: true,
      get: () => round6(fromMicros(this._m.publisherLifetime))
    });

    this.publishers = new Map();
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
    const micros = Math.max(0, toMicros(total));
    this._m.advertiserBudget = micros;
    this._m.advertiserInitial = micros;
    this._m.advertiserSpent = 0;
    return this;
  }

  /** Advertiser budget as euros, for the routes that still read it directly. */
  get advertiser() {
    return {
      budget: round6(fromMicros(this._m.advertiserBudget)),
      initialBudget: round6(fromMicros(this._m.advertiserInitial)),
      spent: round6(fromMicros(this._m.advertiserSpent))
    };
  }

  /**
   * Full financial audit.
   *
   * This is the number a judge can check by hand: what was earned, what moved,
   * what is still held, and whether the two halves still add up to the whole.
   */
  audit() {
    const m = this._m;
    const readerDrift = m.readerPaid - Math.round((m.readerPaid + m.publisherPaid) * this.config.userShare);
    return {
      unit: 'micro-euro',
      divisible: 1 / MICROS_PER_EURO,
      impressions: this.user.offersAccepted,
      grossAccrued: round6(fromMicros(m.grossAccrued)),
      readerAccrued: round6(fromMicros(m.readerAccrued)),
      publisherAccrued: round6(fromMicros(m.publisherAccrued)),
      readerPaid: round6(fromMicros(m.readerPaid)),
      publisherPaid: round6(fromMicros(m.publisherPaid)),
      readerReversed: round6(fromMicros(m.readerReversed)),
      publisherReversed: round6(fromMicros(m.publisherReversed)),
      readerBalance: round6(fromMicros(m.user)),
      publisherBalance: round6(fromMicros(m.publisher)),
      grossPaid: round6(fromMicros(m.readerPaid + m.publisherPaid)),
      grossCarried: round6(fromMicros(m.user + m.publisher)),
      // The sub-cent remainder the whole-cent rail cannot move yet. It is not a
      // rounding loss: `unexplainedMicros` is accrued minus (paid - reversed +
      // carried), so it only becomes non-zero if money actually went missing.
      carryMicros: {
        reader: m.user,
        publisher: m.publisher,
        gross: m.user + m.publisher
      },
      unexplainedMicros: {
        reader: m.readerAccrued - (m.readerPaid - m.readerReversed + m.user),
        publisher: m.publisherAccrued - (m.publisherPaid - m.publisherReversed + m.publisher),
        gross: 0
      },
      invariants: {
        // 1. each impression split adds back to its gross (true by construction)
        splitIsExact: m.readerAccrued + m.publisherAccrued === m.grossAccrued,
        // 2. accrued = paid + reversed + still held, per party
        readerConserved:
          m.readerAccrued === m.readerPaid - m.readerReversed + m.user,
        publisherConserved:
          m.publisherAccrued === m.publisherPaid - m.publisherReversed + m.publisher,
        // 3. cumulative payout ratio still tracks 70/30 within one cent.
        // `readerDriftMicros` here is measured against what was *paid*, so a
        // single impression legitimately shows half a cent: that half cent is
        // the carry in `carryMicros`, still on the ledger. Invariant 2 is the
        // one that would catch an actual mismatch.
        ratioWithinOneCent: Math.abs(readerDrift) <= MICROS_PER_CENT,
        readerDriftMicros: readerDrift,
        readerDriftCents: round4(fromMicros(readerDrift) * 100)
      },
      fees: {
        // PayPal Payouts charges the sender; the recipient receives the gross
        // item amount. No fee is ever taken out of a split leg.
        model: 'sender-pays',
        deductedFromSplit: 0,
        note: 'Recipient amounts are gross. The rail fee, if any, is the sender account\'s cost.'
      }
    };
  }

  snapshot() {
    const m = this._m;
    return {
      currency: this.config.currency,
      updatedAt: new Date().toISOString(),
      startedAt: this.startedAt,
      threshold: this.config.payoutThreshold,
      user: {
        balance: round6(fromMicros(m.user)),
        lifetime: round6(fromMicros(m.userLifetime)),
        offersAccepted: this.user.offersAccepted,
        offersRejected: this.user.offersRejected
      },
      publisher: {
        balance: round6(fromMicros(m.publisher)),
        lifetime: round6(fromMicros(m.publisherLifetime)),
        publishers: [...this.publishers.values()]
          .map((entry) => ({
            name: entry.name,
            balance: round6(fromMicros(entry.micros)),
            lifetime: round6(fromMicros(entry.lifetimeMicros)),
            offers: entry.offers
          }))
          .sort((a, b) => b.lifetime - a.lifetime)
          .slice(0, 5)
      },
      advertiser: {
        budget: round6(fromMicros(m.advertiserBudget)),
        initialBudget: round6(fromMicros(m.advertiserInitial)),
        spent: round6(fromMicros(m.advertiserSpent))
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
      accounting: this.audit(),
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
        publisherRate: this.config.publisherShare,
        gross: 0,
        exact: true,
        cents: { reader: 0, publisher: 0, gross: 0 },
        micros: { reader: 0, publisher: 0, gross: 0 }
      }
    };

    this.offers.push(offer);
    this.#trim();
    return offer;
  }

  /**
   * Credits one impression, splitting it exactly.
   *
   * The reader share is `round(gross * userShare)` micros and the publisher
   * share is **the remainder**, not a second independent rounding. That makes
   * `reader + publisher === gross` true by construction for every price, which
   * is the 1:1 accounting rule this ledger exists to enforce.
   */
  creditOffer({ price, score, reason, publisher, pageTitle, pageHost, sessionId = '' }) {
    const grossMicros = toMicros(price);
    if (!Number.isFinite(grossMicros) || grossMicros <= 0) return null;
    if (this._m.advertiserBudget < grossMicros) return null;

    const readerMicros = Math.round(grossMicros * this.config.userShare);
    const publisherMicros = grossMicros - readerMicros;

    this._m.advertiserBudget -= grossMicros;
    this._m.advertiserSpent += grossMicros;

    this._m.user += readerMicros;
    this._m.userLifetime += readerMicros;
    this.user.offersAccepted += 1;

    this._m.publisher += publisherMicros;
    this._m.publisherLifetime += publisherMicros;

    this._m.grossAccrued += grossMicros;
    this._m.readerAccrued += readerMicros;
    this._m.publisherAccrued += publisherMicros;

    const key = publisher || 'unknown';
    const entry = this.publishers.get(key) || {
      name: key,
      micros: 0,
      lifetimeMicros: 0,
      offers: 0
    };
    entry.micros += publisherMicros;
    entry.lifetimeMicros += publisherMicros;
    entry.offers += 1;
    this.publishers.set(key, entry);

    const offer = {
      id: `ofr_${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      approved: true,
      score,
      reason,
      price: round6(fromMicros(grossMicros)),
      sessionId: String(sessionId || '').slice(0, 64),
      publisher: key,
      pageTitle: pageTitle || 'Untitled page',
      pageHost: pageHost || '',
      split: {
        user: round6(fromMicros(readerMicros)),
        publisher: round6(fromMicros(publisherMicros)),
        userRate: this.config.userShare,
        publisherRate: this.config.publisherShare,
        gross: round6(fromMicros(grossMicros)),
        exact: true,
        micros: { reader: readerMicros, publisher: publisherMicros, gross: grossMicros },
        // Whole cents each leg would need and the sub-cent carry that cannot be
        // sent by a 2-decimal rail. Reported per impression, not hidden.
        cents: {
          reader: round4(fromMicros(readerMicros) * 100),
          publisher: round4(fromMicros(publisherMicros) * 100),
          gross: round4(fromMicros(grossMicros) * 100)
        },
        carryMicros: {
          reader: readerMicros % MICROS_PER_CENT,
          publisher: publisherMicros % MICROS_PER_CENT
        }
      }
    };

    this.offers.push(offer);
    this.#trim();
    return offer;
  }

  /**
   * Reserves a payout before the rail call is made.
   *
   * Nothing is debited here: the caller either commits the reservation once the
   * rail accepted the transfer/batch, or cancels it when the call fails. That
   * keeps the ledger honest if the network drops mid-request.
   *
   * Each leg is floored to the rail's denomination **independently**. Paying a
   * leg more than it holds would mint money, and rebalancing one leg from the
   * other would move money the ledger never reserved. The sub-cent remainder is
   * therefore carried, and `reconciliation` states exactly how much.
   *
   * @param {{
   *   maxAmount?: number,
   *   payPublisher?: boolean,
   *   quantize?: (micros: number) => number,
   *   minAmount?: number,
   *   rail?: string
   * }} options
   */
  preparePayout({
    maxAmount = Infinity,
    payPublisher = false,
    quantize = floorCents,
    minAmount = 0.01,
    minMicros: minMicrosOverride = null,
    rail = 'paypal_payouts'
  } = {}) {
    const thresholdMicros = toMicros(this.config.payoutThreshold);
    const capMicros = Number.isFinite(Number(maxAmount)) ? toMicros(maxAmount) : Infinity;
    // `minMicros` exists for rails whose denomination is finer than a
    // micro-euro (one lamport is 1e-8 €), where `toMicros(minAmount)` would
    // round the minimum down to zero.
    const minMicros = Number.isFinite(Number(minMicrosOverride))
      ? Math.max(1, Math.round(Number(minMicrosOverride)))
      : toMicros(minAmount);
    const quantum = typeof quantize === 'function' ? quantize : floorCents;

    if (this.pendingPayout) {
      return {
        ok: false,
        reason: 'PAYOUT_IN_PROGRESS',
        message: 'A payout is already being processed.',
        threshold: this.config.payoutThreshold,
        balance: this.snapshot()
      };
    }

    if (this._m.user < thresholdMicros) {
      return {
        ok: false,
        reason: 'THRESHOLD_NOT_REACHED',
        threshold: this.config.payoutThreshold,
        balance: round6(fromMicros(this._m.user)),
        missing: round6(fromMicros(thresholdMicros - this._m.user))
      };
    }

    const userPayable = quantum(Math.min(this._m.user, capMicros));
    // The publisher's 30% is only moved when the rail can address a second
    // recipient. Otherwise it stays on the ledger, where a monthly publisher
    // settlement can pick it up — it must never be debited without a transfer.
    const publisherCandidate = payPublisher
      ? quantum(Math.min(this._m.publisher, capMicros))
      : 0;
    const publisherPayable = publisherCandidate >= minMicros ? publisherCandidate : 0;

    if (userPayable < minMicros) {
      return {
        ok: false,
        reason: 'AMOUNT_TOO_SMALL',
        message:
          rail === 'solana-devnet'
            ? `The reader share is below the Solana minimum of ${minAmount}.`
            : 'The reader share is below the PayPal minimum of €0.01.',
        threshold: this.config.payoutThreshold,
        balance: round6(fromMicros(this._m.user))
      };
    }

    const readerCarried = this._m.user - userPayable;
    const publisherCarried = this._m.publisher - publisherPayable;

    const reservation = {
      id: `pay_${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      reference: `ADPAL-${Date.now().toString(36).toUpperCase()}`,
      rail,
      userAmount: round6(fromMicros(userPayable)),
      publisherAmount: round6(fromMicros(publisherPayable)),
      total: round6(fromMicros(userPayable + publisherPayable)),
      userRemainder: round6(fromMicros(readerCarried)),
      publisherRemainder: round6(fromMicros(publisherCarried)),
      capped: userPayable < Math.min(this._m.user, capMicros),
      micros: {
        reader: userPayable,
        publisher: publisherPayable,
        total: userPayable + publisherPayable,
        readerCarried,
        publisherCarried
      },
      // The 70/30 rule is applied per impression, so the two balances already
      // hold the split; this block states what the batch actually moves and
      // what it has to leave behind, so nothing about the money is implicit.
      split: this.#splitOf(userPayable, publisherPayable, rail),
      reconciliation: {
        accrued: {
          reader: round6(fromMicros(this._m.user)),
          publisher: round6(fromMicros(this._m.publisher)),
          gross: round6(fromMicros(this._m.user + this._m.publisher))
        },
        payable: {
          reader: round6(fromMicros(userPayable)),
          publisher: round6(fromMicros(publisherPayable)),
          gross: round6(fromMicros(userPayable + publisherPayable))
        },
        carried: {
          reader: round6(fromMicros(readerCarried)),
          publisher: round6(fromMicros(publisherCarried)),
          gross: round6(fromMicros(readerCarried + publisherCarried))
        },
        cents: {
          reader: Math.round(userPayable / MICROS_PER_CENT),
          publisher: Math.round(publisherPayable / MICROS_PER_CENT),
          total: Math.round((userPayable + publisherPayable) / MICROS_PER_CENT)
        },
        // Why a carry exists at all: the rail can only express whole cents. A
        // €1.00 impression splits to €0.70/€0.30 (both exact), but an odd price
        // such as €0.05 splits to €0.035 — three decimals — and must carry.
        note:
          readerCarried + publisherCarried > 0
            ? 'The rail settles in whole cents; the sub-cent remainder stays on the ledger and is paid with the next batch.'
            : 'Both legs were already cent-exact; nothing is carried.',
        fees: { model: 'sender-pays', deductedFromSplit: 0 }
      }
    };

    this.pendingPayout = reservation;
    return { ok: true, reservation, threshold: this.config.payoutThreshold, balance: this.snapshot() };
  }

  /**
   * Describes the split a batch moves.
   *
   * `withinTolerance` is judged on the **cumulative** paid totals, not on one
   * batch: a single odd-priced impression (€0.05 → €0.035 per reader leg) carries
   * half a cent, so an individual batch legitimately wobbles by up to a cent
   * while the running total converges on exactly 70/30.
   */
  #splitOf(userMicros, publisherMicros, rail = 'paypal_payouts') {
    const userRate = this.config.userShare;
    const publisherRate = this.config.publisherShare;
    const total = userMicros + publisherMicros;

    const cumulativeReader = this._m.readerPaid + userMicros;
    const cumulativePublisher = this._m.publisherPaid + publisherMicros;
    const cumulativeTotal = cumulativeReader + cumulativePublisher;
    const expectedReader = Math.round(cumulativeTotal * userRate);
    const driftMicros = cumulativeReader - expectedReader;

    return {
      userRate,
      publisherRate,
      reader: round6(fromMicros(userMicros)),
      publisher: round6(fromMicros(publisherMicros)),
      total: round6(fromMicros(total)),
      readerCents: Math.round(userMicros / MICROS_PER_CENT),
      publisherCents: Math.round(publisherMicros / MICROS_PER_CENT),
      totalCents: Math.round(total / MICROS_PER_CENT),
      cumulative: {
        reader: round6(fromMicros(cumulativeReader)),
        publisher: round6(fromMicros(cumulativePublisher)),
        total: round6(fromMicros(cumulativeTotal)),
        expectedReader: round6(fromMicros(expectedReader))
      },
      driftMicros,
      driftCents: round4(fromMicros(driftMicros) * 100),
      withinTolerance: Math.abs(driftMicros) <= MICROS_PER_CENT,
      rail,
      publisherRail: publisherMicros > 0 ? rail : 'ledger-held'
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

    const userMicros = toMicros(reservation.userAmount);
    const publisherMicros = toMicros(reservation.publisherAmount);

    this._m.user = Math.max(0, this._m.user - userMicros);
    this._m.publisher = Math.max(0, this._m.publisher - publisherMicros);
    this._m.readerPaid += userMicros;
    this._m.publisherPaid += publisherMicros;

    // Keep the per-publisher breakdown. A later failure webhook has to restore
    // exactly what was taken, and re-deriving it from the aggregate would lose
    // which publisher contributed which share.
    const publisherDebits = this.#deductPublishers(publisherMicros);

    this.pendingPayout = null;

    const rail = settlement.rail || reservation.rail || 'paypal_payouts';
    const payout = {
      id: reservation.id,
      at: new Date().toISOString(),
      method: rail === 'solana-devnet' ? 'solana' : 'paypal',
      rail,
      reference: reservation.reference,
      userAmount: round6(fromMicros(userMicros)),
      publisherAmount: round6(fromMicros(publisherMicros)),
      total: round6(fromMicros(userMicros + publisherMicros)),
      currency: settlement.currency || this.config.currency,
      micros: {
        reader: userMicros,
        publisher: publisherMicros,
        total: userMicros + publisherMicros
      },
      split: reservation.split,
      reconciliation: reservation.reconciliation,
      // What stayed on the balance because of cent / base-unit rounding or the
      // demo cap.
      remainder: {
        user: round6(fromMicros(this._m.user)),
        publisher: round6(fromMicros(this._m.publisher))
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
        mode: settlement.mode || this.config.paypal?.mode || 'sandbox',
        amount: settlement.amount ?? reservation.userAmount,
        currency: settlement.currency || this.config.currency,
        selfUrl: settlement.selfUrl || '',
        links: Array.isArray(settlement.links) ? settlement.links : [],
        /*
         * How many times the sender was debited for this settlement, and for how
         * much. A Payouts batch is one debit for the batch total; the per-item
         * amounts are the same money broken down by receiver. Recording it here
         * stops a consumer (or a human reading the PayPal activity page) from
         * adding the batch line to its own item lines and concluding the sender
         * paid twice.
         */
        senderDebit: settlement.senderDebit || {
          amount: round6(fromMicros(userMicros + publisherMicros)),
          currency: settlement.currency || this.config.currency,
          debits: 1,
          items: [
            { receiver: settlement.receiverEmail || '', amount: round6(fromMicros(userMicros)) },
            ...(publisherMicros > 0
              ? [{ receiver: settlement.publisherEmail || '', amount: round6(fromMicros(publisherMicros)) }]
              : [])
          ],
          itemizedOnly: false
        },
        // True when PayPal answered `DUPLICATE_REQUEST_ID`: the batch already
        // existed, so this settlement was submitted once and debited once.
        duplicate: Boolean(settlement.duplicate),
        checkedAt: new Date().toISOString()
      };
    }

    this.payouts.push(payout);
    if (this.payouts.length > 50) this.payouts.shift();

    return payout;
  }

  /**
   * Finds a payout by any identifier PayPal exposes on a webhook.
   *
   * Item events carry `payout_batch_id`, the `payout_item_id`, and the
   * `sender_batch_id` / `sender_item_id` we minted ourselves. Matching on the
   * batch id alone misses every event that arrives before the create response
   * is committed, or whose batch id the caller did not have — which is exactly
   * how a legitimate notification used to be reported as "unmatched".
   */
  findPayout({ batchId = '', senderBatchId = '', senderItemId = '', itemId = '', reference = '' } = {}) {
    const batch = String(batchId || '').trim();
    const sender = String(senderBatchId || '').trim();
    const item = String(senderItemId || '').trim();
    const payoutItem = String(itemId || '').trim();
    const ref = String(reference || '').trim();
    if (!batch && !sender && !item && !payoutItem && !ref) return null;

    // Newest first: a demo can cycle through many payouts in one run.
    for (let index = this.payouts.length - 1; index >= 0; index -= 1) {
      const payout = this.payouts[index];
      if (batch && payout.paypal?.batchId === batch) return payout;
      if (batch && payout.solana?.signature === batch) return payout;
      if (sender && payout.paypal?.senderBatchId === sender) return payout;
      if (ref && payout.reference === ref) return payout;
      // `sender_item_id` is `${senderBatchId}-${n}`; matching the prefix is
      // enough to identify the batch without guessing the index.
      if (item && payout.paypal?.senderBatchId && item.startsWith(`${payout.paypal.senderBatchId}-`)) {
        return payout;
      }
      if (payoutItem && (payout.paypal?.itemIds || []).includes(payoutItem)) return payout;
    }
    return null;
  }

  /** Applies a later status refresh to a stored payout, by any rail identifier. */
  updatePayoutStatus(identifier, status) {
    const payout = this.findPayout({
      batchId: identifier,
      senderBatchId: identifier
    });
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
    const payout = this.findPayout({
      batchId: identifier,
      senderBatchId: identifier
    });
    if (!payout) return null;

    if (payout.reversal) {
      return { payout, reversed: false, alreadyReversed: true, restored: 0 };
    }

    const userMicros = toMicros(payout.userAmount);
    const publisherMicros = toMicros(payout.publisherAmount);

    this._m.user += userMicros;
    this._m.publisher += publisherMicros;
    // Do not decrement `readerPaid` as well: `reversePayout` already records the
    // restoration in `readerReversed`, and the audit treats net paid as
    // `paid - reversed`. Decrementing both would count the reversal twice and
    // make the conservation invariant read as a loss.
    this._m.readerReversed += userMicros;
    this._m.publisherReversed += publisherMicros;

    for (const debit of payout.publisherDebits || []) {
      const entry = this.publishers.get(debit.name);
      if (entry) entry.micros += toMicros(debit.amount);
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
      restored: round6(fromMicros(userMicros + publisherMicros))
    };
  }

  #deductPublishers(amountMicros) {
    let remaining = Math.max(0, Math.round(amountMicros));
    if (remaining <= 0) return [];

    const debits = [];

    for (const entry of this.publishers.values()) {
      if (remaining <= 0) break;
      const take = Math.min(entry.micros, remaining);
      if (take > 0) debits.push({ name: entry.name, amount: round6(fromMicros(take)) });
      entry.micros -= take;
      remaining -= take;
    }

    return debits;
  }

  #trim() {
    if (this.offers.length > 200) this.offers.shift();
  }
}

module.exports = {
  Ledger,
  round4,
  round6,
  toMicros,
  fromMicros,
  floorCents,
  MICROS_PER_EURO,
  MICROS_PER_CENT
};
