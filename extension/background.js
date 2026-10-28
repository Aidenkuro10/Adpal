'use strict';

/**
 * AdPal — service worker (Manifest V3)
 *
 * The only component that talks to the local server. It:
 *  - discovers the simulator port automatically (3000 by default, but the
 *    server may fall back to 3001, 3002… when a port is already taken);
 *  - centralizes HTTP calls (offer, balance, payout);
 *  - caches the last known state so the popup stays readable offline;
 *  - attaches an anonymous client ID to offer requests.
 *
 * Discovery order: the origin of the page that asked (a publisher served by
 * the simulator knows its own port), then the cached URL, then a local scan.
 */

const DEFAULT_SERVER_URL = 'http://localhost:3000';
const CACHE_KEY = 'adpal:cache';
const CLIENT_KEY = 'adpal:clientId';
const REQUEST_TIMEOUT_MS = 8000;
const HEALTH_TIMEOUT_MS = 800;
const SCAN_START_PORT = 3000;
const SCAN_PORT_COUNT = 11;

/** Errors raised before any HTTP response was received. */
function isNetworkError(error) {
  return Boolean(error && error.offline === true);
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function emptyCache() {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    online: false,
    balance: null,
    discoveredAt: null,
    lastCheckedAt: null,
    lastError: null,
    lastOffer: null
  };
}

async function getCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return { ...emptyCache(), ...(stored[CACHE_KEY] || {}) };
}

async function patchCache(patch) {
  const next = { ...(await getCache()), ...patch };
  await chrome.storage.local.set({ [CACHE_KEY]: next });
  return next;
}

async function getClientId() {
  const stored = await chrome.storage.local.get(CLIENT_KEY);
  if (stored[CLIENT_KEY]) return stored[CLIENT_KEY];

  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  await chrome.storage.local.set({ [CLIENT_KEY]: id });
  return id;
}

/* ------------------------------------------------------------------ */
/* Port discovery                                                      */
/* ------------------------------------------------------------------ */

/**
 * Probes `/api/health` on an origin. Returns the payload when an AdPal
 * simulator answers, otherwise null. Never throws.
 */
async function probeHealth(baseUrl, timeoutMs = HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) return null;

    const data = await response.json();
    return data?.service === 'adpal-simulator' ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ordered, de-duplicated list of origins worth probing. */
function candidateOrigins(hint, cached) {
  const list = [];
  const add = (value) => {
    const origin = normalizeOrigin(value);
    if (origin && !list.includes(origin)) list.push(origin);
  };

  add(hint);
  add(cached);
  add(DEFAULT_SERVER_URL);

  for (let offset = 0; offset < SCAN_PORT_COUNT; offset += 1) {
    add(`http://localhost:${SCAN_START_PORT + offset}`);
    add(`http://127.0.0.1:${SCAN_START_PORT + offset}`);
  }

  return list;
}

/**
 * Finds the running simulator. The hint and the cached URL get a quick
 * sequential check (the common case), then the remaining ports are probed in
 * parallel so a cold discovery stays fast.
 */
async function discoverServerUrl({ hint, cached } = {}) {
  const candidates = candidateOrigins(hint, cached);
  const priority = candidates.slice(0, 3);
  const remainder = candidates.slice(3);

  for (const url of priority) {
    const health = await probeHealth(url);
    if (health) return { url, health, port: health.port ?? null };
  }

  if (remainder.length === 0) return null;

  const results = await Promise.all(
    remainder.map(async (url) => ({ url, health: await probeHealth(url, 600) }))
  );

  const hit = results.find((result) => result.health);
  return hit ? { url: hit.url, health: hit.health, port: hit.health.port ?? null } : null;
}

