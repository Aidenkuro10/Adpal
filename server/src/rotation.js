'use strict';

/**
 * Multi-advertiser rotation.
 *
 * The simulator used to bind one creative to one placement for the whole run,
 * which made the page look like a single static banner. Rotation gives every
 * advertiser profile a campaign budget and picks the next eligible one:
 *
 *  - round-robin across profiles, so consecutive impressions differ;
 *  - the last creative shown in a given slot is excluded, so a slot rotates to
 *    a *different* advertiser rather than repeating itself;
 *  - a profile whose campaign budget cannot cover the price is skipped;
 *  - ties are broken by fewest impressions, so spend stays even.
 *
 * The rotation is per-slot: the sidebar rail and the mid-article line can show
 * two different sponsors at the same moment, which is the realistic behaviour
 * for a publication with several placements.
 */

const { CREATIVES } = require('./creatives');

function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

class AdvertiserRotation {
  /**
   * @param {{ creatives?: ReadonlyArray<object>, minPrice?: number }} options
   */
  constructor({ creatives = CREATIVES, minPrice = 0.001 } = {}) {
    this.minPrice = minPrice;
    this.roster = creatives.map((creative) => ({
      id: creative.id,
      sponsor: creative.sponsor,
      theme: creative.theme,
      agent: { ...creative.agent },
      budget: round4(creative.campaign?.budget ?? 10),
      initialBudget: round4(creative.campaign?.budget ?? 10),
      objective: creative.campaign?.objective || 'reach',
      impressions: 0,
      spend: 0,
      lastShownAt: null
    }));
    this.creatives = creatives;
    this.cursor = 0;
    /** @type {Map<string, string>} slotKey → creative id */
    this.lastBySlot = new Map();
    /** @type {Map<string, number>} creative id → impressions in this run */
    this.impressionsById = new Map();
  }

  reset() {
    for (const entry of this.roster) {
      entry.budget = entry.initialBudget;
      entry.impressions = 0;
      entry.spend = 0;
      entry.lastShownAt = null;
    }
    this.cursor = 0;
    this.lastBySlot.clear();
    this.impressionsById.clear();
  }

  /** Campaign budget the advertiser agent can still authorize. */
  remaining(advertiserId) {
    const entry = this.roster.find((item) => item.agent.id === advertiserId);
    return entry ? round4(entry.budget) : 0;
  }

  /** Sum of every campaign budget, i.e. the aggregate advertiser escrow. */
  totalBudget({ initial = false } = {}) {
    return round4(
      this.roster.reduce(
        (sum, entry) => sum + (initial ? entry.initialBudget : entry.budget),
        0
      )
    );
  }

  /**
   * Profiles that can still fund this placement, in roster order.
   *
   * `excludeShown` removes the creative this slot just displayed. `pick()` uses
   * the full list because a spent-out roster must still fall back to the last
   * advertiser; `candidates()` excludes it because the cognition layer should
   * only rank profiles the rotation is willing to show next.
   */
  eligibleEntries({ price = this.minPrice, slotKey = 'page', excludeCreativeId = '', excludeShown = false } = {}) {
    const minimum = Math.max(0.01, Number(price) || 0);
    const excluded = new Set(
      excludeShown
        ? [this.lastBySlot.get(slotKey) || '', String(excludeCreativeId || '')].filter(Boolean)
        : []
    );

    return this.roster.filter(
      (entry) => entry.budget + 1e-9 >= minimum && !excluded.has(entry.id)
    );
  }

  /**
   * Profiles the advertiser agents may reason over for this placement.
   * Read-only: nothing is reserved, spent or rotated by calling it.
   */
  candidates({ slotKey = 'page', price = this.minPrice, excludeCreativeId = '' } = {}) {
    return this.eligibleEntries({
      slotKey,
      price,
      excludeCreativeId,
      excludeShown: true
    }).map((entry) => ({
      agent: { ...entry.agent },
      sponsor: entry.sponsor,
      creative: this.creatives[this.roster.indexOf(entry)],
      objective: entry.objective,
      budgetRemaining: round4(entry.budget),
      impressions: entry.impressions
    }));
  }

