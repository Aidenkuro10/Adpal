'use strict';

/**
 * AdPal — popup
 * Shows the live balance, the connection status, the last attention
 * check, and the simulator rules.
 */

const REFRESH_MS = 2000;
const FEEDBACK_MS = 8000;

let refreshing = false;
let flushing = false;
let lastOnline = false;
let lastServerUrl = 'http://localhost:3000';
let feedbackTimer = null;

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  $('flush').addEventListener('click', flushPayout);
  $('open-demo').addEventListener('click', openDemo);

  refresh();
  setInterval(refresh, REFRESH_MS);
});

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;

  try {
    let response = await send({ type: 'ADPAL_GET_BALANCE' });

    if (!response) {
      setStatus(false, 'Service worker unavailable. Reopen the popup.');
      return;
    }

    // The simulator may have restarted on another port (3000 busy → 3001).
    // Ask the worker to re-discover it, then retry once.
    if (!response.online) {
      const found = await send({ type: 'ADPAL_DISCOVER' });
      if (found?.discovered) {
        const retry = await send({ type: 'ADPAL_GET_BALANCE' });
        if (retry) response = retry;
      }
    }

    lastOnline = Boolean(response.online);
    lastServerUrl = response.serverUrl || lastServerUrl;

    setStatus(lastOnline, response.error);

    if (response.balance) {
      renderBalance(response.balance, lastOnline);
    } else {
      renderEmpty(lastOnline);
    }

    $('server-url').textContent = lastServerUrl
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  } finally {
    refreshing = false;
  }
}

function setStatus(online, error) {
  const status = $('status');
  status.classList.toggle('online', online);
  status.classList.toggle('offline', !online);
  $('status-text').textContent = online ? 'Connected' : 'Offline';
  status.title = online
    ? 'AdPal server reachable.'
    : error || 'AdPal server unreachable. Run "npm start" in the server folder.';
}

function renderBalance(balance, online) {
  const user = balance.user || {};
  const publisher = balance.publisher || {};
  const advertiser = balance.advertiser || {};
  const rules = balance.rules || {};
  const threshold = toNumber(balance.threshold ?? rules.threshold, 0.1);
  const userBalance = toNumber(user.balance, 0);

  setText('user-balance', money(userBalance));
  setText('publisher-balance', `€${money(toNumber(publisher.balance, 0))}`);
  setText(
    'advertiser-budget',
    Number.isFinite(Number(advertiser.budget)) ? `€${money(advertiser.budget, 2)}` : '—'
  );
  setText('offers-count', String(toNumber(user.offersAccepted, 0)));

  const percent = threshold > 0
    ? Math.min(100, Math.max(0, (userBalance / threshold) * 100))
    : 0;

  $('threshold-fill').style.width = `${percent}%`;
  $('threshold-progress').setAttribute('aria-valuenow', String(Math.round(percent)));
  setText('threshold-label', `€${money(userBalance)} / €${money(threshold)}`);
  setText('threshold-percent', `${Math.floor(percent)}%`);

  const ready = userBalance + 1e-9 >= threshold;
  const button = $('flush');

  if (flushing) {
    button.disabled = true;
    button.textContent = 'Processing payout…';
  } else {
    button.disabled = !ready || !online;
    button.textContent = ready
      ? `Pay out €${money(userBalance)}`
      : `Threshold: €${money(threshold)}`;
  }

  renderLastCheck(balance, online);
  renderRules(rules, threshold);
  renderActivity(balance);
}

function renderLastCheck(balance, online) {
  const offers = Array.isArray(balance.recentOffers) ? balance.recentOffers : [];
  const last = offers[0] || null;
  const fill = $('score-fill');

  if (!last) {
    setText('last-score', '—');
    fill.style.width = '0%';
    fill.className = 'score-fill';
    setText(
      'last-reason',
      online ? 'No offers evaluated yet.' : 'Server offline — showing cached data.'
    );
    return;
  }

  const score = clamp(toNumber(last.score, 0), 0, 100);
  setText('last-score', `${Math.round(score)}/100`);
  fill.style.width = `${score}%`;
  fill.className = `score-fill ${last.approved ? 'good' : 'bad'}`;

  const verdict = last.approved ? 'Approved' : 'Rejected';
  const page = last.pageTitle ? ` · ${last.pageTitle}` : '';
  setText('last-reason', `${verdict} — ${last.reason || 'No detail provided'}${page}`);
}