/** Resolves an origin, remembering it in the cache for later calls. */
async function resolveServerUrl(hint) {
  const cache = await getCache();
  const found = await discoverServerUrl({ hint, cached: cache.serverUrl });

  if (!found) return { url: normalizeOrigin(hint) || cache.serverUrl, discovered: false };

  if (found.url !== cache.serverUrl) {
    await patchCache({ serverUrl: found.url, discoveredAt: Date.now() });
  }

  return { url: found.url, discovered: true };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/**
 * Single HTTP call against a known origin.
 *
 * On a network-level failure the error is flagged `offline` so the caller can
 * re-discover the port and retry. HTTP errors carry `status` and `payload` so
 * the popup can surface the server message (e.g. threshold not reached).
 */
async function apiFetch(baseUrl, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;

  try {
    let response;
    try {
      response = await fetch(url, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      const offline = new Error(
        error?.name === 'AbortError'
          ? 'The AdPal server is not responding (request timed out).'
          : 'AdPal server unreachable. Run "npm start" in the server folder.'
      );
      offline.offline = true;
      throw offline;
    }

    const raw = await response.text();
    let payload = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const error = new Error(
        payload?.message || payload?.error || `Server error (${response.status})`
      );
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * HTTP call with automatic port recovery: on a network failure the worker
 * looks for the simulator again (it may have restarted on another port) and
 * replays the request once.
 */
async function apiRequest(path, options = {}) {
  const cache = await getCache();
  const hint = normalizeOrigin(options.hint);
  const baseUrl = hint || cache.serverUrl || DEFAULT_SERVER_URL;

  try {
    return await apiFetch(baseUrl, path, options);
  } catch (error) {
    if (!isNetworkError(error)) throw error;

    const found = await discoverServerUrl({ hint, cached: cache.serverUrl });
    if (!found || found.url === baseUrl) throw error;

    await patchCache({ serverUrl: found.url, discoveredAt: Date.now() });
    return apiFetch(found.url, path, options);
  }
}

/* ------------------------------------------------------------------ */
/* API helpers                                                         */
/* ------------------------------------------------------------------ */

async function getBalance(options = {}) {
  try {
    const balance = await apiRequest('/api/balance', options);
    const cache = await patchCache({
      online: true,
      balance,
      lastCheckedAt: Date.now(),
      lastError: null
    });
    return {
      ok: true,
      online: true,
      balance,
      serverUrl: cache.serverUrl,
      lastCheckedAt: cache.lastCheckedAt
    };
  } catch (error) {
    const cache = await patchCache({
      online: false,
      lastError: error.message,
      lastCheckedAt: Date.now()
    });
    return {
      ok: true,
      online: false,
      balance: cache.balance,
      serverUrl: cache.serverUrl,
      lastCheckedAt: cache.lastCheckedAt,
      error: error.message
    };
  }
}

async function requestOffer(payload) {
  try {
    const clientId = await getClientId();
    const body = {
      clientId,
      /*
       * Impression identity, carried by the caller so its own retry reuses it.
       *
       * The server credits money and starts a payout for every approved offer,
       * so a retry without a stable id would sell (and pay for) the same
       * impression twice. When the caller does not supply one, it is generated
       * here, which keeps a single call idempotent even if the transport
       * retries it.
       */
      impressionId:
        payload?.impressionId ||
        (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`),
      price: payload?.price,
      signals: payload?.signals || {},
      page: payload?.page || {},
      slot: payload?.slot || {}
    };

    const data = await apiRequest('/api/offer', {
      method: 'POST',
      body,
      // The publisher page is served by the simulator itself, so its origin is
      // the most reliable port hint available.
      hint: payload?.serverHint
    });

    const lastOffer = {
      at: Date.now(),
      approved: Boolean(data?.approved),
      score: typeof data?.score === 'number' ? data.score : null,
      reason: data?.reason || '',
      reward: data?.split?.user ?? 0,
      price: data?.price ?? null
    };

    const cache = await patchCache({
      online: true,
      balance: data?.balance ?? null,
      lastCheckedAt: Date.now(),
      lastError: null,
      lastOffer
    });

    return { ok: true, data, serverUrl: cache.serverUrl };
  } catch (error) {
    const reachable = typeof error.status === 'number';
    const cache = await patchCache({
      online: reachable,
      lastError: error.message,
      lastCheckedAt: Date.now()
    });
    return {
      ok: false,
      error: error.message,
      status: error.status ?? null,
      data: error.payload ?? null,
      serverUrl: cache.serverUrl
    };
  }
}

/**
 * Relays a silent session event from the content script to the simulator.
 *
 * The publication page displays nothing; the event exists for the agent
 * terminal at /terminal/. Failures are swallowed because losing a telemetry
 * line must never interrupt the reader.
 */
async function relayClientEvent(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.title !== 'string') {
    return { ok: false, error: 'Invalid client event.' };
  }

  // Skip quietly while the simulator is known to be offline: otherwise every
  // sample would trigger a port scan from the service worker.
  const cache = await getCache();
  if (cache.online === false) return { ok: false, skipped: 'offline' };

  try {
    await apiRequest('/api/client-event', {
      method: 'POST',
      body: {
        kind: payload.kind,
        level: payload.level,
        title: payload.title,
        detail: payload.detail,
        data: payload.data,
        host: payload.host,
        url: payload.url,
        client: await getClientId()
      },
      hint: payload.serverHint
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Relay failed.' };
  }
}

/**
 * Forwards a presence heartbeat.
 *
 * Presence is deliberately *not* a telemetry event: the terminal would drown in
 * a ping every four seconds. It only tells the server that a visible reader
 * exists, which is what authorises an impression and, later, the payout that
 * impression funds.
 *
 * Failures are swallowed like every other relay: losing a beat only means the
 * server's TTL expires the session, and the next beat recreates it.
 */
async function relayPresence(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Invalid presence payload.' };
  }

  const cache = await getCache();
  if (cache.online === false) return { ok: false, skipped: 'offline' };

  try {
    const data = await apiRequest('/api/presence', {
      method: 'POST',
      body: {
        clientId: await getClientId(),
        state: payload.state === 'hidden' ? 'hidden' : payload.state === 'closing' ? 'closing' : 'active',
        page: payload.page || {},
        slot: payload.slot || '',
        host: payload.host || ''
      },
      hint: payload.serverHint
    });
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error?.message || 'Presence relay failed.' };
  }
}

async function flushPayout(options = {}) {
  try {
    const data = await apiRequest('/api/flush-payout', { ...options, method: 'POST', body: {} });
    await patchCache({
      online: true,
      balance: data?.balance ?? null,
      lastCheckedAt: Date.now(),
      lastError: null
    });
    return { ok: true, data };
  } catch (error) {
    if (error.payload?.balance) {
      await patchCache({ balance: error.payload.balance, online: true, lastError: error.message });
    }
    return {
      ok: false,
      error: error.message,
      status: error.status ?? null,
      data: error.payload ?? null
    };
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  const cache = await getCache();
  await chrome.storage.local.set({ [CACHE_KEY]: cache });

  const found = await discoverServerUrl({ cached: cache.serverUrl });
  if (found) {
    await patchCache({ serverUrl: found.url, discoveredAt: Date.now() });
  }

  console.info('[AdPal] Extension installed. Server:', found?.url || cache.serverUrl);
});

chrome.runtime.onStartup.addListener(async () => {
  const cache = await getCache();
  const found = await discoverServerUrl({ cached: cache.serverUrl });
  if (found && found.url !== cache.serverUrl) {
    await patchCache({ serverUrl: found.url, discoveredAt: Date.now() });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  (async () => {
    switch (message.type) {
      case 'ADPAL_REQUEST_OFFER':
        return requestOffer(message.payload);
      case 'ADPAL_GET_BALANCE':
        return getBalance({ hint: message.payload?.hint });
      case 'ADPAL_FLUSH_PAYOUT':
        return flushPayout({ hint: message.payload?.hint });
      case 'ADPAL_CLIENT_EVENT':
        return relayClientEvent(message.payload);
      case 'ADPAL_PRESENCE':
        return relayPresence(message.payload);
      case 'ADPAL_DISCOVER':
        return { ok: true, ...(await resolveServerUrl(message.payload?.hint)) };
      case 'ADPAL_GET_STATE':
        return { ok: true, ...(await getCache()) };
      default:
        return { ok: false, error: `Unknown message: ${message.type}` };
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || 'Internal error.' }));

  // Asynchronous response.
  return true;
});