  /**
   * Picks the next advertiser for a slot.
   *
   * `prefer` lets the cognition layer name the winner it reasoned to. The
   * rotation still owns eligibility and the no-repeat rule, so a stale or
   * ineligible preference can never break the placement invariants.
   *
   * @param {{ slotKey?: string, price?: number, excludeCreativeId?: string, prefer?: string }} input
   * @returns {null | { creative: object, advertiser: object, reason: string }}
   */
  pick({ slotKey = 'page', price = this.minPrice, excludeCreativeId = '', prefer = '' } = {}) {
    const eligible = this.eligibleEntries({ price });
    if (eligible.length === 0) return null;

    const excluded = new Set(
      [this.lastBySlot.get(slotKey) || '', String(excludeCreativeId || '')].filter(Boolean)
    );

    // Least-shown first, then round-robin order so the sequence stays legible
    // in the terminal instead of jumping around the roster.
    const ordered = [...eligible].sort((a, b) => {
      const shownA = this.impressionsById.get(a.agent.id) || 0;
      const shownB = this.impressionsById.get(b.agent.id) || 0;
      if (shownA !== shownB) return shownA - shownB;
      const orderA = (this.roster.indexOf(a) - this.cursor + this.roster.length) % this.roster.length;
      const orderB = (this.roster.indexOf(b) - this.cursor + this.roster.length) % this.roster.length;
      return orderA - orderB;
    });

    // Prefer a profile this slot has not just shown; fall back to any eligible
    // one when the only remaining budget belongs to the previous advertiser.
    const fresh = ordered.find((entry) => !excluded.has(entry.id));
    const named = prefer ? ordered.find((entry) => entry.agent.id === prefer) : null;
    const reasoned = named && !excluded.has(named.id) ? named : null;
    const chosen = reasoned || fresh || ordered[0];

    const index = this.roster.findIndex((entry) => entry.agent.id === chosen.agent.id);
    this.cursor = (index + 1) % this.roster.length;

    return {
      creative: this.creatives[index],
      advertiser: {
        ...chosen.agent,
        sponsor: chosen.sponsor,
        creativeId: chosen.id,
        objective: chosen.objective,
        budgetRemaining: round4(chosen.budget)
      },
      reason: reasoned
        ? 'agent reasoning · highest relevant bid'
        : fresh
          ? 'rotation · least-shown eligible advertiser'
          : 'rotation · only advertiser with budget left'
    };
  }

  /**
   * Books an impression against the chosen advertiser. Called only once the
   * offer has been credited, so a refused offer never consumes campaign money.
   */
  record({ slotKey = 'page', advertiserId, creativeId, price, at = Date.now() }) {
    const entry = this.roster.find((item) => item.agent.id === advertiserId);
    if (!entry) return null;

    entry.budget = round4(Math.max(0, entry.budget - price));
    entry.spend = round4(entry.spend + price);
    entry.impressions += 1;
    entry.lastShownAt = new Date(at).toISOString();

    this.impressionsById.set(advertiserId, (this.impressionsById.get(advertiserId) || 0) + 1);
    if (creativeId) this.lastBySlot.set(slotKey, creativeId);

    return this.describe(entry);
  }

  describe(entry) {
    return {
      creativeId: entry.id,
      sponsor: entry.sponsor,
      agent: { ...entry.agent },
      budget: round4(entry.budget),
      initialBudget: entry.initialBudget,
      spend: entry.spend,
      impressions: entry.impressions,
      lastShownAt: entry.lastShownAt
    };
  }

  /** Roster for the terminal: who is buying, and how much is left. */
  snapshot() {
    return {
      advertisers: this.roster.map((entry) => this.describe(entry)),
      slots: [...this.lastBySlot.entries()].map(([slotKey, creativeId]) => ({
        slotKey,
        creativeId
      })),
      impressions: [...this.impressionsById.values()].reduce((sum, n) => sum + n, 0)
    };
  }
}

module.exports = { AdvertiserRotation };