function renderRules(rules, threshold) {
  const list = $('rules');
  list.replaceChildren();

  const items = [
    ['Maximum price per offer', `€${money(toNumber(rules.maxPrice, 1))}`],
    ['Your share', `${Math.round(toNumber(rules.userShare, 0.7) * 100)}%`],
    ['Grouped payout threshold', `€${money(threshold)}`],
    ['Minimum attention score', `${Math.round(toNumber(rules.humanThreshold, 50))}/100`],
    ['Activation', 'Automatic · passive'],
    ['Data transmitted', 'Aggregated signals']
  ];

  for (const [label, value] of items) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    const right = document.createElement('strong');
    left.textContent = label;
    right.textContent = value;
    li.append(left, right);
    list.append(li);
  }
}

function renderActivity(balance) {
  const offers = Array.isArray(balance.recentOffers) ? balance.recentOffers : [];
  const list = $('activity');
  const recent = offers.slice(0, 5);

  list.replaceChildren();
  setText('activity-count', recent.length ? `${recent.length} shown` : '');

  if (!recent.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No activity yet. Open the demo page to try it out.';
    list.append(empty);
    return;
  }

  for (const offer of recent) {
    const li = document.createElement('li');

    const badge = document.createElement('span');
    badge.className = `badge ${offer.approved ? 'ok' : 'ko'}`;
    badge.textContent = offer.approved
      ? `+€${money(toNumber(offer.split?.user, 0))}`
      : 'Rejected';

    const meta = document.createElement('div');
    meta.className = 'activity-meta';

    const title = document.createElement('strong');
    title.textContent = offer.pageTitle || 'Untitled page';

    const detail = document.createElement('span');
    const score = offer.score === null || offer.score === undefined ? '—' : offer.score;
    detail.textContent = `${timeAgo(offer.at)} · score ${score}/100 · ${offer.publisher || 'unknown publisher'}`;

    meta.append(title, detail);
    li.append(badge, meta);
    list.append(li);
  }
}

function renderEmpty(online) {
  setText('user-balance', '0.000');
  setText('publisher-balance', '€0.000');
  setText('advertiser-budget', '—');
  setText('offers-count', '0');
  setText('threshold-label', '€0.000 / €0.100');
  setText('threshold-percent', '0%');

  $('threshold-fill').style.width = '0%';
  $('threshold-progress').setAttribute('aria-valuenow', '0');

  const button = $('flush');
  button.disabled = true;
  button.textContent = 'Threshold: €0.100';

  setText('last-score', '—');
  $('score-fill').style.width = '0%';
  $('score-fill').className = 'score-fill';
  setText(
    'last-reason',
    online ? 'No offers evaluated yet.' : 'Server offline — no cached data available.'
  );

  const list = $('activity');
  list.replaceChildren();
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = online
    ? 'No activity yet. Open the demo page to try it out.'
    : 'Activity unavailable offline.';
  list.append(empty);
  setText('activity-count', '');
}

async function flushPayout() {
  if (flushing) return;

  flushing = true;
  const button = $('flush');
  button.disabled = true;
  button.textContent = 'Processing payout…';
  hideFeedback();

  const response = await send({ type: 'ADPAL_FLUSH_PAYOUT' });
  flushing = false;

  if (response?.ok && response.data?.settled) {
    const payout = response.data.payout || {};
    const batch = response.data.paypal || payout.paypal || {};
    const chain = response.data.solana || payout.solana || {};
    const amount = toNumber(payout.userAmount, 0);
    if (chain.signature) {
      // The devnet rail returns a transaction signature rather than a batch id;
      // show it truncated, the terminal has the full explorer link.
      const signature = String(chain.signature);
      showFeedback(
        `Solana ${chain.pending ? 'pending' : String(chain.status || 'confirmed').toLowerCase()} · ` +
          `${signature.slice(0, 8)}…${signature.slice(-6)} · €${money(amount)}`,
        true
      );
    } else {
      showFeedback(
        batch.batchId
          ? `PayPal ${String(batch.status || 'PENDING').toLowerCase()} · batch ${batch.batchId} · €${money(amount)}`
          : `Payout of €${money(amount)} sent (ref. ${payout.id || '—'}).`,
        true
      );
    }
  } else {
    showFeedback(
      response?.data?.message || response?.error || 'Payout unavailable right now.',
      false
    );
  }

  await refresh();
}

function showFeedback(text, success) {
  const element = $('flush-feedback');
  element.textContent = text;
  element.className = `feedback ${success ? 'ok' : 'ko'}`;
  element.hidden = false;

  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    element.hidden = true;
  }, FEEDBACK_MS);
}

function hideFeedback() {
  clearTimeout(feedbackTimer);
  $('flush-feedback').hidden = true;
}

function openDemo() {
  const base = lastServerUrl.replace(/\/+$/, '');
  chrome.tabs.create({ url: `${base}/demo/` });
}

function setText(id, text) {
  const element = $(id);
  if (element) element.textContent = text;
}

function money(value, digits = 3) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(toNumber(value, 0));
}

function toNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'just now';

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
