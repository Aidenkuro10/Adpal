'use strict';

/**
 * Live reader presence.
 *
 * The simulator must never move money or sell an impression while nobody is
 * reading. This registry is the single source of truth for "is a frontend
 * session alive right now", and every value-touching route consults it:
 *
 *   POST /api/offer      → refuses unless the caller has a live session
 *   auto payout          → re-checks before executing, cancels if the reader left
 *
 * There is deliberately **no timer**: a heartbeat interval would be a background
 * loop that outlives the user. Expiry is computed on read (`prune()`), so an
 * idle server holds stale records for one access at most and never wakes up on
 * its own to do work.
 *
 * A session is keyed by the installation id the extension already sends on both
 * `/api/offer` and `/api/client-event`, so nothing new has to be provisioned on
 * the client — only a periodic ping while the page is actually visible.
 */
class Presence {
  /**
   * @param {{ ttlMs?: number, maxSessions?: number }} options
   */
  constructor({ ttlMs = 12_000, maxSessions = 200 } = {}) {
    this.ttlMs = Math.max(2_000, Number(ttlMs) || 12_000);
    this.maxSessions = Math.max(1, Number(maxSessions) || 200);
    this.sessions = new Map();
    // Bumped by /api/dev/reset. Queued work captured under an older epoch is
    // abandoned instead of landing in a fresh run — see server.js.
    this.epoch = 1;
  }

  /**
   * Records activity for a session.
   *
   * `state` is the page's own visibility claim: only `active` counts as
   * presence. A hidden tab keeps its record (so the terminal can show
   * "reader left") but cannot buy an impression or trigger a payout.
   *
   * @param {{
   *   clientId: string,
   *   state?: 'active' | 'hidden' | 'closing',
   *   page?: { title?: string, host?: string },
   *   slot?: string,
   *   userAgent?: string
   * }} input
   */
  touch({ clientId, state = 'active', page = {}, slot = '', userAgent = '' } = {}) {
    const id = String(clientId || '').trim().slice(0, 64);
    if (!id) return { ok: false, reason: 'MISSING_CLIENT_ID' };

    const now = Date.now();
    const normalized =
      state === 'closing' ? 'closing' : state === 'hidden' ? 'hidden' : 'active';

    if (normalized === 'closing') {
      this.sessions.delete(id);
      return { ok: true, ended: true, clientId: id };
    }

    const prior = this.sessions.get(id);
    this.sessions.set(id, {
      clientId: id,
      firstSeenAt: prior?.firstSeenAt || now,
      lastSeenAt: now,
      state: normalized,
      pageTitle: String(page?.title || prior?.pageTitle || '').slice(0, 120),
      pageHost: String(page?.host || prior?.pageHost || '').slice(0, 120),
      slot: String(slot || prior?.slot || '').slice(0, 40),
      userAgent: String(userAgent || prior?.userAgent || '').slice(0, 160)
    });

    // Bounded registry: drop the least-recently-seen entries, never the one we
    // just touched. `prune()` already removed anything past the TTL.
    if (this.sessions.size > this.maxSessions) {
      const ordered = [...this.sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
      for (const stale of ordered.slice(0, this.sessions.size - this.maxSessions)) {
        if (stale.clientId !== id) this.sessions.delete(stale.clientId);
      }
    }

    return {
      ok: true,
      clientId: id,
      state: normalized,
      ttlMs: this.ttlMs,
      expiresInMs: this.ttlMs
    };
  }

  /** Drops records past the TTL. Called on read, never on a timer. */
  prune(now = Date.now()) {
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenAt > this.ttlMs) this.sessions.delete(id);
    }
  }

  get(clientId) {
    this.prune();
    return this.sessions.get(String(clientId || '').trim()) || null;
  }

  /**
   * True only when the session exists, is visible, and is inside the TTL.
   * `ageMs` is returned either way so a refusal can explain itself.
   */
  requireActive(clientId) {
    this.prune();
    const id = String(clientId || '').trim();
    if (!id) {
      return { ok: false, reason: 'MISSING_CLIENT_ID', ageMs: null, activeCount: this.sessions.size };
    }
    const session = this.sessions.get(id);
    if (!session) {
      return { ok: false, reason: 'NO_SESSION', ageMs: null, activeCount: this.sessions.size };
    }
    const ageMs = Date.now() - session.lastSeenAt;
    if (session.state !== 'active') {
      return { ok: false, reason: 'TAB_NOT_VISIBLE', ageMs, session, activeCount: this.sessions.size };
    }
    if (ageMs > this.ttlMs) {
      return { ok: false, reason: 'STALE_HEARTBEAT', ageMs, session, activeCount: this.sessions.size };
    }
    return { ok: true, session, ageMs, activeCount: this.sessions.size };
  }

  isActive(clientId) {
    return this.requireActive(clientId).ok;
  }

  /** Live sessions only, newest first — read by the terminal header. */
  list() {
    this.prune();
    return [...this.sessions.values()]
      .filter((session) => session.state === 'active')
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((session) => ({
        clientId: session.clientId,
        since: new Date(session.firstSeenAt).toISOString(),
        lastSeenAt: new Date(session.lastSeenAt).toISOString(),
        ageMs: Date.now() - session.lastSeenAt,
        pageTitle: session.pageTitle,
        pageHost: session.pageHost,
        slot: session.slot
      }));
  }

  snapshot() {
    this.prune();
    return {
      ttlMs: this.ttlMs,
      epoch: this.epoch,
      live: this.list().length,
      sessions: this.list().slice(0, 8)
    };
  }

  /** Starts a new run: every session and any queued work is invalidated. */
  reset() {
    this.sessions.clear();
    this.epoch += 1;
    return this.epoch;
  }
}

module.exports = { Presence };
