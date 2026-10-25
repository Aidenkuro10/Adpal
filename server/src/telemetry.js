'use strict';

/**
 * In-memory telemetry ring buffer with live subscribers.
 *
 * Records the negotiation pipeline step by step so a client can either poll it
 * (`GET /api/telemetry?since=<seq>`) or subscribe to it (`GET /api/logs`, SSE):
 * offer request → validation → bot checks → score → L402 challenge/macaroon →
 * creative assignment → ledger split → PayPal payout.
 *
 * Subscribers receive every event as it is emitted, with a sequence number, so
 * the terminal view can show the raw structured JSON without polling.
 */

class Telemetry {
  constructor(limit = 500) {
    this.limit = limit;
    this.listeners = new Set();
    this.reset();
  }

  reset() {
    this.seq = 0;
    this.events = [];
  }

  emit({ stage, source, level = 'info', title, detail = '', data = null }) {
    const event = {
      seq: (this.seq += 1),
      at: new Date().toISOString(),
      stage,
      source,
      level,
      title,
      detail,
      data
    };

    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }

    this.#publish(event);
    return event;
  }

  since(cursor, limit = 40) {
    const events = this.events.filter((event) => event.seq > cursor);
    return events.slice(-limit);
  }

  /**
   * Registers a listener for all future events.
   * @param {(event: object) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get subscriberCount() {
    return this.listeners.size;
  }

  #publish(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A broken consumer (a closed SSE socket, for example) must never take
        // down the negotiation pipeline that produced the event.
        console.error('[telemetry] subscriber failed:', error?.message || error);
        this.listeners.delete(listener);
      }
    }
  }
}

module.exports = { Telemetry };
