'use strict';

/**
 * "Human vs script" heuristic.
 *
 * Intentionally simple and explainable: a 0-100 score built from aggregated
 * signals sent by the extension. This is not an AI model — it is a
 * deterministic mock, free of personal data, that rejects empty or
 * inconsistent sessions.
 *
 * Each guard rail is reported individually (`checks`) so the demo terminal
 * can show bot-detection results, while `flags` keeps the historical list of
 * failed checks used in API responses.
 */

const DEFAULT_THRESHOLD = 50;

/**
 * Guard rails, evaluated in order. The first failing guard rail becomes the
 * headline reason returned to the client.
 */
const GUARDS = Object.freeze([
  Object.freeze({
    id: 'automation',
    label: 'Automation flag',
    message: 'Browser reported as driven by an automation tool.'
  }),
  Object.freeze({
    id: 'duration',
    label: 'Session length',
    message: 'Session too short to be credible.'
  }),
  Object.freeze({
    id: 'interaction',
    label: 'Human interaction',
    message: 'Too few interactions to confirm human presence.'
  }),
  Object.freeze({
    id: 'visibility',
    label: 'Tab visibility',
    message: 'The tab was hidden for most of the session.'
  }),
  Object.freeze({
    id: 'viewport',
    label: 'Ad in viewport',
    message: 'The ad placement was off screen for most of the session.'
  }),
  Object.freeze({
    id: 'density',
    label: 'Movement density',
    message: 'Movement density inconsistent with a human hand.'
  }),
  Object.freeze({
    id: 'timestamp',
    label: 'Timestamp integrity',
    message: 'Client timestamp inconsistent with the server.'
  }),
  Object.freeze({
    id: 'scroll-pattern',
    label: 'Scroll pattern',
    message: 'Scroll density too high for human reading.'
  })
]);

const GUARD_LABELS = Object.freeze(GUARDS.map(({ id, label }) => ({ id, label })));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFinite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * @param {{ signals?: object }} report
 * @param {{ receivedAt?: number, threshold?: number }} options
 */
