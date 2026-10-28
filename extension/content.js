/* AdPal — content script
 *
 * Passive attention monetization for publisher-declared ad placements.
 *
 *  - Runs only where the publisher exposes a placement: `#adpal-slot` or any
 *    element carrying `[data-adpal-slot]`. A page can declare several, each in
 *    its own scroll position, and each is negotiated independently.
 *  - Every placement stays empty and invisible until human attention has been
 *    validated server-side. No buttons, no countdowns, no overlays, no debug
 *    chips. The article is an article until an offer is accepted.
 *  - Attention is measured in the background from aggregated signals only
 *    (duration, mouse activity, scrolling, tab visibility, window focus).
 *  - Measurement is gated on the placement itself being on screen: scrolling
 *    the unit out of the viewport pauses the timer immediately, because an
 *    impression is only worth paying for while it can actually be seen.
 *  - One negotiation runs at a time across the whole page, so two placements
 *    can never be credited for the same stretch of attention.
 *  - Aggregated telemetry is relayed silently through the service worker to the
 *    simulator, where the dedicated agent terminal (/terminal/) reads it over
 *    SSE. The host page never renders a debug panel. No personal data is
 *    involved: only session-level signals and their attention estimate.
 */

(() => {
  'use strict';

  if (window.__adpalContentLoaded) return;
  window.__adpalContentLoaded = true;

  /* Only one agent may measure a page.
   *
   * A publisher that ships its own agent (`demo-publisher/adpal-agent.js`) marks
   * the document with `data-adpal-page-agent`. That script is part of the page,
   * so it runs during parsing — before this content script's `document_idle` —
   * and it owns the placements from then on. Yielding here is what stops one
   * reading session from being negotiated twice and paid twice.
   *
   * The flag below is the other half of that handshake: a page agent that loads
   * late sees it and stands down instead. */
  if (document.documentElement.dataset.adpalPageAgent === '1') return;
  document.documentElement.dataset.adpalExtension = '1';

  const SLOT_SELECTOR = '#adpal-slot, [data-adpal-slot]';

  const CONFIG = {
    // Matches the server baseline: €1.00 per impression → €0.70 / €0.30.
    price: 1,

    /* Measurement window */
    dwellBeforeStartMs: 2500,
    sessionMs: 6000,
    tickMs: 200,
    stateIntervalMs: 500,
    minNewSignals: 4,

    /* Viewport gating: the placement must be genuinely on screen. */
    viewportThreshold: 0.55,
    virtualSlotHeight: 160,
    outOfViewAbortMs: 4000,
    minSlotVisibleRatio: 0.5,

    /* Impression budget.
     *
     * A placement rotates rather than pinning one advertiser: after a delivered
     * impression it waits `rotateAfterMs`, then negotiates again — the server
     * excludes the creative the slot just showed, so the frame fades to a
     * different sponsor. The per-page cap keeps a long read bounded. */
    maxPerSlot: 3,
    maxImpressionsPerPage: 9,
    rotateAfterMs: 20000,

    /* Retry pacing */
    retryCooldownMs: 10000,
    offlineCooldownMs: 20000,
    pauseCooldownMs: 1500,

    /* Telemetry: one attention sample every few seconds, never per input. */
    attentionReportMs: 8000,

    /*
     * Presence heartbeat. The server refuses an impression without a live,
     * visible session, so this is what makes an offer possible at all. Kept
     * below the server TTL (12 s) so two missed beats still count as present.
     */
    presenceIntervalMs: 4000
  };

  const READY_PHASES = new Set(['idle', 'delivered', 'rejected', 'invalid', 'paused', 'offline']);

  startController();

  function startController() {
    const tracker = createAttentionTracker();
    // Page-wide lock + budget, shared by every placement runtime.
    const coordinator = { busy: false, delivered: 0, started: false };
    const runtimes = [];
    let lastReportAt = 0;

    const initial = collectSlots();
    for (const host of initial) add(host);

    if (runtimes.length > 0) announcePlacements();

    // Single page-wide tick: one interval regardless of how many placements
    // exist, so a long article does not spawn a timer per slot.
    window.setInterval(tick, CONFIG.stateIntervalMs);
    tick();

    startPresence();

    // Single-page apps may mount placements after load; watch briefly.
    const observer = new MutationObserver(() => {
      const before = runtimes.length;
      for (const host of collectSlots()) add(host);
      if (runtimes.length > before) announcePlacements();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 20000);

    function announcePlacements() {
      coordinator.started = true;
      const total = runtimes.length;
      emitClientEvent(
        'info',
        'Publisher placements detected',
        `${total} placement${total === 1 ? '' : 's'} · measured only while on screen`
      );
    }

    function collectSlots() {
      const found = [];
      const seen = new Set();
      for (const element of document.querySelectorAll(SLOT_SELECTOR)) {
        if (seen.has(element)) continue;
        seen.add(element);
        found.push(element);
      }
      return found;
    }

    function add(host) {
      if (!host || host.dataset.adpalBound === '1') return;
      host.dataset.adpalBound = '1';

      // `data-adpal-layout` picks the unit shape and the CSS frame the
      // publisher reserved for it: a line inside a card, a sticky sidebar
      // card, or a full-width partner strip.
      const requested = host.dataset.adpalLayout;
      const layout = requested === 'inline' || requested === 'rail' ? requested : 'banner';
      runtimes.push(
        createRuntime({
          host,
          index: runtimes.length,
          total: () => runtimes.length,
          layout,
          tracker,
          coordinator,
          report: reportAttention
        })
      );
    }

    /**
     * The 500 ms heartbeat.
     *
     * 1. re-measure every placement and refresh its local snapshot;
     * 2. tell the tracker whether ANY placement is on screen (the attention
     *    score is page-level, the impression is per placement);
     * 3. report the placement with the strongest presence, throttled;
     * 4. start at most one negotiation, chosen by the same ordering.
     */
    function tick() {
      const tabVisible = document.visibilityState === 'visible';
      let focus = null;
      let best = -1;

      for (const runtime of runtimes) {
        runtime.refresh();
        const ratio = runtime.viewport.ratio();
        // A placement that has already paid out keeps its frame on screen —
        // the sidebar rail in particular never leaves the viewport. Discount it
        // so the reported attention follows the text the reader is actually on,
        // not the frame that already settled.
        const weight = runtime.budgetLeft() ? ratio : ratio * 0.35;
        if (weight > best) {
          best = weight;
          focus = runtime;
        }
      }

      if (runtimes.length > 0) {
        tracker.setSlotVisible(tabVisible && runtimes.some((runtime) => runtime.viewport.inView()));
      }

      for (const runtime of runtimes) runtime.announce();

      if (focus && focus.snapshot) reportAttention(focus);

      if (coordinator.busy) return;

      for (const runtime of runtimes) {
        if (!runtime.ready()) continue;
        runtime.runSession();
        break;
      }
    }

    /**
     * Sends a compact attention sample to the simulator every few seconds.
     * The publication page renders none of this: it feeds /terminal/.
     */
    function reportAttention(runtime) {
      const now = performance.now();
      if (now - lastReportAt < CONFIG.attentionReportMs) return;
      lastReportAt = now;

      const snapshot = runtime.snapshot;
      sendClientEvent({
        kind: 'attention',
        level: 'info',
        title: `Attention ${snapshot.attention}/100 · ${snapshot.phase}`,
        detail:
          `placement ${runtime.label()} · ` +
          `slot ${Math.round(snapshot.slotRatio * 100)}% · ` +
          `active ${Math.round(snapshot.inViewRatio * 100)}% · ` +
          `depth ${Math.round(snapshot.scrollDepth * 100)}%`,
        data: {
          slot: runtime.index + 1,
          slots: runtime.total(),
          layout: runtime.layout,
          pageAttention: snapshot.attention,
          ...snapshot
        }
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per-placement runtime                                               */
  /* ------------------------------------------------------------------ */

  /**
   * @param {{
   *   host: HTMLElement,
   *   index: number,
   *   total: () => number,
   *   layout: string,
   *   tracker: object,
   *   coordinator: { busy: boolean, delivered: number },
   *   report: (runtime: object) => void
   * }} input
   */
  function createRuntime({ host, index, total, layout, tracker, coordinator }) {
    const viewport = createViewportWatcher(host, {
      threshold: CONFIG.viewportThreshold,
      virtualHeight: CONFIG.virtualSlotHeight
    });
    const score = createAttentionScore({ tracker, viewport });

    const ui = {
      phase: 'idle',
      session: 0,
      impressions: 0,
      // Last creative this placement showed, so the ad server can rotate to a
      // different advertiser instead of repeating the same banner.
      lastCreativeId: '',
      lastSponsor: '',
      lastReward: 0,
      lastOutcome: null,
      elapsedMs: 0,
      attention: 0,
      slotRatio: 0,
      inViewRatio: 0,
      shadow: null
    };

    let cooldownUntil = 0;
    let lastAttempt = { mouseMoves: 0, scrollEvents: 0, clicks: 0, at: 0 };
    let snapshot = null;
    /** Pending cross-fade timer for a creative rotation. */
    let swapTimer = 0;

    const runtime = {
      host,
      index,
      layout,
      viewport,
      label: () => `${index + 1}/${total()}`,
      get snapshot() {
        return snapshot;
      },
      refresh,
      announce,
      ready,
      budgetLeft,
      runSession
    };

    return runtime;

    /* ---------------------------------------------------------------- */

    function budgetLeft() {
      return ui.impressions < CONFIG.maxPerSlot && coordinator.delivered < CONFIG.maxImpressionsPerPage;
    }

    function refresh() {
      viewport.measure();
      ui.attention = Math.round(score.current());
      ui.slotRatio = round3(viewport.ratio());
      ui.inViewRatio = round3(tracker.inViewRatio());
    }

    function announce() {
      snapshot = {
        phase: ui.phase,
        session: ui.session,
        impressions: ui.impressions,
        impressionsMax: CONFIG.maxPerSlot,
        budgetLocked: !budgetLeft(),
        lastCreativeId: ui.lastCreativeId,
        lastSponsor: ui.lastSponsor,
        lastReward: ui.lastReward,
        lastOutcome: ui.lastOutcome,
        pageDwellMs: Math.round(tracker.pageDwell()),
        elapsedMs: Math.round(ui.elapsedMs),
        sessionTargetMs: CONFIG.sessionMs,
        visibleRatio: round3(tracker.visibleRatio()),
        focusRatio: round3(tracker.focusRatio()),
        slotInView: viewport.inView(),
        slotRatio: ui.slotRatio,
        attention: ui.attention,
        inViewRatio: ui.inViewRatio,
        totals: tracker.totals(),
        scrollDepth: round3(tracker.totals().scrollDepth)
      };
      return snapshot;
    }

    /**
     * Starts a measurement window only when the reader is actually looking at
     * this placement: the tab is visible, the unit is on screen, the page has
     * been open long enough, and there are fresh interaction signals.
     */
    function ready() {
      if (coordinator.busy) return false;
      if (document.visibilityState !== 'visible') return false;
      if (Date.now() < cooldownUntil) return false;
      if (!budgetLeft()) return false;
      if (!READY_PHASES.has(ui.phase)) return false;

      // Hard viewport gate: no timer runs for an off-screen placement.
      if (!viewport.inView() || viewport.ratio() < CONFIG.viewportThreshold) return false;
      if (tracker.pageDwell() < CONFIG.dwellBeforeStartMs) return false;

      const totals = tracker.totals();
      const engaged = totals.mouseMoves + totals.scrollEvents + totals.clicks;
      if (engaged < 2) return false;

      if (lastAttempt.at > 0) {
        const fresh =
          (totals.mouseMoves - lastAttempt.mouseMoves) +
          (totals.scrollEvents - lastAttempt.scrollEvents) +
          (totals.clicks - lastAttempt.clicks);
        if (fresh < CONFIG.minNewSignals) return false;
      }

      return true;
    }

    async function runSession() {
      if (coordinator.busy) return;
      coordinator.busy = true;

      ui.session += 1;
      ui.phase = 'measuring';
      ui.elapsedMs = 0;

      emitClientEvent(
        'info',
        'Attention session started',
        `placement ${runtime.label()} · session ${ui.session} · timer runs only while on screen`
      );
      announce();

      try {
        const outcome = await measureInViewAttention();

        // The reader scrolled the placement away: no offer is requested and no
        // token is minted for attention that was not there.
        if (!outcome.completed) {
          ui.phase = 'paused';
          ui.elapsedMs = 0;
          ui.lastOutcome = {
            approved: false,
            score: null,
            reason: 'Placement left the viewport. Measurement paused.'
          };
          cooldownUntil = Date.now() + CONFIG.pauseCooldownMs;
          emitClientEvent(
            'warn',
            'Measurement paused',
            `Placement ${runtime.label()} left the viewport, so the timer stopped and no offer was requested.`
          );
          return;
        }

        const signals = outcome.signals;

        // Don't ask the ad server when the placement was barely on screen: a
        // low-quality look is not an impression worth negotiating.
        if (signals.slotVisibleRatio < CONFIG.minSlotVisibleRatio) {
          ui.phase = 'paused';
          ui.elapsedMs = 0;
          ui.lastOutcome = {
            approved: false,
            score: null,
            reason: 'The placement was not on screen long enough to count.'
          };
          cooldownUntil = Date.now() + CONFIG.retryCooldownMs;
          emitClientEvent(
            'warn',
            'Session discarded',
            `Placement ${runtime.label()} visible for only ${Math.round(signals.slotVisibleRatio * 100)}% of the window.`
          );
          return;
        }

        lastAttempt = { ...tracker.totals(), at: Date.now() };

        ui.phase = 'validating';
        ui.elapsedMs = 0;
        announce();
        emitClientEvent('info', 'Signals submitted', `extension agent → ad server · placement ${runtime.label()}`);

        const response = await sendMessage({
          type: 'ADPAL_REQUEST_OFFER',
          payload: {
            price: CONFIG.price,
            signals,
            page: {
              title: document.title.slice(0, 120),
              host: location.hostname || location.protocol
            },
            slot: {
              detected: true,
              index: index + 1,
              lastCreativeId: ui.lastCreativeId || ''
            },
            // Lets the worker find the simulator when it fell back to another
            // port. Only ever set for local origins, never for third-party sites.
            serverHint: localServerHint()
          }
        });

        if (!response || response.ok !== true) {
          const reason = response?.error || 'Ad server unreachable.';
          ui.phase = 'offline';
          ui.lastOutcome = { approved: false, score: null, reason };
          cooldownUntil = Date.now() + CONFIG.offlineCooldownMs;
          emitClientEvent('error', 'Ad server unreachable', reason);
          return;
        }

        const data = response.data || {};
        const approved = Boolean(data.approved);

        ui.lastOutcome = {
          approved,
          score: typeof data.score === 'number' ? data.score : null,
          reason: data.reason || ''
        };

        if (approved) {
          const rendered = renderCreative(data.creative, { layout });

          if (!rendered) {
            // An approved offer with no creative renders nothing at all: the
            // placement stays empty rather than showing a local placeholder.
            ui.phase = 'invalid';
            ui.lastOutcome = {
              approved: true,
              score: ui.lastOutcome.score,
              reason: 'Approved without a creative.'
            };
            cooldownUntil = Date.now() + CONFIG.retryCooldownMs;
            emitClientEvent('warn', 'Creative missing', 'Offer approved but no creative was returned; placement left empty.');
            return;
          }

          ui.impressions += 1;
          coordinator.delivered += 1;
          ui.lastReward = data.split?.user ?? 0;
          // Remember what this placement just showed so the next negotiation
          // rotates to a different advertiser, then wait before asking again.
          ui.lastCreativeId = data.creative?.id || '';
          ui.lastSponsor = data.creative?.sponsor || '';
          cooldownUntil = Date.now() + CONFIG.rotateAfterMs;
          // The creative stays exactly as delivered. The slot holds it until
          // the rotation interval elapses and the reader is still engaged.
          ui.phase = 'delivered';

          emitClientEvent(
            'ok',
            'Creative delivered',
            `placement ${runtime.label()} · ${data.creative?.sponsor || 'Sponsored'} · reader credited €${money(ui.lastReward)}`
          );
        } else {
          ui.phase = 'rejected';
          cooldownUntil = Date.now() + CONFIG.retryCooldownMs;
          emitClientEvent(
            'warn',
            'Offer withheld',
            `placement ${runtime.label()} · ${data.reason || 'Attention signal below threshold.'}`
          );
        }
      } finally {
        coordinator.busy = false;
        announce();
      }
    }

    /**
     * Accumulates attention time only while THIS placement is on screen and
     * the tab is visible. Resolves with `completed: false` when the unit
     * stayed out of view long enough that the measurement is no longer
     * meaningful.
     */
    function measureInViewAttention() {
      return new Promise((resolve) => {
        tracker.beginSession();

        const sessionStart = performance.now();
        let lastTick = sessionStart;
        let inViewMs = 0;
        let awayMs = 0;
        let settled = false;
        let timer = null;

        const finish = (completed) => {
          if (settled) return;
          settled = true;
          window.clearInterval(timer);

          const durationMs = Math.max(1, performance.now() - sessionStart);
          const signals = tracker.endSession({
            slotInViewMs: Math.round(inViewMs),
            slotVisibleRatio: Number(clamp(inViewMs / durationMs, 0, 1).toFixed(3))
          });

          ui.elapsedMs = completed ? CONFIG.sessionMs : inViewMs;
          resolve({ completed, signals });
        };

        timer = window.setInterval(() => {
          const now = performance.now();
          const dt = Math.min(now - lastTick, CONFIG.tickMs * 2);
          lastTick = now;

          const onScreen = viewport.inView() && document.visibilityState === 'visible';

          if (onScreen) {
            inViewMs += dt;
            awayMs = 0;
          } else {
            awayMs += dt;
          }

          ui.elapsedMs = inViewMs;
          ui.attention = Math.round(score.current());
          ui.slotRatio = round3(viewport.ratio());

          if (inViewMs >= CONFIG.sessionMs) {
            finish(true);
            return;
          }

          if (awayMs >= CONFIG.outOfViewAbortMs) {
            finish(false);
          }
        }, CONFIG.tickMs);
      });
    }

    /* ---------------------------------------------------------------- */
    /* Creative rendering                                                */
    /* ---------------------------------------------------------------- */

    /**
     * Renders the server-assigned creative into this placement.
     * Returns false when no usable creative was supplied, in which case the
     * placement is never touched and keeps its reserved (empty) frame.
     *
     * The publisher reserves the box in CSS, so this only fills it: no height
     * is introduced here, and the unit fades in without moving the page.
     *
     * When the slot already holds an advertiser, the swap is a cross-fade:
     * brief opacity dip, new markup mounted, fade back up. The frame never
     * changes size, so a rotation cannot shift the article either.
     */
    function renderCreative(creative, meta = {}) {
      const ad = normalizeCreative(creative);
      if (!ad) return false;

      const markup =
        meta.layout === 'inline'
          ? `<style>${INLINE_STYLES}</style>${inlineMarkup(ad)}`
          : meta.layout === 'rail'
            ? `<style>${RAIL_STYLES}</style>${railMarkup(ad)}`
            : `<style>${AD_STYLES}</style>${creativeMarkup(ad)}`;

      const mount = () => {
        if (!ui.shadow) {
          // The placement is only touched when there is an approved creative.
          host.replaceChildren();
          ui.shadow = host.attachShadow({ mode: 'open' });
        }
        ui.shadow.innerHTML = markup;
        // Signals the host page to drop the reserved frame's placeholder chrome.
        host.dataset.adpalState = 'filled';
        host.style.opacity = '';
      };

      window.clearTimeout(swapTimer);

      if (ui.shadow && host.dataset.adpalState === 'filled') {
        // Rotation: dip to transparent, swap at the bottom of the dip, and let
        // the unit's own fade bring the new advertiser in.
        host.style.transition = 'opacity 160ms ease';
        host.style.opacity = '0';
        swapTimer = window.setTimeout(mount, 170);
      } else {
        mount();
      }

      return true;
    }

    /** Returns null unless the server supplied a creative with a headline. */
    function normalizeCreative(value) {
      if (!value || typeof value !== 'object') return null;

      const text = (key, max) => {
        const raw = value[key];
        if (typeof raw !== 'string') return '';
        return raw.replace(/\s+/g, ' ').trim().slice(0, max);
      };

      const headline = text('headline', 120);
      if (!headline) return null;

      const theme = ['coffee', 'audio', 'plants'].includes(value.theme) ? value.theme : 'neutral';

      return {
        id: text('id', 60),
        sponsor: text('sponsor', 60),
        headline,
        body: text('body', 160),
        cta: text('cta', 40),
        theme
      };
    }

    function creativeMarkup(ad) {
      const sponsor = ad.sponsor || 'Sponsored';

      return `
        <aside class="unit" aria-label="Sponsored content">
          <div class="unit-top">
            <span class="unit-label">Sponsored</span>
            <span class="unit-brand">${esc(sponsor)}</span>
          </div>
          <div class="unit-body">
            <span class="unit-art theme-${esc(ad.theme)}" aria-hidden="true"><i></i></span>
            <div class="unit-copy">
              <p class="unit-headline">${esc(ad.headline)}</p>
              <p class="unit-text">${esc(ad.body)}</p>
            </div>
            <span class="unit-cta">${esc(ad.cta)} <span aria-hidden="true">→</span></span>
          </div>
          <div class="unit-foot">
            <span class="unit-dot" aria-hidden="true"></span>
            <span>Reader-funded placement</span>
            <span class="unit-sep" aria-hidden="true">·</span>
            <span>no trackers, no data sold</span>
          </div>
        </aside>`;
    }

    /**
     * Compact partner line: the shape used when the publisher embeds a
     * placement inside one of its own cards. No border, no artwork, no button
     * block — a hairline rule, a label and one line of copy, so the unit reads
     * as part of the card instead of a banner dropped on top of it.
     */
    function inlineMarkup(ad) {
      const sponsor = ad.sponsor || 'Sponsored';

      return `
        <aside class="line" aria-label="Sponsored content">
          <div class="line-top">
            <span class="line-label">Sponsored</span>
            <span class="line-brand">${esc(sponsor)}</span>
          </div>
          <p class="line-headline">${esc(ad.headline)}</p>
          <div class="line-foot">
            <p class="line-text">${esc(ad.body)}</p>
            <span class="line-cta">${esc(ad.cta)} <span aria-hidden="true">→</span></span>
          </div>
        </aside>`;
    }

    /**
     * Sidebar card: the shape used in the sticky rail. Artwork on top, copy
     * below — a vertical unit sized for a 300 px column, with the sponsor's
     * own name where a reader expects a masthead.
     */
    function railMarkup(ad) {
      const sponsor = ad.sponsor || 'Sponsored';
      const monogram = sponsor.trim().charAt(0).toUpperCase() || 'S';

      return `
        <aside class="rail-card" aria-label="Sponsored content">
          <div class="rail-card-top">
            <span class="rail-card-label">Sponsored</span>
            <span class="rail-card-brand">${esc(sponsor)}</span>
          </div>
          <span class="rail-card-art theme-${esc(ad.theme)}" aria-hidden="true"><i>${esc(monogram)}</i></span>
          <div class="rail-card-copy">
            <p class="rail-card-headline">${esc(ad.headline)}</p>
            <p class="rail-card-text">${esc(ad.body)}</p>
          </div>
          <span class="rail-card-cta">${esc(ad.cta)} <span aria-hidden="true">→</span></span>
        </aside>`;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Telemetry relay                                                     */
  /* ------------------------------------------------------------------ */

  function emitClientEvent(level, title, detail, data = null) {
    sendClientEvent({ kind: 'client.event', level, title, detail, data });
  }

  /**
   * Fire-and-forget relay through the service worker. Content scripts cannot
   * POST cross-origin, and the article page must stay silent, so the
   * background worker owns the request.
   */
  function sendClientEvent(payload) {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'ADPAL_CLIENT_EVENT',
          payload: {
            ...payload,
            host: location.host,
            url: location.href.slice(0, 200)
          }
        },
        () => {
          // Reading the last error marks it as handled when the worker is
          // asleep or the extension was reloaded mid-session.
          void chrome.runtime.lastError;
        }
      );
    } catch {
      /* extension context invalidated; telemetry is optional */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Presence                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Keeps the reader session alive for as long as the page is genuinely open
   * and visible.
   *
   * The server will not sell an impression without this: that is the whole
   * point. A tab left in the background, a page restored from the bfcache, or
   * a closed browser sends `hidden` / `closing` and stops counting immediately,
   * so nothing can be bought or paid out on behalf of a reader who is not there.
   */
  function startPresence() {
    // Page-scoped heartbeat: closing the tab clears it, a hidden tab reports
    // `hidden` rather than pretending to be a reader, and a bfcache restore
    // starts it again.
    let timer = 0;

    const currentState = () =>
      document.visibilityState === 'visible' ? 'active' : 'hidden';

    const beat = () => sendPresence(currentState());

    /** Restarts the heartbeat after a bfcache restore, where `pagehide` cleared it. */
    const resume = () => {
      window.clearInterval(timer);
      timer = window.setInterval(beat, CONFIG.presenceIntervalMs);
    };

    beat();
    resume();

    document.addEventListener('visibilitychange', beat, { passive: true });
    window.addEventListener('pageshow', () => {
      // A restored page comes back with no interval and no server-side record,
      // so it re-beats immediately before resuming the regular loop.
      resume();
      beat();
    });
    window.addEventListener('pagehide', () => {
      window.clearInterval(timer);
      sendPresence('closing');
    });
    window.addEventListener('beforeunload', () => sendPresence('closing'));

    return timer;
  }

  function sendPresence(state) {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'ADPAL_PRESENCE',
          payload: {
            state,
            page: {
              title: document.title.slice(0, 120),
              host: location.host
            },
            host: location.host
          }
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch {
      /* extension context invalidated; the server TTL expires the session */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Viewport watcher                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Tracks whether a placement is on screen.
   *
   * An IntersectionObserver supplies the scroll-time signal, but a placement is
   * intentionally empty (0 px tall) until an ad is served, and a zero-area
   * target reports a meaningless intersection ratio. The authoritative
   * measurement is therefore a geometry check against a virtual placement box
   * the size of a typical in-article unit, re-evaluated whenever the observer
   * fires, on scroll, and on resize.
   */
  function createViewportWatcher(element, { threshold, virtualHeight }) {
    let ratio = 0;
    let inView = false;
    let measured = false;
    let queued = false;

    function measure() {
      const rect = element.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      if (viewportHeight <= 0) return;

      const height = Math.max(rect.height, virtualHeight);
      const visibleTop = Math.max(0, rect.top);
      const visibleBottom = Math.min(viewportHeight, rect.top + height);
      const visible = Math.max(0, visibleBottom - visibleTop);

      ratio = clamp(visible / height, 0, 1);
      inView = ratio >= threshold;
      measured = true;
    }

    function schedule() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        measure();
      });
    }

    const observer = new IntersectionObserver(schedule, {
      threshold: [0, 0.25, 0.5, 0.75, 1]
    });
    observer.observe(element);

    // Capture phase: the placement may live inside an inner scrolling column,
    // whose scroll events do not bubble.
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule, { passive: true });

    measure();

    return {
      inView: () => {
        if (!measured) measure();
        return inView;
      },
      ratio: () => {
        if (!measured) measure();
        return ratio;
      },
      measure
    };
  }

  /* ------------------------------------------------------------------ */
  /* Attention score                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * A single, stable 0-100 attention estimate per placement.
   *
   * Composition:
   *  - 55% current viewport visibility of the placement (instant, smooth);
   *  - 20% how much of the last ~20 s the placement was on screen
   *    (the "active reading time" component);
   *  - 10% reading depth through the article;
   *  - 15% window focus (the reader is actually on this tab).
   *
   * No raw input counters are involved, so a fast mouse cannot inflate it and
   * an idle reader is not punished for not moving. The result is exponentially
   * smoothed for display only; the value never oscillates between frames.
   */
  function createAttentionScore({ tracker, viewport }) {
    const WINDOW = 40; // 500 ms ticks ≈ 20 s of history
    const samples = [];
    let current = 0;
    let lastAt = performance.now();

    function compute() {
      const now = performance.now();
      const dt = Math.max(1, now - lastAt);
      lastAt = now;

      const slot = viewport.ratio();
      samples.push(slot);
      if (samples.length > WINDOW) samples.shift();

      const activeShare = samples.reduce((sum, value) => sum + value, 0) / samples.length;
      const depth = clamp((tracker.totals().scrollDepth || 0) / 0.6, 0, 1);
      const focus = clamp(tracker.focusRatio(), 0, 1);

      const target = 100 * (0.55 * slot + 0.2 * activeShare + 0.1 * depth + 0.15 * focus);
      // Time-based easing: fast enough to follow a scroll, slow enough that
      // the number never jitters.
      const alpha = clamp(dt / 1000, 0.08, 0.5);
      current += (target - current) * alpha;
      return current;
    }

    return {
      current() {
        return compute();
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Attention tracker                                                   */
  /* ------------------------------------------------------------------ */

  function createAttentionTracker() {
    const t0 = performance.now();

    const totals = {
      mouseMoves: 0,
      directionChanges: 0,
      scrollEvents: 0,
      clicks: 0,
      keyPresses: 0,
      scrollDepth: 0
    };

    let visibleMs = 0;
    let visibleSince = document.visibilityState === 'visible' ? t0 : null;
    let focusMs = 0;
    let focusSince = document.visibilityState === 'visible' ? t0 : null;
    let session = null;

    // Time ANY placement spent genuinely on screen. This is the denominator
    // behind the attention score, so it must never spike on input bursts.
    let slotVisibleMs = 0;
    let slotVisibleSince = null;

    let lastMoveAt = 0;
    let lastX = null;
    let lastY = null;
    let lastDirection = '';

    /**
     * Reconciles accumulated visibility/focus time with the current page
     * state. Browsers do not always fire visibilitychange or focus/blur (for
     * example when a tab is restored from occlusion), so ratios are derived
     * from the live flags instead of relying on events alone.
     */
    function sync(now = performance.now()) {
      if (document.visibilityState === 'visible') {
        if (visibleSince === null) visibleSince = now;
      } else if (visibleSince !== null) {
        visibleMs += now - visibleSince;
        visibleSince = null;
      }

      if (document.hasFocus()) {
        if (focusSince === null) focusSince = now;
      } else if (focusSince !== null) {
        focusMs += now - focusSince;
        focusSince = null;
      }
    }

    function nowVisible(now) {
      sync(now);
      return visibleMs + (visibleSince === null ? 0 : now - visibleSince);
    }

    function nowFocused(now) {
      sync(now);
      return focusMs + (focusSince === null ? 0 : now - focusSince);
    }

    window.addEventListener('mousemove', (event) => {
      const now = performance.now();
      if (now - lastMoveAt < 40) return;
      lastMoveAt = now;
      totals.mouseMoves += 1;

      if (lastX !== null && lastY !== null) {
        const direction = `${Math.sign(event.clientX - lastX)},${Math.sign(event.clientY - lastY)}`;
        if (direction !== '0,0') {
          if (lastDirection && direction !== lastDirection) totals.directionChanges += 1;
          lastDirection = direction;
        }
      }
      lastX = event.clientX;
      lastY = event.clientY;
    }, { passive: true });

    let lastScrollAt = 0;
    /**
     * Scroll is read in the capture phase so the listener also fires for an
     * inner scrolling column, not just the window. A reader column that scrolls
     * internally would otherwise report zero depth.
     */
    window.addEventListener('scroll', (event) => {
      const now = performance.now();
      if (now - lastScrollAt < 120) return;
      lastScrollAt = now;
      totals.scrollEvents += 1;

      const depth = scrollDepthFor(event.target);
      totals.scrollDepth = Math.max(totals.scrollDepth, depth);
    }, { passive: true, capture: true });

    /** Fraction of the article that has been scrolled past. */
    function scrollDepthFor(target) {
      const scroller = isScroller(target) ? target : document.scrollingElement;
      if (!scroller) return 0;

      const top = Number(scroller.scrollTop) || 0;
      const height = Number(scroller.clientHeight) || window.innerHeight || 0;
      const scrollable = Math.max(1, (Number(scroller.scrollHeight) || height) - height);
      return Math.min(1, Math.max(0, top / scrollable));
    }

    function isScroller(node) {
      return Boolean(
        node &&
          node.nodeType === 1 &&
          node !== document.body &&
          node !== document.documentElement &&
          (node.scrollHeight - node.clientHeight > 40)
      );
    }

    window.addEventListener('click', () => {
      totals.clicks += 1;
    }, { passive: true, capture: true });

    window.addEventListener('keydown', () => {
      totals.keyPresses += 1;
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      const now = performance.now();
      if (document.visibilityState === 'visible') {
        visibleSince = now;
      } else if (visibleSince !== null) {
        visibleMs += now - visibleSince;
        visibleSince = null;
      }
    });

    window.addEventListener('blur', () => {
      const now = performance.now();
      if (focusSince !== null) {
        focusMs += now - focusSince;
        focusSince = null;
      }
    });

    window.addEventListener('focus', () => {
      if (focusSince === null) focusSince = performance.now();
    });

    return {
      beginSession() {
        const now = performance.now();
        session = {
          start: now,
          visibleBase: nowVisible(now),
          focusBase: nowFocused(now),
          mouseBase: totals.mouseMoves,
          directionBase: totals.directionChanges,
          scrollBase: totals.scrollEvents,
          clickBase: totals.clicks,
          keyBase: totals.keyPresses
        };
      },

      endSession(extra = {}) {
        if (!session) return null;
        const now = performance.now();
        const durationMs = Math.max(1, now - session.start);
        const visible = Math.max(0, nowVisible(now) - session.visibleBase);
        const focused = Math.max(0, nowFocused(now) - session.focusBase);

        const signals = {
          durationMs: Math.round(durationMs),
          pageDwellMs: Math.round(now - t0),
          mouseMoves: totals.mouseMoves - session.mouseBase,
          directionChanges: totals.directionChanges - session.directionBase,
          scrollEvents: totals.scrollEvents - session.scrollBase,
          scrollDepth: Number(totals.scrollDepth.toFixed(3)),
          clicks: totals.clicks - session.clickBase,
          keyPresses: totals.keyPresses - session.keyBase,
          visibleRatio: Number(clamp(visible / durationMs, 0, 1).toFixed(3)),
          focusRatio: Number(clamp(focused / durationMs, 0, 1).toFixed(3)),
          webdriver: navigator.webdriver === true,
          clientSentAt: Date.now(),
          ...extra
        };

        session = null;
        return signals;
      },

      totals() {
        return { ...totals };
      },

      pageDwell() {
        return performance.now() - t0;
      },

      visibleRatio() {
        const dwell = Math.max(1, performance.now() - t0);
        return clamp(nowVisible(performance.now()) / dwell, 0, 1);
      },

      focusRatio() {
        const dwell = Math.max(1, performance.now() - t0);
        return clamp(nowFocused(performance.now()) / dwell, 0, 1);
      },

      /** Records whether any placement is currently on screen. */
      setSlotVisible(next) {
        const now = performance.now();
        if (next && slotVisibleSince === null) {
          slotVisibleSince = now;
        } else if (!next && slotVisibleSince !== null) {
          slotVisibleMs += now - slotVisibleSince;
          slotVisibleSince = null;
        }
      },

      /** Share of the page view a placement spent on screen (0-1). */
      inViewRatio(now = performance.now()) {
        const dwell = Math.max(1, now - t0);
        const live = slotVisibleSince === null ? 0 : now - slotVisibleSince;
        return clamp((slotVisibleMs + live) / dwell, 0, 1);
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Utilities                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Origin hint for the simulator, only when the page is served locally.
   * The demo publisher is served by the simulator itself, so its own origin
   * reveals the active port (3000, 3001, …). Third-party pages never send one.
   */
  function localServerHint() {
    const host = location.hostname;
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1';

    return isLocal ? location.origin : null;
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: 'Extension reloaded. Reload the page to continue.' });
            return;
          }
          resolve(response || { ok: false, error: 'Empty response from the service worker.' });
        });
      } catch (error) {
        resolve({ ok: false, error: error?.message || 'Extension unavailable.' });
      }
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round3(value) {
    return Number(clamp(value, 0, 1).toFixed(3));
  }

  function money(value) {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3
    }).format(Number(value) || 0);
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  /* ------------------------------------------------------------------ */
  /* Styles (isolated in the Shadow DOM, full-width sponsored banner)     */
  /* ------------------------------------------------------------------ */

  /*
   * The unit is a banner, not a floating card: it shares the publication's
   * warm paper palette, keeps its own type scale, and never overlays the
   * article. Everything below is scoped to the shadow root, so the host page's
   * CSS cannot leak in and the banner cannot restyle the article.
   */
  const AD_STYLES = `
    :host { all: initial; display: block; }
    *, *::before, *::after { box-sizing: border-box; }

    .unit {
      display: block;
      width: 100%;
      max-width: 700px;
      /* The publisher reserves the frame; the unit must not add its own
         margins or it would overflow the reserved box. */
      margin: 0 auto;
      border: 1px solid #e9e2d4;
      border-radius: 14px;
      background: #fffdf8;
      color: #14110d;
      overflow: hidden;
      font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      text-align: left;
      box-shadow: 0 1px 0 rgba(20, 17, 13, 0.03);
      animation: adpal-enter 0.45s ease both;
    }

    /* Fade only. The frame is already reserved, so the unit must not translate
       or scale — any movement would read as the page shifting. */
    @keyframes adpal-enter {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .unit-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 16px;
      border-bottom: 1px solid #f1ebdf;
      background: linear-gradient(90deg, rgba(180, 83, 9, 0.055), transparent 58%);
    }

    .unit-label {
      color: #a08a6c;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    .unit-brand {
      color: #3a342c;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .unit-body {
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr) auto;
      align-items: center;
      gap: 16px;
      padding: 15px 16px;
    }

    .unit-art {
      position: relative;
      display: grid;
      place-items: center;
      width: 96px;
      height: 76px;
      border-radius: 10px;
      overflow: hidden;
      background: #f1ebdf;
    }

    .unit-art i { display: block; font-style: normal; }

    .theme-coffee {
      background:
        radial-gradient(80px 60px at 26% 20%, rgba(255, 216, 168, 0.92), transparent 72%),
        linear-gradient(140deg, #2a1a12, #6b4029 65%, #9a6440);
    }

    .theme-coffee i {
      width: 34px;
      height: 30px;
      margin-bottom: 4px;
      border: 4px solid #f6e6d2;
      border-radius: 4px 4px 12px 12px;
    }

    .theme-audio {
      background:
        radial-gradient(80px 60px at 30% 22%, rgba(180, 232, 255, 0.55), transparent 70%),
        linear-gradient(140deg, #101a2b, #1f3b52 60%, #2d5a6b);
    }

    .theme-audio i {
      width: 44px;
      height: 26px;
      border: 4px solid #d9f1ff;
      border-radius: 999px;
    }

    .theme-plants {
      background:
        radial-gradient(80px 60px at 30% 20%, rgba(206, 255, 206, 0.55), transparent 70%),
        linear-gradient(140deg, #12261a, #2c5137 65%, #4c8659);
    }

    .theme-plants i {
      width: 30px;
      height: 38px;
      background: #d7f5dd;
      border-radius: 50% 50% 46% 46% / 62% 62% 38% 38%;
    }

    .theme-neutral {
      background: linear-gradient(140deg, #1a1610, #4a3a24 70%, #7c5a2f);
    }

    .theme-neutral i {
      width: 34px;
      height: 26px;
      border: 3px solid #f0dcbc;
      border-radius: 4px;
    }

    .unit-copy { min-width: 0; }

    .unit-headline {
      margin: 0 0 4px;
      color: #14110d;
      font-family: Georgia, "Times New Roman", Times, serif;
      font-size: 19px;
      font-weight: 700;
      line-height: 1.25;
      letter-spacing: -0.012em;
    }

    .unit-text {
      margin: 0;
      color: #6d6459;
      font-size: 12.5px;
      line-height: 1.5;
    }

    .unit-cta {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 16px;
      border-radius: 999px;
      background: #14110d;
      color: #fff;
      font-size: 11.5px;
      font-weight: 700;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }

    .unit-foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 9px 16px;
      border-top: 1px solid #f1ebdf;
      color: #93897c;
      font-size: 9.5px;
      letter-spacing: 0.02em;
    }

    .unit-dot {
      flex: none;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #b45309;
    }

    .unit-sep { opacity: 0.6; }

    @media (max-width: 640px) {
      .unit-body {
        grid-template-columns: 64px minmax(0, 1fr);
        gap: 12px;
        padding: 13px;
      }
      .unit-art { width: 64px; height: 58px; border-radius: 8px; }
      .unit-headline { font-size: 17px; }
      .unit-cta { grid-column: 1 / -1; justify-self: start; }
      .unit-foot { font-size: 9px; }
    }
  `;

  /*
   * Compact partner line, used when the publisher embeds a placement inside one
   * of its own cards. It keeps the card's palette through inherited custom
   * properties (`--adpal-rule`, `--adpal-ink`, `--adpal-muted`, `--adpal-accent`)
   * and falls back to the publication's paper tones when none are declared.
   */
  const INLINE_STYLES = `
    :host { all: initial; display: block; }
    *, *::before, *::after { box-sizing: border-box; }

    .line {
      display: block;
      /* The card's own padding already sits above the reserved line. */
      margin: 0;
      padding-top: 14px;
      border-top: 1px solid var(--adpal-rule, #eae3d5);
      color: #3b352d;
      font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
      font-size: 12px;
      line-height: 1.45;
      text-align: left;
      animation: adpal-line-in 0.4s ease both;
    }

    @keyframes adpal-line-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .line-top {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }

    .line-label {
      color: var(--adpal-label, #a08a6c);
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    .line-brand {
      color: var(--adpal-ink, #3b352d);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      opacity: 0.72;
    }

    .line-headline {
      margin: 0 0 3px;
      color: var(--adpal-ink, #14110d);
      font-family: Georgia, "Iowan Old Style", "Times New Roman", Times, serif;
      font-size: 14.5px;
      font-weight: 700;
      line-height: 1.3;
      letter-spacing: -0.008em;
    }

    .line-foot {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }

    .line-text {
      margin: 0;
      color: var(--adpal-muted, #6f665a);
      font-size: 11.5px;
      line-height: 1.45;
    }

    .line-cta {
      flex: none;
      color: var(--adpal-accent, #7c3f06);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }

    @media (max-width: 440px) {
      .line-foot { flex-wrap: wrap; gap: 4px; }
    }
  `;

  /*
   * Sidebar card, used by the sticky rail. A vertical unit sized for a 300 px
   * column: masthead strip, full-bleed artwork band, headline, one line of
   * body, a text CTA. It fills the frame the publisher reserved, so the rail
   * never changes height.
   */
  const RAIL_STYLES = `
    :host { all: initial; display: block; width: 100%; height: 100%; }
    *, *::before, *::after { box-sizing: border-box; }

    .rail-card {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0 0 14px;
      border: 1px solid #e9e2d4;
      border-radius: 14px;
      background: #fffdf8;
      color: #14110d;
      overflow: hidden;
      font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
      font-size: 12.5px;
      line-height: 1.45;
      text-align: left;
      animation: adpal-rail-in 0.45s ease both;
    }

    /* Fade only: the frame is reserved, so nothing may translate. */
    @keyframes adpal-rail-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .rail-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 12px 14px 10px;
    }

    .rail-card-label {
      color: #a08a6c;
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    .rail-card-brand {
      color: #3a342c;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    /* Full-bleed band, not a floating thumbnail: it reads as the unit's
       masthead image the way a magazine card would. */
    .rail-card-art {
      position: relative;
      display: grid;
      place-items: center;
      flex: 0 0 146px;
      width: 100%;
      overflow: hidden;
      background: linear-gradient(140deg, #1a1610, #4a3a24 70%, #7c5a2f);
    }

    .rail-card-art::after {
      content: "";
      position: absolute;
      inset: 0;
      background: radial-gradient(120% 90% at 78% 8%, rgba(255, 255, 255, 0.16), transparent 62%);
      pointer-events: none;
    }

    .rail-card-art i { display: block; position: relative; z-index: 1; }

    /* The band carries the sponsor's monogram rather than a literal icon: it
       looks deliberate whatever the ad is selling, and it never competes with
       the headline below. */
    .rail-card-art i {
      display: grid;
      place-items: center;
      width: 66px;
      height: 66px;
      border: 1px solid rgba(255, 255, 255, 0.34);
      border-radius: 50%;
      color: rgba(255, 246, 232, 0.94);
      font-family: Georgia, "Iowan Old Style", "Times New Roman", Times, serif;
      font-size: 28px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0;
    }

    .rail-card-art.theme-coffee {
      background:
        radial-gradient(120px 90px at 26% 20%, rgba(255, 216, 168, 0.55), transparent 72%),
        linear-gradient(140deg, #2a1a12, #6b4029 65%, #9a6440);
    }

    .rail-card-art.theme-audio {
      background:
        radial-gradient(120px 90px at 30% 22%, rgba(180, 232, 255, 0.34), transparent 70%),
        linear-gradient(140deg, #101a2b, #1f3b52 60%, #2d5a6b);
    }

    .rail-card-art.theme-plants {
      background:
        radial-gradient(120px 90px at 30% 20%, rgba(206, 255, 206, 0.32), transparent 70%),
        linear-gradient(140deg, #12261a, #2c5137 65%, #4c8659);
    }

    .rail-card-copy {
      display: flex;
      flex-direction: column;
      gap: 7px;
      padding: 13px 14px 0;
    }

    .rail-card-headline {
      margin: 0;
      color: #14110d;
      font-family: Georgia, "Iowan Old Style", "Times New Roman", Times, serif;
      font-size: 16.5px;
      font-weight: 700;
      line-height: 1.26;
      letter-spacing: -0.012em;
    }

    .rail-card-text {
      margin: 0;
      color: #6d6459;
      font-size: 11.5px;
      line-height: 1.5;
    }

    .rail-card-cta {
      padding: 0 14px;
      margin-top: auto;
      color: #7c3f06;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
  `;
})();
