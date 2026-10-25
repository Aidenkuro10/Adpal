'use strict';

/**
 * Reconciliation of incoming PayPal payout events.
 *
 * Extracted from `server.js` so the matching rules can be tested without a
 * signed webhook. The bug this module exists to fix: the route used to match a
 * notification on `payout_batch_id` alone. Item events that arrive before our
 * create-response is committed — or that carry only the `sender_batch_id` we
 * minted — therefore fell through to "Webhook acknowledged · no matching
 * payout", which is confusing on stage and wrong in the ledger.
 *
 * Three behaviours:
 *
 *  1. Match on **any** identifier PayPal sends (batch id, sender batch id,
 *     sender item id, payout item id, our own reference).
 *  2. When nothing matches yet, **hold** the event and replay it the moment the
 *     payout is committed, instead of dropping it.
 *  3. Apply terminal failures exactly once (reversal is idempotent in the
 *     ledger), so a retried webhook cannot return the same money twice.
 */
function createWebhookReconciler({
  ledger,
  report = () => {},
  money = (value) => Number(value).toFixed(2),
  terminalFailures = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'CANCELED', 'REFUNDED']),
  pendingTtlMs = 10 * 60 * 1000,
  pendingLimit = 100
} = {}) {
  /** Events that arrived before their payout existed. Keyed by every id. */
  const pending = new Map();

  function prune(now = Date.now()) {
    for (const [key, entry] of pending) {
      if (now - entry.at > pendingTtlMs) pending.delete(key);
    }
    while (pending.size > pendingLimit) {
      pending.delete(pending.keys().next().value);
    }
  }

  /**
   * Applies one payout event to whatever ledger entry it identifies.
   *
   * @param {{ eventType: string, status: string, identifiers: object }} input
   * @returns {null | { payout: object, reversal: object|null, outcome: string }}
   */
  function apply({ eventType, status, identifiers }) {
    const matched = ledger.findPayout(identifiers);
    if (!matched) return null;

    // Prefer the identifier the ledger itself stores: `findPayout` accepts
    // several shapes, but the update helpers key on the canonical one.
    const key =
      matched.paypal?.batchId ||
      identifiers.batchId ||
      matched.paypal?.senderBatchId ||
      identifiers.senderBatchId ||
      matched.reference;

    if (terminalFailures.has(status)) {
      const result = ledger.reversePayout(key, { reason: eventType });
      if (result?.reversed) {
        return {
          payout: result.payout,
          reversal: { reversed: true, restored: result.restored },
          outcome: 'handled'
        };
      }
      if (result?.alreadyReversed) {
        return {
          payout: result.payout,
          reversal: { reversed: false, restored: 0 },
          outcome: 'duplicate'
        };
      }
      return {
        payout: matched,
        reversal: { reversed: false, restored: 0 },
        outcome: 'already-final'
      };
    }

    const payout = ledger.updatePayoutStatus(key, status);
    return {
      payout,
      reversal: { reversed: false, restored: 0 },
      outcome: payout ? 'handled' : 'unmatched'
    };
  }

  /**
   * Handles one event end to end, buffering it when the payout is not there yet.
   *
   * @returns {{ outcome: string, payout: object|null, reversal: object|null, deferred: boolean, pending: number }}
   */
  function receive({ eventId, eventType, status, identifiers }) {
    const applied = apply({ eventType, status, identifiers });
    if (applied) {
      return { ...applied, deferred: false, pending: pending.size };
    }

    const keys = [
      identifiers.batchId,
      identifiers.senderBatchId,
      identifiers.itemId,
      identifiers.senderItemId
    ].filter(Boolean);

    if (!keys.length) {
      // Nothing to key on: genuinely unattributable, so say so.
      return { outcome: 'unmatched', payout: null, reversal: null, deferred: false, pending: pending.size };
    }

    const entry = { eventId: eventId || '', eventType, status, identifiers, at: Date.now() };
    for (const key of keys) pending.set(key, entry);
    prune();

    return {
      outcome: 'deferred',
      payout: null,
      reversal: null,
      deferred: true,
      pending: pending.size
    };
  }

  /**
   * Replays any buffered event belonging to a freshly committed payout.
   * Called in the same tick as `commitPayout`, so the terminal shows the late
   * webhook resolving instead of a stale warning.
   *
   * @returns {number} how many buffered events were applied
   */
  function flush(payout) {
    if (!payout) return 0;
    prune();

    const keys = [
      payout.paypal?.batchId,
      payout.paypal?.senderBatchId,
      payout.reference
    ].filter(Boolean);

    let applied = 0;
    const done = new Set();

    for (const key of keys) {
      const entry = pending.get(key);
      if (!entry || done.has(entry)) continue;
      done.add(entry);

      // Remove every alias so the same event cannot replay twice.
      for (const [alias, candidate] of pending) {
        if (candidate === entry) pending.delete(alias);
      }

      const result = apply(entry);
      if (!result) continue;
      applied += 1;

      report({
        stage: 'paypal.webhook',
        source: 'paypal.webhook',
        level: 'ok',
        title: `Early webhook reconciled · payout ${entry.status}`,
        detail: `${entry.eventType} · matched to ${payout.paypal?.batchId || payout.reference} on arrival #2`,
        data: {
          eventId: entry.eventId,
          eventType: entry.eventType,
          outcome: result.outcome,
          batchId: payout.paypal?.batchId || '',
          payoutId: payout.id,
          deferred: true
        }
      });
    }

    return applied;
  }

  return {
    apply,
    receive,
    flush,
    prune,
    clear: () => pending.clear(),
    get size() {
      return pending.size;
    }
  };
}

module.exports = { createWebhookReconciler };