function evaluateAttention(report = {}, options = {}) {
  const threshold = clamp(toFinite(options.threshold, DEFAULT_THRESHOLD), 0, 100);
  const receivedAt = toFinite(options.receivedAt, Date.now());
  const signals = report.signals && typeof report.signals === 'object' ? report.signals : {};

  const durationMs = clamp(toFinite(signals.durationMs), 0, 10 * 60 * 1000);
  const pageDwellMs = clamp(toFinite(signals.pageDwellMs), 0, 24 * 60 * 60 * 1000);
  const mouseMoves = Math.round(clamp(toFinite(signals.mouseMoves), 0, 100000));
  const directionChanges = Math.round(clamp(toFinite(signals.directionChanges), 0, 100000));
  const scrollEvents = Math.round(clamp(toFinite(signals.scrollEvents), 0, 100000));
  const scrollDepth = clamp(toFinite(signals.scrollDepth), 0, 1);
  const clicks = Math.round(clamp(toFinite(signals.clicks), 0, 10000));
  const keyPresses = Math.round(clamp(toFinite(signals.keyPresses), 0, 10000));
  const visibleRatio = clamp(toFinite(signals.visibleRatio), 0, 1);
  const focusRatio = clamp(toFinite(signals.focusRatio), 0, 1);
  // `null` means the client did not report viewport data at all (e.g. a plain
  // API call), in which case the guard cannot fail the session.
  const slotVisibleRatio =
    typeof signals.slotVisibleRatio === 'number' && Number.isFinite(signals.slotVisibleRatio)
      ? clamp(signals.slotVisibleRatio, 0, 1)
      : null;
  const clientSentAt = toFinite(signals.clientSentAt, receivedAt);
  const durationSeconds = Math.max(durationMs / 1000, 0.001);

  /* ---------------- Blocking guard rails ---------------- */

  const results = [
    {
      id: 'automation',
      passed: signals.webdriver !== true,
      detail: `navigator.webdriver = ${signals.webdriver === true}`
    },
    {
      id: 'duration',
      passed: durationMs >= 2500,
      detail: `${(durationMs / 1000).toFixed(1)} s measured`
    },
    {
      id: 'interaction',
      passed: mouseMoves >= 2 || scrollEvents >= 1 || clicks >= 1,
      detail: `${plural(mouseMoves, 'move')} · ${plural(scrollEvents, 'scroll')} · ${plural(clicks, 'click')}`
    },
    {
      id: 'visibility',
      passed: visibleRatio >= 0.45,
      detail: `${Math.round(visibleRatio * 100)}% visible`
    },
    {
      id: 'viewport',
      passed: slotVisibleRatio === null || slotVisibleRatio >= 0.5,
      detail: slotVisibleRatio === null ? 'not reported' : `${Math.round(slotVisibleRatio * 100)}% in view`
    },
    {
      id: 'density',
      passed: mouseMoves / durationSeconds <= 60,
      detail: `${(mouseMoves / durationSeconds).toFixed(1)} moves/s`
    },
    {
      id: 'timestamp',
      passed: Math.abs(receivedAt - clientSentAt) <= 120000,
      detail: `${Math.round(Math.abs(receivedAt - clientSentAt) / 1000)} s clock skew`
    },
    {
      id: 'scroll-pattern',
      passed: !(scrollEvents > 200 && scrollDepth > 0.995),
      detail: `${plural(scrollEvents, 'event')} · ${Math.round(scrollDepth * 100)}% depth`
    }
  ];

  const checks = results.map((result, index) => ({
    id: GUARDS[index].id,
    label: GUARDS[index].label,
    status: result.passed ? 'pass' : 'fail',
    detail: result.detail
  }));

  const flags = results
    .map((result, index) => (result.passed ? null : GUARDS[index].message))
    .filter(Boolean);

  /* ---------------- Weighted score ---------------- */

  const factors = [];
  let score = 15;

  function addFactor(label, points, max, detail) {
    const rounded = Math.round(points * 10) / 10;
    score += rounded;
    factors.push({ label, points: rounded, max, detail });
  }

  addFactor(
    'Attention duration',
    Math.min(durationMs / 6000, 1) * 20,
    20,
    `${(durationMs / 1000).toFixed(1)} s`
  );
  addFactor(
    'Mouse movement',
    Math.min(mouseMoves / 24, 1) * 20,
    20,
    plural(mouseMoves, 'move')
  );
  addFactor(
    'Direction changes',
    Math.min(directionChanges / 8, 1) * 10,
    10,
    plural(directionChanges, 'change')
  );
  addFactor(
    'Reading depth',
    Math.min(scrollDepth / 0.5, 1) * 10,
    10,
    `${Math.round(scrollDepth * 100)}%`
  );
  addFactor(
    'Scroll events',
    Math.min(scrollEvents / 4, 1) * 5,
    5,
    plural(scrollEvents, 'event')
  );
  addFactor(
    'Tab visibility',
    visibleRatio * 10,
    10,
    `${Math.round(visibleRatio * 100)}%`
  );
  addFactor(
    'Window focus',
    focusRatio * 8,
    8,
    `${Math.round(focusRatio * 100)}%`
  );
  addFactor(
    'Explicit interactions',
    Math.min((clicks * 2 + keyPresses) / 3, 1) * 2,
    2,
    `${plural(clicks, 'click')}, ${plural(keyPresses, 'key press', 'key presses')}`
  );

  if (mouseMoves / durationSeconds < 0.5 && scrollEvents < 2) {
    addFactor('Interaction too low', -8, 0, 'Almost no movement');
  }

  let finalScore = Math.round(clamp(score, 0, 100));
  if (flags.length > 0) finalScore = Math.min(finalScore, 35);

  const approved = flags.length === 0 && finalScore >= threshold;

  let reason;
  let hint = '';

  if (approved) {
    if (finalScore >= 75) {
      reason = 'Attention signal consistent with human browsing.';
    } else if (finalScore >= 60) {
      reason = 'Sufficient attention, plausible behavior.';
    } else {
      reason = 'Offer approved with a borderline score.';
    }
  } else if (flags.length > 0) {
    reason = flags[0];
    hint = 'Stay on the tab, move the mouse, and scroll the page during the check.';
  } else {
    reason = 'Attention signal too weak to approve the offer.';
    hint = 'Interact more with the page (mouse, scrolling) during the 6-second check.';
  }

  return {
    approved,
    score: finalScore,
    verdict: approved ? 'human' : 'script',
    reason,
    hint,
    threshold,
    flags,
    checks,
    factors,
    signals: {
      durationMs: Math.round(durationMs),
      pageDwellMs: Math.round(pageDwellMs),
      mouseMoves,
      directionChanges,
      scrollEvents,
      scrollDepth: Number(scrollDepth.toFixed(3)),
      clicks,
      keyPresses,
      visibleRatio: Number(visibleRatio.toFixed(3)),
      focusRatio: Number(focusRatio.toFixed(3)),
      slotVisibleRatio: slotVisibleRatio === null ? null : Number(slotVisibleRatio.toFixed(3))
    }
  };
}

module.exports = { evaluateAttention, DEFAULT_THRESHOLD, GUARD_LABELS };
