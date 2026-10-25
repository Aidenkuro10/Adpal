'use strict';

/**
 * AdPal — local simulator.
 *
 * Express serves three separate surfaces:
 *  - the extension API (/api/...);
 *  - the fictional newspaper page, with no debug chrome (/demo/);
 *  - the agent terminal, a dedicated JSON log view (/terminal/) fed by SSE.
 *
 * Presentation is deliberately split: the article a reader sees contains no
 * telemetry UI, and the terminal contains no editorial content.
 */

const path = require('path');
const express = require('express');
const cors = require('cors');

const config = require('./src/config');
const { evaluateAttention, GUARD_LABELS } = require('./src/heuristic');
const { Ledger, round4, MICROS_PER_EURO } = require('./src/ledger');
const { Presence } = require('./src/presence');
const { createWebhookReconciler } = require('./src/webhook-reconciler');
const { Telemetry } = require('./src/telemetry');
const { CREATIVES, creativePayload } = require('./src/creatives');
const { AdvertiserRotation } = require('./src/rotation');
const paypal = require('./src/paypal');
const solana = require('./src/solana');
const toolkit = require('./src/paypal-agent-toolkit');
const agentCognition = require('./src/agent-cognition');
const { L402Issuer, describe, parse: parseMacaroon } = require('./src/l402');
const l402Contract = require('./src/l402-contract');
const { serveView } = require('./src/view-assets');

const { PROTOCOL: L402_PROTOCOL, STATES: L402_STATES, DEFAULT_OFFER_ID: L402_OFFER_ID } = l402Contract;

const app = express();
const ledger = new Ledger(config);
const telemetry = new Telemetry();
// Single source of truth for "is a reader actually on the page right now".
const presence = new Presence({ ttlMs: config.presence.ttlMs });
const l402 = new L402Issuer({ rootKey: config.l402.rootKey, ttlMs: config.l402.ttlMs });
const l402Sessions = new l402Contract.L402Contexts({ ttlMs: config.l402.ttlMs });
// Rotates distinct advertiser profiles across placements and over time.
const rotation = new AdvertiserRotation({
  creatives: CREATIVES,
  minPrice: Math.min(config.defaultOfferPrice, config.maxOfferPrice)
});

// The aggregate advertiser escrow is the sum of the individual campaigns, so
// the old single-advertiser budget check can never contradict the rotation.
ledger.setAdvertiserBudget(rotation.totalBudget({ initial: true }));

// Resolved at startup: the preferred port when free, otherwise the next free one.
const serverState = { port: config.port, url: `http://localhost:${config.port}` };

// Simple anti-spam: at most one offer per second per client.
const lastOfferByClient = new Map();
// Debounces "no active reader" warnings so a probing script cannot fill the
// terminal with one line per refused request.
const lastPresenceWarnAt = new Map();
const OFFER_COOLDOWN_MS = 1000;

app.disable('x-powered-by');
app.set('json spaces', 2);
app.use(cors());

/*
 * HTTP access log — this is what "the logs" means on a hosted platform.
 *
 * `emit()` below writes to an in-memory ring buffer and pushes to SSE
 * subscribers; it never touches stdout. That is fine locally, where the
 * terminal view is the log surface, but on Render/Fly/Railway the log stream is
 * stdout/stderr. Without this middleware a request leaves no trace there at
 * all — not a 200, not a 404 from a mistyped path, not a 401 from a rejected
 * webhook signature — which makes "the webhook never arrived" impossible to
 * distinguish from "the webhook arrived and was refused".
 *
 * Mounted before the body parsers so a request rejected while parsing (413,
 * 400 on malformed JSON) is still logged, and written on `finish` so it fires
 * for every response, including ones that never reach a route.
 */
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // PayPal's transmission id is the only identifier that lets an operator
    // line a log entry up with the event in the PayPal dashboard.
    const transmissionId = req.get('paypal-transmission-id');
    console.log(
      `[http] ${req.method} ${req.originalUrl} → ${res.statusCode} · ${ms.toFixed(1)}ms` +
        (transmissionId ? ` · paypal-transmission-id=${transmissionId}` : '')
    );
  });
  next();
});

/*
 * PayPal signs the exact bytes it sent, so the webhook route needs the raw
 * buffer, not a re-serialised object. Mounting a raw parser on that path before
 * the global JSON parser means `express.json()` sees `req._body` already set and
 * skips that route, while every other route keeps its existing behaviour.
 *
 * Order matters: if this line ever moves below `express.json()`, the buffer is
 * gone and signature verification has nothing faithful to check.
 */
app.use('/api/webhooks/paypal', express.raw({ type: () => true, limit: '128kb' }));

app.use(express.json({ limit: '32kb' }));

/*
 * Local development: nothing is cacheable.
 *
 * The demo is edited and re-read constantly, so a 304 (or any stored response)
 * is a stale-asset bug waiting to happen. `no-store` on every response, plus
 * ETags disabled below, means a plain refresh always re-reads from disk.
 * Set NODE_ENV=production to opt into normal revalidation.
 */
if (!config.isProduction) {
  app.disable('etag');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sanitizeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function money(value) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  }).format(value);
}

/** Short, non-identifying client label for the terminal stream. */
function clientLabel(clientId) {
  return String(clientId).slice(0, 10);
}

function emit(event) {
  return telemetry.emit(event);
}

/**
 * Publishes the advertiser agents' reasoning on the SSE stream.
 *
 * Two events are emitted per impression:
 *
 *  - `agent.reasoning` — the whole auction: every agent's scored bid, the step
 *    trace and the token/latency cost of the call.
 *  - `agent.bid` — the winner's natural-language case, in `detail`, so it is
 *    readable without expanding JSON.
 *
 * Both carry a `cognition` envelope so the terminal can render any agent
 * thought with one component, whichever provider produced it.
 */
function emitBidReasoning(negotiation, { slotKey = '', price = 0, pageTitle = '' } = {}) {
  if (!negotiation) return;
  const cognition = agentCognition.cognitionEnvelope(negotiation);
  const bidding = negotiation.bids.filter((bid) => bid.verdict === 'bid').length;
  const tokens = negotiation.usage?.totalTokens ?? 0;

  emit({
    stage: 'agent.reasoning',
    source: 'advertiser.agent',
    level: negotiation.winner ? 'ok' : 'warn',
    title: `Bid reasoning · ${bidding}/${negotiation.bids.length} agent${negotiation.bids.length === 1 ? '' : 's'} bidding`,
    detail:
      `${negotiation.provider} · ${negotiation.model} · ${tokens} tokens ` +
      `(${negotiation.usage?.promptTokens ?? 0} prompt + ${negotiation.usage?.completionTokens ?? 0} completion)` +
      `${negotiation.usage?.estimated ? ' est' : ''} · ${negotiation.latencyMs} ms` +
      (negotiation.fallback
        ? ` · fallback from ${negotiation.fallbackProvider || 'hosted'}`
        : negotiation.degraded
          ? ' · degraded to local'
          : ''),
    data: {
      phase: 'negotiate',
      slotKey,
      price,
      pageTitle,
      pageProfile: negotiation.pageProfile,
      floor: negotiation.floor,
      winnerId: negotiation.winnerId,
      bids: negotiation.bids,
      cognition
    }
  });

  const winnerBid = negotiation.bids.find((bid) => bid.agentId === negotiation.winnerId);
  if (!winnerBid) return;

  emit({
    stage: 'agent.bid',
    source: 'advertiser.agent',
    level: 'ok',
    title: `Bid rationale · ${winnerBid.sponsor}`,
    detail: winnerBid.rationale,
    data: {
      phase: 'bid',
      agentId: winnerBid.agentId,
      agent: winnerBid.name,
      sponsor: winnerBid.sponsor,
      objective: winnerBid.objective,
      verdict: winnerBid.verdict,
      bid: winnerBid.bid,
      relevance: winnerBid.relevance,
      confidence: winnerBid.confidence,
      components: winnerBid.components,
      evidence: winnerBid.evidence,
      rationale: winnerBid.rationale,
      // The auction trace was already published by `agent.reasoning`; repeating
      // it here would double every step in the stream. The envelope still
      // carries provider/model/token cost for this specific rationale.
      cognition: { ...cognition, steps: [] }
    }
  });

  console.log(
    `[agent] ${winnerBid.sponsor} bids €${winnerBid.bid.toFixed(3)} · relevance ${winnerBid.relevance.toFixed(2)} · ${negotiation.provider}/${negotiation.model}`
  );
}

/**
 * Publishes the verification agent's reading of the telemetry.
 *
 * The narrative explains the heuristic; it never replaces it. `assessment.score`
 * and `assessment.approved` are copied from `heuristic.js`, so the money
 * decision cannot be talked into a different verdict by a model.
 */
function emitAttentionReasoning(assessment) {
  if (!assessment) return;

  emit({
    stage: 'agent.attention',
    source: 'attention.agent',
    level: assessment.approved ? 'ok' : 'warn',
    title: `Attention reasoning · ${assessment.verdict}`,
    detail: assessment.narrative,
    data: {
      phase: 'attention',
      verdict: assessment.verdict,
      approved: assessment.approved,
      score: assessment.score,
      threshold: assessment.threshold,
      confidence: assessment.confidence,
      disagreement: assessment.disagreement,
      signature: assessment.signature,
      narrative: assessment.narrative,
      cognition: agentCognition.cognitionEnvelope(assessment)
    }
  });

  console.log(
    `[agent] attention ${assessment.verdict} · confidence ${assessment.confidence} · ${assessment.narrative.slice(0, 150)}`
  );
}

/*
 * PayPal Agent Toolkit bridge.
 *
 * The toolkit checkout declares the sandbox MCP server and the Payouts
 * contract; this wires its tools to the two server-side agents. The profile is
 * resolved once at boot, so a missing folder degrades to "not present" instead
 * of stopping the simulator.
 */
toolkit.configure({ paypal, ledger, emit });
const TOOLKIT = toolkit.profile();

/**
 * Ledger snapshot plus the non-secret PayPal settings the terminal needs to
 * label the panel (mode, recipient, whether the API is configured). The
 * advertiser roster and toolkit profile have their own endpoints so this stays
 * the same shape on every response.
 */
function snapshot() {
  return {
    ...ledger.snapshot(),
    presence: presence.snapshot(),
    paypal: paypal.publicProfile(),
    solana: solana.publicProfile(),
    payoutRail: config.payoutRail
  };
}

/**
 * Which rail a payout request should use.
 *
 * `paypal_payouts` and `solana-devnet` are the only two valid names; anything
 * else falls back to the configured default so a typo in a demo script cannot
 * silently disable settlement.
 */
const RAILS = Object.freeze({ PAYPAL: 'paypal_payouts', SOLANA: 'solana-devnet' });

function normalizeRail(value) {
  const rail = String(value || '').trim().toLowerCase();
  if (rail === RAILS.SOLANA || rail === 'solana' || rail === 'sol') return RAILS.SOLANA;
  if (rail === RAILS.PAYPAL || rail === 'paypal') return RAILS.PAYPAL;
  return config.payoutRail === RAILS.SOLANA ? RAILS.SOLANA : RAILS.PAYPAL;
}

/** Whether the named rail can actually move money right now. */
function railReady(rail) {
  return rail === RAILS.SOLANA ? solana.isEnabled() : paypal.isConfigured();
}

/* ------------------------------------------------------------------ */
/* PayPal payload mirror                                               */
/* ------------------------------------------------------------------ */

/*
 * The terminal view shows the real request and response bodies of the PayPal
 * rail, not a summary. paypal.js redacts secrets before handing them over; we
 * only add the wrapper the stream expects.
 */
paypal.observe((event) => {
  emit({
    stage: event.stage,
    source: 'paypal.rail',
    level: event.level === 'error' ? 'error' : 'info',
    title: event.title,
    detail: event.detail,
    data: event.data || null
  });
});

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'adpal-simulator',
    version: config.version,
    port: serverState.port,
    demoUrl: `${serverState.url}/demo/`,
    terminalUrl: `${serverState.url}/terminal/`,
    logsUrl: `${serverState.url}/api/logs`,
    uptimeSeconds: Math.round(process.uptime()),
    toolkit: {
      present: TOOLKIT.present,
      version: TOOLKIT.version,
      tools: TOOLKIT.tools.length,
      mcp: TOOLKIT.mcp?.url || null
    },
    agents: rotation.roster.map((entry) => entry.agent.id),
    cognition: agentCognition.publicProfile(),
    rails: {
      active: config.payoutRail,
      paypal: paypal.isConfigured(),
      solana: solana.isEnabled()
    },
    solana: {
      cluster: config.solana.cluster,
      rpcUrl: config.solana.rpcUrl,
      anchorProofs: config.solana.anchorProofs
    },
    now: new Date().toISOString()
  });
});

/**
 * GET /api/solana — the devnet rail profile, live balances and funding help.
 *
 * Balances come from the cluster, so this is also the quickest way to tell
 * whether the treasury can actually pay for an anchor or a transfer.
 */
app.get('/api/solana', async (_req, res) => {
  const profile = solana.publicProfile();
  const balances = await solana.balances();
  res.set('Cache-Control', 'no-store');
  res.json({
    ...profile,
    balances,
    faucetUrl: `https://faucet.solana.com?address=${profile.treasury || ''}&network=devnet`,
    explorerUrl: profile.treasury ? solana.addressUrl(profile.treasury) : profile.explorerBase,
    payoutRail: config.payoutRail,
    rails: { paypal: paypal.isConfigured(), solana: solana.isEnabled() },
    split: { userShare: config.userShare, publisherShare: config.publisherShare },
    memoFormat: 'ADPAL/v1|kind=<proof|payout>|hash=<sha256(preimage)>|ref=<reference>',
    endpoints: {
      confirm: '/api/l402/solana/confirm',
      fund: '/api/solana/fund',
      payout: '/api/payout'
    }
  });
});

/**
 * POST /api/solana/fund — retries the devnet faucet for the treasury.
 *
 * The public faucet is rate-limited per IP, so this is deliberately a manual
 * action: it reports the exact address to fund when the faucet refuses.
 */
app.post('/api/solana/fund', async (req, res) => {
  const body = requestBody(req);
  const lamports = Math.max(
    5_000,
    Math.round((Number(body.sol) || config.solana.airdropSol) * 1e9)
  );

  try {
    const profile = solana.publicProfile();
    const funding = await solana.ensureFunded(lamports);
    emit({
      stage: 'solana.funding',
      source: 'solana.rail',
      level: 'ok',
      title: 'Devnet treasury funded',
      detail: `${profile.treasury} · balance ${funding.balance} lamports${funding.airdropped ? ` · airdropped ${funding.airdropped}` : ''}`,
      data: { trigger: 'manual', ...funding, treasury: profile.treasury }
    });
    res.json({ ok: true, ...funding, treasury: profile.treasury, balance: snapshot() });
  } catch (error) {
    emit({
      stage: 'solana.funding',
      source: 'solana.rail',
      level: 'error',
      title: 'Devnet treasury could not be funded',
      detail: error?.message || 'Unknown faucet error',
      data: { code: error?.code || 'SOLANA_FUNDING_FAILED' }
    });
    res.status(error?.status || 502).json({
      ok: false,
      error: error?.code || 'SOLANA_FUNDING_FAILED',
      message: error?.message || 'Unknown faucet error',
      treasury: solana.publicProfile().treasury,
      faucetUrl: `https://faucet.solana.com?address=${solana.publicProfile().treasury || ''}&network=devnet`
    });
  }
});

/**
 * GET /api/toolkit — the PayPal Agent Toolkit capability profile.
 * Proves the checkout was read, not hard-coded: version, MCP endpoint, skills,
 * reference documents and the tools this server exposes to its agents.
 */
app.get('/api/toolkit', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ...TOOLKIT, callable: toolkit.toolNames() });
});

/** GET /api/agents — the advertiser roster and its campaign budgets. */
app.get('/api/agents', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    rotation: rotation.snapshot(),
    split: { userShare: config.userShare, publisherShare: config.publisherShare },
    autoPayout: config.paypal.autoPayout,
    payoutRail: config.payoutRail,
    cognition: agentCognition.publicProfile(),
    rails: {
      paypal: { ready: paypal.isConfigured(), label: RAILS.PAYPAL },
      solana: { ready: solana.isEnabled(), label: RAILS.SOLANA, profile: solana.publicProfile() }
    },
    currency: config.currency
  });
});

app.get('/api/balance', (_req, res) => {
  res.json(snapshot());
});

/**
 * Incremental telemetry feed.
 * GET /api/telemetry?since=<seq> returns the next negotiation events.
 * Kept alongside the SSE stream so the extension, tests and scripts can poll
 * without holding a socket open.
 */
app.get('/api/telemetry', (req, res) => {
  const rawSince = Number.parseInt(req.query.since, 10);
  const rawLimit = Number.parseInt(req.query.limit, 10);
  const since = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 80, 1), 200);

  res.set('Cache-Control', 'no-store');
  res.json({
    seq: telemetry.seq,
    events: telemetry.since(since, limit),
    guards: GUARD_LABELS,
    rules: {
      humanThreshold: config.humanThreshold,
      userShare: config.userShare,
      publisherShare: config.publisherShare,
      payoutThreshold: config.payoutThreshold,
      maxPrice: config.maxOfferPrice,
      payoutRail: config.payoutRail
    },
    paypal: paypal.publicProfile(),
    cognition: agentCognition.publicProfile(),
    l402: {
      issuer: 'adpal.simulator',
      scheme: 'L402',
      ttlMs: config.l402.ttlMs,
      agents: rotation.roster.map((entry) => ({
        id: entry.agent.id,
        name: entry.agent.name,
        bid: entry.agent.bid,
        sponsor: entry.sponsor,
        objective: entry.objective,
        budget: entry.budget
      }))
    },
    advertisers: rotation.snapshot(),
    toolkit: TOOLKIT
  });
});

/**
 * Server-sent event stream for the agent terminal.
 *
 * GET /api/logs            → live stream from now
 * GET /api/logs?since=42   → replay from sequence 42, then live
 *
 * EventSource reconnects automatically and sends `Last-Event-ID`, so a dropped
 * connection resumes exactly where it stopped instead of replaying the demo.
 */
app.get('/api/logs', (req, res) => {
  // Express routes HEAD to GET handlers; an endless stream would leave the
  // request open, so answer the probe and stop.
  if (req.method === 'HEAD') {
    res.status(200).set('Content-Type', 'text/event-stream; charset=utf-8').end();
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and most reverse proxies buffer text/event-stream by default.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const lastEventId = Number.parseInt(req.headers['last-event-id'], 10);
  const rawSince = Number.parseInt(req.query.since, 10);
  const hasSince = req.query.since !== undefined;
  // `live=1` opens the stream at "now" with no replay. The agent terminal uses
  // it so Act 1 always starts clean instead of inheriting the previous run.
  const liveOnly = req.query.live === '1' || req.query.live === 'true';

  // A fresh terminal shows the recent tail so the page is never empty during a
  // demo; a reconnecting EventSource resumes from Last-Event-ID instead.
  const cursor = Number.isFinite(lastEventId)
    ? lastEventId
    : hasSince && Number.isFinite(rawSince)
      ? Math.max(0, rawSince)
      : liveOnly
        ? telemetry.seq
        : Math.max(0, telemetry.seq - 40);

  // A live SSE stream must not wait on Nagle or on a corked socket: the whole
  // point is that an impression on /demo/ shows in /terminal/ in the same tick.
  res.flushHeaders?.();
  req.socket?.setNoDelay?.(true);
  req.socket?.setKeepAlive?.(true, 5000);

  const send = (event) => {
    if (res.writableEnded) return;
    try {
      // One write per event. Three separate writes let the frame be split across
      // packets, and an EventSource that receives `id:`/`event:` without its
      // `data:` line has nothing to dispatch yet.
      res.write(
        `id: ${event.seq}\nevent: log\ndata: ${JSON.stringify(event)}\n\n`
      );
    } catch {
      // The socket closed between the writableEnded check and the write.
    }
  };

  // Ask the browser to reconnect quickly, then describe the stream itself.
  res.write('retry: 1000\n\n');
  res.write('event: hello\n');
  res.write(
    `data: ${JSON.stringify({
      service: 'adpal-simulator',
      version: config.version,
      stream: '/api/logs',
      seq: telemetry.seq,
      cursor,
      live: liveOnly && !Number.isFinite(lastEventId) && !hasSince,
      connectedAt: new Date().toISOString(),
      currency: config.currency,
      rules: {
        humanThreshold: config.humanThreshold,
        userShare: config.userShare,
        publisherShare: config.publisherShare,
        payoutThreshold: config.payoutThreshold
      },
      l402: { scheme: 'L402', ttlMs: config.l402.ttlMs },
      agents: rotation.roster.map((entry) => ({
        id: entry.agent.id,
        name: entry.agent.name,
        bid: entry.agent.bid,
        sponsor: entry.sponsor,
        objective: entry.objective,
        budget: entry.budget
      })),
      autoPayout: config.paypal.autoPayout,
      presence: presence.snapshot(),
      payoutRail: config.payoutRail,
      cognition: agentCognition.publicProfile(),
      toolkit: {
        present: TOOLKIT.present,
        version: TOOLKIT.version,
        mcp: TOOLKIT.mcp?.url || null,
        tools: TOOLKIT.tools.map((tool) => tool.name)
      },
      solana: solana.publicProfile(),
      paypal: paypal.publicProfile()
    })}\n\n`
  );

  // Replay the gap, capped so a long-idle tab cannot dump 500 events at once.
  for (const event of telemetry.since(cursor, 200)) send(event);

  const unsubscribe = telemetry.subscribe(send);

  // Comment frames keep intermediaries from closing an idle connection.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    if (!res.writableEnded) res.end();
  };

  req.on('close', close);
  req.on('error', close);
});

/**
 * POST /api/presence
 *
 * The reader's heartbeat. Deliberately does **not** emit a telemetry event: a
 * ping every few seconds would drown the terminal, and presence is state, not
 * an event. Returns the live count so the content script can back off or the
 * terminal header can show "1 reader live".
 *
 * Presence is what every value-touching route consults, so this is the only
 * thing that can make an impression possible.
 */
app.post('/api/presence', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = presence.touch({
    clientId: sanitizeText(body.clientId, 64),
    state: body.state === 'hidden' ? 'hidden' : body.state === 'closing' ? 'closing' : 'active',
    page: {
      title: sanitizeText(body.page?.title, 120),
      host: sanitizeText(body.page?.host, 120)
    },
    slot: sanitizeText(body.slot, 40),
    userAgent: sanitizeText(req.get('user-agent'), 160)
  });

  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.reason, presence: presence.snapshot() });
  }

  res.json({
    ok: true,
    state: result.state || 'ended',
    ttlMs: config.presence.ttlMs,
    presence: presence.snapshot()
  });
});

/**
 * POST /api/client-event
 *
 * Silent sink for the content script's session events. The article page never
 * renders these; they exist so the terminal can show what the extension saw
 * while the reader was simply reading.
 */
app.post('/api/client-event', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const title = sanitizeText(body.title, 140);
  if (!title) {
    return res.status(400).json({ ok: false, error: 'MISSING_TITLE' });
  }

  const kind = sanitizeText(body.kind, 40) || 'client.event';
  const level = ['info', 'ok', 'warn', 'error'].includes(body.level) ? body.level : 'info';
  const detail = sanitizeText(body.detail, 300);
  const data = body.data && typeof body.data === 'object' ? body.data : null;
  const host = sanitizeText(body.host, 120);
  const clientId = sanitizeText(body.client, 64);

  // Any extension activity is also proof of life: a reader who is mid-session
  // should not lose presence just because the dedicated ping is in flight.
  if (clientId) {
    presence.touch({
      clientId,
      page: { title: sanitizeText(body.pageTitle, 120), host }
    });
  }

  emit({
    stage: kind,
    source: 'extension.agent',
    level,
    title,
    detail: detail || (host ? `on ${host}` : ''),
    data: { ...(data || {}), client: sanitizeText(body.client, 24) || 'extension', host }
  });

  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* L402 protocol surface                                               */
/* ------------------------------------------------------------------ */

/*
 * A dedicated programmatic surface, modelled on CrawlerPal's FastAPI server:
 *
 *   GET  /api/l402/offer      → 402 + offer contract, or 200 + paid resource
 *   POST /api/l402/challenge  → 402 + a fresh contract (explicit challenge)
 *   POST /api/l402/settle     → attention proof → macaroon bearer token
 *   GET  /api/l402/receipt/:t → negotiation receipt for a context
 *   GET  /api/l402/sessions   → recent contexts (terminal inspection)
 *
 * The same handlers are also mounted at /l402/* for protocol-native clients.
 *
 * One deliberate difference from the reference implementation: CrawlerPal
 * decides between HTML and 402 by sniffing the User-Agent on a single URL.
 * AdPal does not sniff — the publication is served at /demo/ and the contract
 * only at this path — so a browser typo can never be mistaken for an agent and
 * an agent can never receive the article by accident.
 */

/** Absolute base URL for the request, so the contract is copy-pasteable. */
function requestBaseUrl(req) {
  const forwarded = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwarded || req.protocol || 'http';
  const host = req.get('host') || `localhost:${serverState.port}`;
  return `${protocol}://${host}`;
}

function requestBody(req) {
  return req.body && typeof req.body === 'object' ? req.body : {};
}

/** UA is the only caller identity a protocol client reliably sends. */
function protocolClient(req) {
  return sanitizeText(req.get('user-agent'), 48) || 'unknown-client';
}

/**
 * Creates a context (and its cryptographic challenge) and replies 402.
 *
 * The challenge is minted here rather than at settlement so the payment hash
 * in the 402 body is the same one the eventual macaroon commits to. That is
 * the property that makes the exchange an actual L402 challenge instead of a
 * decorative header.
 */
function sendContract(req, res, { offerId, context = null, error = null, extra = {} }) {
  const baseUrl = requestBaseUrl(req);

  let ctx = context;
  if (!ctx) {
    try {
      ctx = l402Sessions.create({
        offerId,
        paymentRequestUrl: `${baseUrl}/api/l402/settle`,
        client: protocolClient(req),
        publisher: sanitizeText(req.query.publisher || requestBody(req).publisher, 80) || 'localhost',
        pageTitle: sanitizeText(req.query.page_title || requestBody(req).page_title, 120) || undefined,
        pageHost: sanitizeText(req.query.publisher || requestBody(req).publisher, 120) || 'localhost'
      });
    } catch (failure) {
      emit({
        stage: 'l402.contract',
        source: 'adserver.agent',
        level: 'error',
        title: '402 rejected · unknown offer',
        detail: failure?.message || 'Unknown offer id.'
      });
      return res.status(400).json({
        error: 'UNKNOWN_OFFER',
        message: failure?.message || 'Unknown offer id.',
        offers: l402Contract.OFFERS.map(l402Contract.offerPayload)
      });
    }
  }

  // One challenge per context: reusing the preimage keeps the payment hash the
  // client already saw valid across retries.
  if (!ctx.challenge) {
    ctx.challenge = l402.challenge({
      offerId: ctx.offer_id,
      price: ctx.amount,
      publisher: ctx.publisher,
      agentId: '',
      ttlMs: Math.max(30_000, ctx.expiresAt - Date.now())
    });
  }

  const contract = l402Contract.buildContract({
    context: ctx,
    // Only pin the catalog when the caller actually asked for one offer.
    offerId,
    baseUrl
  });

  const body = {
    ...contract,
    challenge: {
      ...contract.challenge,
      payment_hash: ctx.challenge.paymentHash,
      www_authenticate: ctx.challenge.header
    },
    ...(error ? { error } : {}),
    ...extra
  };

  emit({
    stage: 'l402.contract',
    source: 'adserver.agent',
    level: error ? 'warn' : 'info',
    title: error ? `402 Payment Required · ${error.code}` : '402 Payment Required',
    detail:
      `${body.selected_offer_id} · ${body.offers.length} offer(s) · ` +
      `context ${ctx.payment_context_token.slice(0, 8)}… · ` +
      `payment_hash ${ctx.challenge.paymentHash.slice(0, 16)}…`,
    data: {
      phase: 'contract',
      status: 402,
      ...body,
      // Kept alongside the payload so the terminal rail can read it directly.
      paymentHash: ctx.challenge.paymentHash,
      paymentContextToken: ctx.payment_context_token,
      headers: { 'WWW-Authenticate': ctx.challenge.header }
    }
  });

  res.set('Cache-Control', 'no-store');
  res.set('WWW-Authenticate', ctx.challenge.header);
  return res.status(402).json(body);
}

/**
 * Resolves a Bearer credential to a grant.
 *
 * Two token types are accepted, which is what lets an agent work either way:
 *  - a macaroon (the token minted at settlement) → cryptographic verification;
 *  - a payment context token (a UUID) → store lookup, CrawlerPal-style.
 */
function authorize(bearer) {
  const token = String(bearer || '').trim();
  if (!token) {
    return { ok: false, code: 'MISSING_BEARER_TOKEN', message: 'Authorization: Bearer <token> is required.' };
  }

  const parsed = parseMacaroon(token);
  if (parsed && typeof parsed === 'object' && parsed.i && Array.isArray(parsed.c)) {
    const verification = l402.verify(token);
    if (!verification.valid) {
      return {
        ok: false,
        code: 'INVALID_MACAROON',
        message: verification.reason,
        verification
      };
    }

    // The identifier is `l402:<sha256(preimage)>`; resolving it back to the
    // negotiation context lets a macaroon replay return the original receipt.
    const paymentHash = String(parsed.i).replace(/^l402:/, '');
    const context = l402Sessions.findByPaymentHash(paymentHash);

    return {
      ok: true,
      via: 'macaroon',
      context,
      paymentHash,
      offer:
        l402Contract.findOffer(verification.caveats.offer_id) ||
        (context ? l402Contract.findOffer(context.offer_id) : null),
      caveats: verification.caveats,
      verification
    };
  }

  const context = l402Sessions.get(token);
  if (!context) {
    return { ok: false, code: 'UNKNOWN_PAYMENT_CONTEXT', message: 'This payment context token is unknown.' };
  }
  if (context.state === L402_STATES.EXPIRED) {
    return { ok: false, code: 'CONTEXT_EXPIRED', message: 'This payment context has expired.' };
  }
  if (context.state !== L402_STATES.SETTLED && context.state !== L402_STATES.CONSUMED) {
    return {
      ok: false,
      code: 'CONTEXT_NOT_SETTLED',
      message: 'This payment context has not been settled yet.',
      context
    };
  }

  return {
    ok: true,
    via: 'context',
    context,
    offer: l402Contract.findOffer(context.offer_id),
    caveats: context.macaroon?.caveatList ? mapCaveats(context.macaroon.caveatList) : null,
    verification: null
  };
}

function mapCaveats(list) {
  const map = {};
  for (const caveat of Array.isArray(list) ? list : []) {
    const index = caveat.indexOf('=');
    if (index > 0) map[caveat.slice(0, index)] = caveat.slice(index + 1);
  }
  return map;
}

/** The paid resource: an impression receipt plus the creative that was bought. */
function buildResource({ grant, offer }) {
  const receipt = grant.context?.receipt || null;
  const offerId = grant.caveats?.offer_id || grant.context?.offer_id || offer?.id || 'unknown';

  return {
    ok: true,
    protocol: L402_PROTOCOL,
    version: l402Contract.VERSION,
    resource: {
      type: offer?.type === 'session' ? 'reading_session' : 'impression',
      offer_id: offerId,
      title: offer?.title || receipt?.contractOfferId || 'Human Attention Verification',
      publisher: grant.context?.publisher || grant.caveats?.publisher || 'localhost',
      page_title: grant.context?.pageTitle || null
    },
    grant: {
      via: grant.via,
      // Which credential was actually verified on this call.
      credential: grant.via === 'macaroon' ? 'macaroon' : 'payment_context_token',
      caveats: grant.caveats || null,
      max_price: grant.caveats?.max_price || null,
      expires_at: grant.caveats?.expires_at || (grant.context ? new Date(grant.context.expiresAt).toISOString() : null)
    },
    impression: receipt,
    balance: snapshot()
  };
}

function handleL402Offer(req, res) {
  const requested = sanitizeText(req.query.offer_id, 60);
  const bearer = l402Contract.readBearer(req.get('authorization')) || sanitizeText(req.query.token, 400);

  if (!bearer) {
    return sendContract(req, res, { offerId: requested || undefined });
  }

  const grant = authorize(bearer);
  if (!grant.ok) {
    emit({
      stage: 'l402.access',
      source: 'adserver.agent',
      level: 'warn',
      title: 'Access refused · invalid bearer token',
      detail: `${grant.code} · ${grant.message}`
    });
    return sendContract(req, res, {
      offerId: requested || undefined,
      error: {
        code: grant.code,
        message: grant.message,
        retryable: grant.code === 'MISSING_BEARER_TOKEN' || grant.code === 'UNKNOWN_PAYMENT_CONTEXT'
      }
    });
  }

  const context = grant.context;
  if (context) l402Sessions.markConsumed(context);

  const resource = buildResource({ grant, offer: grant.offer });

  emit({
    stage: 'l402.access',
    source: 'adserver.agent',
    level: 'ok',
    title: 'Paid resource served',
    detail:
      `${resource.resource.offer_id} · via ${grant.via} · ` +
      `${context ? `read ${context.reads}` : 'macaroon grant'}`,
    data: {
      phase: 'access',
      ...resource,
      paymentContextToken: context?.payment_context_token || null,
      macaroon: grant.verification || null
    }
  });

  res.set('Cache-Control', 'no-store');
  return res.json(resource);
}

function handleL402Challenge(req, res) {
  const body = requestBody(req);
  const requested = sanitizeText(body.offer_id || req.query.offer_id, 60) || undefined;
  return sendContract(req, res, { offerId: requested });
}

async function handleL402Settle(req, res) {
  const body = requestBody(req);
  const baseUrl = requestBaseUrl(req);
  const token = sanitizeText(body.payment_context_token || req.query.payment_context_token, 80);

  if (!token) {
    return sendContract(req, res, {
      offerId: sanitizeText(body.offer_id, 60) || undefined,
      error: {
        code: 'MISSING_PAYMENT_CONTEXT',
        message: 'payment_context_token is required; request the 402 contract first.',
        retryable: true
      }
    });
  }

  const context = l402Sessions.get(token);
  if (!context) {
    return sendContract(req, res, {
      offerId: sanitizeText(body.offer_id, 60) || undefined,
      error: {
        code: 'UNKNOWN_PAYMENT_CONTEXT',
        message: 'This payment context token is unknown or has been evicted.',
        retryable: true
      }
    });
  }

  if (context.state === L402_STATES.EXPIRED) {
    return sendContract(req, res, {
      offerId: context.offer_id,
      error: {
        code: 'CONTEXT_EXPIRED',
        message: 'This payment context has expired; request a new 402 contract.',
        retryable: true
      }
    });
  }

  // Idempotent settlement: a retried POST returns the same bearer token.
  if (context.state === L402_STATES.SETTLED || context.state === L402_STATES.CONSUMED) {
    emit({
      stage: 'l402.settle',
      source: 'adserver.agent',
      level: 'info',
      title: 'Settlement replayed',
      detail: `context ${context.payment_context_token.slice(0, 8)}… already settled · returning the same bearer token`,
      data: { phase: 'settle', idempotent: true, context: l402Sessions.view(context) }
    });

    return res.json({
      message: 'Payment already settled',
      idempotent: true,
      bearer_token: context.bearer_token,
      token_type: 'Bearer',
      protocol: L402_PROTOCOL,
      context: l402Sessions.view(context),
      receipt: context.receipt,
      balance: snapshot()
    });
  }

  const requestedOffer = sanitizeText(body.offer_id, 60);
  if (requestedOffer && requestedOffer !== context.offer_id) {
    return res.status(400).json({
      error: 'OFFER_MISMATCH',
      message: `This payment context was issued for ${context.offer_id}, not ${requestedOffer}.`,
      payment_context_token: context.payment_context_token
    });
  }

  const offer = l402Contract.findOffer(context.offer_id);
  if (!offer) {
    return res.status(500).json({ error: 'OFFER_CATALOGUE_BROKEN', message: 'Offer not found.' });
  }

  /*
   * Optional on-chain proof.
   *
   * A client may settle with `solana_signature` (or `solana.signature`) to prove
   * it already paid on devnet. The transaction is re-read from the cluster and
   * must commit to this context's payment hash — the same sha256(preimage) the
   * 402 challenge minted. An invalid proof refuses the settlement but does not
   * burn the context, so the reader can retry with a correct signature.
   */
  const solanaSignature = sanitizeText(
    body.solana_signature || body.solana?.signature,
    120
  );

  if (solanaSignature) {
    const expectedHash = context.challenge?.paymentHash || '';
    const chainProof = await verifySolanaProof({
      signature: solanaSignature,
      paymentHash: expectedHash,
      context,
      trigger: 'settle'
    });

    if (!chainProof.valid) {
      l402Sessions.recordFailure(context, 'SOLANA_PROOF_INVALID', chainProof.reason, {
        signature: solanaSignature,
        checks: chainProof.checks
      });
      return res.status(402).json({
        error: 'SOLANA_PROOF_INVALID',
        message: chainProof.reason,
        retryable: true,
        signature: solanaSignature,
        checks: chainProof.checks,
        explorerUrl: chainProof.explorerUrl,
        payment_context_token: context.payment_context_token,
        balance: snapshot()
      });
    }

    solana.consumeSignature(solanaSignature, {
      contextToken: context.payment_context_token,
      paymentHash: expectedHash
    });
    l402Sessions.attachSolanaProof(context, {
      phase: 'payment',
      valid: true,
      signature: solanaSignature,
      slot: chainProof.slot,
      confirmationStatus: chainProof.confirmationStatus,
      memo: chainProof.memo,
      checks: chainProof.checks,
      explorerUrl: chainProof.explorerUrl,
      verifiedAt: new Date().toISOString()
    });
  }

  const signals = body.attention?.signals || body.signals || {};
  const evaluation = evaluateAttention({ signals }, { receivedAt: Date.now(), threshold: config.humanThreshold });

  emit({
    stage: 'l402.settle',
    source: 'heuristic',
    level: evaluation.approved ? 'ok' : 'warn',
    title: `Payment request · attention ${evaluation.score}/100`,
    detail: evaluation.approved
      ? `${evaluation.reason} · offer ${offer.id}`
      : `${evaluation.reason} · context stays valid for retry`,
    data: {
      phase: 'settle',
      paymentContextToken: context.payment_context_token,
      offer_id: offer.id,
      amount: offer.amount,
      currency: offer.currency,
      approved: evaluation.approved,
      score: evaluation.score,
      verdict: evaluation.verdict,
      threshold: evaluation.threshold,
      reason: evaluation.reason,
      attempts: context.attempts + 1,
      checks: evaluation.checks
    }
  });

  // The verification agent reads the same telemetry and explains it. This runs
  // before the approval branch so a refused session is justified too.
  const settleReasoning = await agentCognition.assessAttention({
    signals,
    heuristic: evaluation,
    page: { title: context.pageTitle, host: context.pageHost || context.publisher }
  });
  emitAttentionReasoning(settleReasoning);

  if (!evaluation.approved) {
    l402Sessions.recordFailure(context, 'ATTENTION_NOT_VERIFIED', evaluation.reason, {
      score: evaluation.score,
      verdict: evaluation.verdict
    });

    // 402 again: the resource stays unpaid, but the context is not burned, so
    // the same token can be retried once the reader actually engages.
    return sendContract(req, res, {
      offerId: context.offer_id,
      context,
      error: {
        code: 'ATTENTION_NOT_VERIFIED',
        message: evaluation.reason,
        retryable: true,
        score: evaluation.score,
        threshold: evaluation.threshold,
        flags: evaluation.flags,
        checks: evaluation.checks
      }
    });
  }

  // The advertiser agents reason over the offer's page context before anyone
  // commits money: the winner funds the settlement, the toolkit authorizes it.
  const slotKey = `l402-${context.payment_context_token.slice(0, 8)}`;
  const lastCreativeId = sanitizeText(body.slot?.lastCreativeId, 60);
  const candidates = rotation.candidates({
    slotKey,
    price: offer.amount,
    excludeCreativeId: lastCreativeId
  });

  let settlementNegotiation = null;
  let placement = null;

  if (candidates.length > 0) {
    settlementNegotiation = await agentCognition.negotiate({
      page: {
        title: context.pageTitle,
        host: context.pageHost || context.publisher,
        slot: slotKey
      },
      price: offer.amount,
      candidates
    });
    emitBidReasoning(settlementNegotiation, {
      slotKey,
      price: offer.amount,
      pageTitle: context.pageTitle
    });

    if (settlementNegotiation.winnerId) {
      placement = rotation.pick({
        slotKey,
        price: offer.amount,
        excludeCreativeId: lastCreativeId,
        prefer: settlementNegotiation.winnerId
      });
    } else {
      l402Sessions.recordFailure(
        context,
        'NO_RELEVANT_ADVERTISER',
        'No advertiser agent judged the placement relevant.',
        { floor: settlementNegotiation.floor }
      );
      return sendContract(req, res, {
        offerId: context.offer_id,
        context,
        error: {
          code: 'NO_RELEVANT_ADVERTISER',
          message: 'No advertiser agent judged this placement relevant enough to fund.',
          retryable: true,
          floor: settlementNegotiation.floor,
          bids: settlementNegotiation.bids.map((bid) => ({
            agentId: bid.agentId,
            sponsor: bid.sponsor,
            relevance: bid.relevance,
            verdict: bid.verdict
          }))
        }
      });
    }
  } else {
    placement = rotation.pick({
      slotKey,
      price: offer.amount,
      excludeCreativeId: lastCreativeId
    });
  }

  if (!placement) {
    l402Sessions.recordFailure(context, 'NO_ADVERTISER_BUDGET', 'Every advertiser campaign is spent.', {
      amount: offer.amount
    });
    return res.status(402).json({
      error: 'NO_ADVERTISER_BUDGET',
      message: 'Every advertiser campaign has exhausted its budget.',
      payment_context_token: context.payment_context_token,
      balance: snapshot()
    });
  }

  const fundingDecision = await toolkit.authorizeAdvertiserSpend({
    advertiser: placement.advertiser,
    price: offer.amount
  });

  if (!fundingDecision.authorized) {
    l402Sessions.recordFailure(context, fundingDecision.code, 'The advertiser agent declined.', {
      advertiser: placement.advertiser.id
    });
    return res.status(402).json({
      error: fundingDecision.code || 'ADVERTISER_DECLINED',
      message: 'The advertiser agent declined to fund this settlement.',
      payment_context_token: context.payment_context_token,
      balance: snapshot()
    });
  }

  const ledgerOffer = ledger.creditOffer({
    price: offer.amount,
    score: evaluation.score,
    reason: evaluation.reason,
    publisher: context.publisher,
    pageTitle: context.pageTitle,
    pageHost: context.pageHost
  });

  if (!ledgerOffer) {
    l402Sessions.recordFailure(context, 'ADVERTISER_BUDGET_EXHAUSTED', 'The advertiser budget is exhausted.', {
      amount: offer.amount
    });

    emit({
      stage: 'l402.settle',
      source: 'ledger',
      level: 'error',
      title: 'Settlement refused · budget exhausted',
      detail: `Remaining €${money(ledger.advertiser.budget)} · requested €${money(offer.amount)}`
    });

    return res.status(402).json({
      error: 'ADVERTISER_BUDGET_EXHAUSTED',
      message: 'The simulated advertiser budget is exhausted.',
      payment_context_token: context.payment_context_token,
      balance: snapshot()
    });
  }

  rotation.record({
    slotKey,
    advertiserId: placement.advertiser.id,
    creativeId: placement.advertiser.creativeId,
    price: offer.amount
  });

  const creative = placement.creative;
  const agent = {
    id: placement.advertiser.id,
    name: placement.advertiser.name,
    bid: offer.amount,
    currency: config.currency,
    creativeId: creative.id,
    sponsor: creative.sponsor,
    objective: placement.advertiser.objective
  };

  emit({
    stage: 'rotation',
    source: 'adserver.agent',
    level: 'ok',
    title: `Advertiser rotation · ${creative.sponsor}`,
    detail: `${slotKey} · ${placement.reason} · L402 settlement`,
    data: {
      slotKey,
      reason: placement.reason,
      advertiser: placement.advertiser,
      creativeId: creative.id
    }
  });

  const challenge = context.challenge;
  const issued = l402.issue({
    offerId: context.offer_id,
    price: offer.amount,
    publisher: context.publisher,
    agentId: agent.id,
    preimage: challenge.preimage,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt
  });

  const verification = l402.verify(issued.token, {
    price: offer.amount,
    publisher: context.publisher,
    offerId: context.offer_id,
    preimage: issued.preimage
  });

  const macaroon = describe(issued, verification);

  emit({
    stage: 'l402.issue',
    source: 'adserver.agent',
    level: 'ok',
    title: 'Macaroon minted',
    detail: `${macaroon.id} · ${macaroon.caveats} caveats · bound to payment_hash ${issued.paymentHash.slice(0, 16)}…`,
    data: {
      phase: 'issue',
      paymentContextToken: context.payment_context_token,
      macaroon: {
        ...macaroon,
        token: issued.token,
        signature: verification.valid ? 'valid' : 'invalid',
        paymentHashFull: issued.paymentHash,
        preimageHashMatches: verification.status !== 'preimage_mismatch'
      },
      agent
    }
  });

  emit({
    stage: 'l402.verify',
    source: 'adserver.agent',
    level: verification.valid ? 'ok' : 'error',
    title: `Macaroon ${verification.status}`,
    detail: verification.valid
      ? `Signature chain, ${macaroon.caveats} caveats and expiry all valid · ${macaroon.id}`
      : `${macaroon.id} · ${verification.reason}`,
    data: {
      phase: 'verify',
      paymentContextToken: context.payment_context_token,
      macaroon,
      verification,
      preimage: issued.preimage,
      checks: {
        signatureChain: verification.status !== 'invalid_signature',
        paymentHashBinding: verification.status !== 'preimage_mismatch',
        caveatOffer: verification.status !== 'caveat_failed',
        expiry: verification.status !== 'expired'
      }
    }
  });

  /*
   * Anchor the invoice hash before the receipt is built: the settle response
   * should carry the on-chain signature, not a promise that it will appear
   * later. The anchor is a signed memo of `sha256(preimage)`, so the hash in
   * the macaroon and the hash on Devnet are the same 32 bytes.
   */
  const solanaAnchor = await anchorSettlement({
    paymentHash: issued.paymentHash,
    reference: `l402_${context.payment_context_token.slice(0, 8)}`,
    score: evaluation.score,
    offerId: context.offer_id
  });

  const solanaPaymentProof = context.proof?.solana?.phase === 'payment' ? context.proof.solana : null;
  const solanaReceipt = {
    rail: RAILS.SOLANA,
    cluster: config.solana.cluster,
    paymentHash: issued.paymentHash,
    anchor: solanaAnchor,
    anchorSignature: solanaAnchor?.signature || null,
    anchorExplorerUrl: solanaAnchor?.signature ? solanaAnchor.explorerUrl : solanaAnchor?.explorerUrl || null,
    hashExplorerUrl: solanaAnchor?.signature ? solanaAnchor.explorerUrl : solanaAnchor?.explorerUrl || null,
    paymentSignature: solanaPaymentProof?.signature || null,
    paymentExplorerUrl: solanaPaymentProof?.explorerUrl || null,
    treasury: solanaAnchor?.treasury || solana.publicProfile().treasury
  };

  const receipt = {
    reference: `l402_${context.payment_context_token.slice(0, 8)}`,
    offerId: ledgerOffer.id,
    contractOfferId: context.offer_id,
    amount: ledgerOffer.price,
    currency: config.currency,
    score: evaluation.score,
    verdict: evaluation.verdict,
    split: ledgerOffer.split,
    publisher: context.publisher,
    pageTitle: context.pageTitle,
    creative: {
      id: creative.id,
      sponsor: creative.sponsor,
      headline: creative.headline,
      body: creative.body,
      cta: creative.cta,
      theme: creative.theme
    },
    agent,
    paymentHash: issued.paymentHash,
    settledAt: new Date().toISOString(),
    payoutRail: config.payoutRail,
    solana: solanaReceipt
  };

  l402Sessions.settle(context, {
    bearerToken: issued.token,
    macaroon: {
      ...macaroon,
      paymentHashFull: issued.paymentHash,
      caveatList: issued.caveats
    },
    receipt,
    proof: {
      score: evaluation.score,
      verdict: evaluation.verdict,
      threshold: evaluation.threshold,
      checks: evaluation.checks,
      signals: evaluation.signals,
      solana: { anchor: solanaAnchor, payment: solanaPaymentProof }
    }
  });

  emit({
    stage: 'l402.settle',
    source: 'ledger',
    level: 'ok',
    title: 'Payment settled · bearer token issued',
    detail:
      `${receipt.reference} · €${money(receipt.split.user)} reader / ` +
      `€${money(receipt.split.publisher)} publisher · ${agent.id}` +
      (solanaAnchor?.signature ? ` · anchored ${solanaAnchor.signature.slice(0, 12)}…` : ''),
    data: {
      phase: 'settle',
      acknowledged: true,
      bearerTokenType: 'Bearer',
      bearerTokenPreview: `${issued.token.slice(0, 16)}…${issued.token.slice(-8)}`,
      tokenIsMacaroon: true,
      receipt,
      solana: solanaReceipt,
      context: l402Sessions.view(context)
    }
  });

  console.log(
    `[l402] settled ${receipt.reference} · ${evaluation.score}/100 · €${money(receipt.split.user)} reader · ${agent.id}` +
      (solanaAnchor?.signature ? ` · anchor ${solanaAnchor.signature}` : ` · anchor ${solanaAnchor?.status || 'skipped'}`)
  );

  // This is the trigger: a settled attention proof feeds the 70/30 split, and
  // once the reader balance crosses the threshold the protocol agent pays out
  // on the configured rail. The payment hash travels with it, so a Solana
  // payout memo commits to the same invoice the macaroon was minted for.
  queueAutoPayout(`l402 settle ${receipt.reference}`, {
    rail: config.payoutRail,
    paymentHash: issued.paymentHash,
    anchorSignature: solanaAnchor?.signature || '',
    // A settled 402 is itself the explicit instruction: the caller paid the
    // challenge in this request. It is not a background loop, so it does not
    // need a browser session — but it is still causally tied to a request,
    // which is the property this guard exists to protect.
    explicit: true
  });

  res.set('Cache-Control', 'no-store');
  return res.json({
    message: 'Payment settled',
    protocol: L402_PROTOCOL,
    version: l402Contract.VERSION,
    bearer_token: issued.token,
    token_type: 'Bearer',
    // So a client can present the context token directly, as CrawlerPal does.
    payment_context_token: context.payment_context_token,
    expires_at: new Date(issued.expiresAt).toISOString(),
    macaroon: {
      ...macaroon,
      token: issued.token,
      paymentHashFull: issued.paymentHash,
      caveatList: issued.caveats
    },
    receipt,
    solana: solanaReceipt,
    proof: {
      score: evaluation.score,
      verdict: evaluation.verdict,
      threshold: evaluation.threshold,
      checks: evaluation.checks,
      signals: evaluation.signals,
      solana: { anchor: solanaAnchor, payment: solanaPaymentProof }
    },
    resource_url: `${baseUrl}/api/l402/offer`,
    balance: snapshot()
  });
}

function handleL402Receipt(req, res) {
  const token = sanitizeText(req.params.token, 80);
  const context = l402Sessions.get(token);

  if (!context) {
    return res.status(404).json({
      error: 'UNKNOWN_PAYMENT_CONTEXT',
      message: 'No negotiation context exists for this token.'
    });
  }

  return res.json({
    ok: true,
    protocol: L402_PROTOCOL,
    context: l402Sessions.view(context),
    balance: snapshot()
  });
}

function handleL402Sessions(req, res) {
  return res.json({
    protocol: L402_PROTOCOL,
    version: l402Contract.VERSION,
    offers: l402Contract.OFFERS.map(l402Contract.offerPayload),
    stats: l402Sessions.stats(),
    sessions: l402Sessions.snapshot(Number.parseInt(req.query.limit, 10) || 20),
    l402: {
      issuer: 'adpal.simulator',
      ttlMs: config.l402.ttlMs,
      humanThreshold: config.humanThreshold
    }
  });
}

/* ------------------------------------------------------------------ */
/* PayPal webhooks                                                     */
/* ------------------------------------------------------------------ */

/**
 * Payout item events mapped to the status the ledger records.
 *
 * PayPal's `transaction_status` is already close to these names, but the mapping
 * is keyed on the event type so an unexpected extra field cannot change the
 * outcome.
 */
const PAYOUT_ITEM_STATUS = Object.freeze({
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'SUCCESS',
  'PAYMENT.PAYOUTS-ITEM.FAILED': 'FAILED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED': 'RETURNED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED': 'BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED': 'CANCELED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.ONHOLD': 'ONHOLD',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED': 'REFUNDED'
});

/**
 * Statuses where the money demonstrably never reached the recipient.
 *
 * UNCLAIMED and ONHOLD are deliberately absent: the item can still settle, so
 * reversing then would hand the balance back and pay it out again.
 */
const TERMINAL_FAILURES = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'CANCELED', 'REFUNDED']);

/**
 * Replay guard for webhook event ids.
 *
 * PayPal retries on any non-2xx and can legitimately redeliver. Processing the
 * same item event twice would double-reverse a failed payout, so each event id
 * is remembered. The map is bounded by insertion order — an unbounded Set in a
 * long-running demo is just a slow leak.
 */
const seenWebhookEvents = new Map();

function rememberWebhookEvent(id, record) {
  if (!id) return;
  const limit = config.paypal.webhook.replayWindow;
  seenWebhookEvents.set(id, record);
  while (seenWebhookEvents.size > limit) {
    const oldest = seenWebhookEvents.keys().next().value;
    seenWebhookEvents.delete(oldest);
  }
}

/*
 * Webhook reconciliation lives in its own module so the matching rules can be
 * tested without a signed PayPal delivery. `report` is a thunk so the
 * reconciler can be built before `reportWebhook` is defined below.
 */
const webhookReconciler = createWebhookReconciler({
  ledger,
  report: (event) => reportWebhook(event),
  // One definition of "the money never moved", shared with the route.
  terminalFailures: TERMINAL_FAILURES,
  money
});

/**
 * Records a webhook decision in both log surfaces.
 *
 * The SSE terminal is the local log surface; stdout is the one a hosting
 * platform keeps. A webhook that only reaches the former is invisible in
 * exactly the place an operator looks when PayPal's dashboard says the event
 * was delivered — so every path here, including the refusals, writes a line.
 */
function reportWebhook(event) {
  telemetry.emit(event);
  const marker = event.level === 'error' ? '!' : event.level === 'warn' ? '~' : '·';
  console.log(`[webhook] ${marker} ${event.title} · ${event.detail}`);
  if (event.level === 'error' && event.data) {
    console.error(`[webhook]   ${JSON.stringify(event.data)}`);
  }
}

/**
 * POST /api/webhooks/paypal — asynchronous payout notifications.
 *
 * Acknowledging matters as much as processing: PayPal retries anything that is
 * not a 2xx, so a well-formed event we choose not to act on must still return
 * 200 or it will be redelivered forever. The only 4xx/5xx responses are the
 * ones where the body genuinely cannot be trusted (unparseable) or the sender
 * could not be authenticated (bad signature).
 *
 * Nothing here throws on unexpected input: an unknown event type, a missing
 * batch id, or a batch the ledger has never seen each produce a 200 with an
 * explicit `outcome`.
 */
async function handlePaypalWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === 'string' ? req.body : '', 'utf8');

  if (raw.length === 0) {
    reportWebhook({
      stage: 'paypal.webhook',
      source: 'paypal.webhook',
      level: 'error',
      title: 'Webhook rejected · empty body',
      detail: 'No payload was received.',
      data: { code: 'EMPTY_BODY' }
    });
    return res.status(400).json({ error: 'EMPTY_BODY', message: 'The webhook body was empty.' });
  }

  let event = null;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    reportWebhook({
      stage: 'paypal.webhook',
      source: 'paypal.webhook',
      level: 'error',
      title: 'Webhook rejected · invalid JSON',
      detail: error?.message || 'The payload could not be parsed.',
      data: { code: 'INVALID_JSON', bytes: raw.length }
    });
    return res.status(400).json({
      error: 'INVALID_JSON',
      message: 'The webhook body is not valid JSON.'
    });
  }

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return res.status(400).json({
      error: 'INVALID_EVENT',
      message: 'The webhook body must be a JSON object.'
    });
  }

  const eventType = sanitizeText(event.event_type, 80);
  if (!eventType) {
    return res.status(400).json({
      error: 'MISSING_EVENT_TYPE',
      message: 'The webhook body has no event_type.'
    });
  }

  const eventId = sanitizeText(event.id, 80) || sanitizeText(req.get('paypal-transmission-id'), 80);

  // --- authenticity -------------------------------------------------
  let signature;
  try {
    signature = await paypal.verifyWebhookSignature({ headers: req.headers, event });
  } catch (error) {
    /*
     * The verification call itself blew up (DNS, timeout, an unexpected throw).
     * That is emphatically not proof of a forged signature: `unavailable` keeps
     * it distinct from `failed`, so the route answers with a retryable status
     * instead of a 401 that would make PayPal's retry think it was rejected.
     */
    signature = {
      status: 'unavailable',
      attempted: true,
      reason: error?.message || 'Signature verification could not be completed.'
    };
  }

  if (signature.status === 'unavailable') {
    reportWebhook({
      stage: 'paypal.webhook',
      source: 'paypal.webhook',
      level: 'error',
      title: 'Webhook held · verification service unavailable',
      detail: `${eventType} · ${signature.reason || 'verification could not be performed'}`,
      data: {
        eventId,
        eventType,
        code: 'WEBHOOK_VERIFICATION_UNAVAILABLE',
        httpStatus: signature.httpStatus ?? null,
        paypalCode: signature.code || null
      }
    });
    // 503 is retryable on purpose: the event is probably genuine, we simply
    // could not prove it. Dropping it with a 401 would lose a real notification.
    return res.status(503).json({
      error: 'WEBHOOK_VERIFICATION_UNAVAILABLE',
      message: signature.reason || 'Signature verification could not be performed.'
    });
  }

  if (signature.status === 'failed') {
    reportWebhook({
      stage: 'paypal.webhook',
      source: 'paypal.webhook',
      level: 'error',
      title: 'Webhook rejected · signature not verified',
      detail: `${eventType} · ${signature.reason || 'verification failed'}`,
      data: { eventId, eventType, code: 'WEBHOOK_SIGNATURE_INVALID' }
    });
    return res.status(401).json({
      error: 'WEBHOOK_SIGNATURE_INVALID',
      message: signature.reason || 'The webhook signature could not be verified.'
    });
  }

  if (signature.status === 'skipped' && config.paypal.webhook.strict) {
    reportWebhook({
      stage: 'paypal.webhook',
      source: 'paypal.webhook',
      level: 'error',
      title: 'Webhook rejected · verification unavailable in strict mode',
      detail: signature.reason || 'Signature verification is not configured.',
      data: { eventId, eventType, code: 'WEBHOOK_UNVERIFIED' }
    });
    return res.status(503).json({
      error: 'WEBHOOK_UNVERIFIED',
      message: signature.reason || 'Signature verification is not configured.'
    });
  }

  // --- replay guard -------------------------------------------------
  if (eventId && seenWebhookEvents.has(eventId)) {
    const prior = seenWebhookEvents.get(eventId);
    reportWebhook({
      stage: 'paypal.webhook',
      source: 'paypal.webhook',
      level: 'info',
      title: 'Webhook redelivered · already processed',
      detail: `${eventType} · ${eventId}`,
      data: { eventId, eventType, firstSeenAt: prior?.at || null }
    });
    return res.json({
      ok: true,
      received: true,
      event_id: eventId,
      event_type: eventType,
      outcome: 'duplicate',
      signature: signature.status,
      signature_reason: signature.reason || '',
      rail: RAILS.PAYPAL,
      batch_id: null,
      status: null,
      reversal: null,
      payout: null,
      balance: snapshot()
    });
  }

  // --- dispatch -----------------------------------------------------
  const resource = event.resource && typeof event.resource === 'object' ? event.resource : {};
  // PayPal puts the batch id on the resource for item events and the sender
  // ids inside `payout_item`. Reading all of them is what makes the first
  // delivery match instead of falling through to "unmatched".
  const item = resource.payout_item && typeof resource.payout_item === 'object'
    ? resource.payout_item
    : {};
  const batchId = sanitizeText(
    resource.payout_batch_id || resource.batch_id || item.payout_batch_id,
    80
  );
  const senderBatchId = sanitizeText(
    resource.sender_batch_id || item.sender_batch_id || resource.batch_header?.sender_batch_id,
    80
  );
  const senderItemId = sanitizeText(item.sender_item_id || resource.sender_item_id, 64);
  const itemId = sanitizeText(resource.payout_item_id || item.payout_item_id, 80);
  const status = PAYOUT_ITEM_STATUS[eventType] || null;

  const identifiers = { batchId, senderBatchId, senderItemId, itemId };

  let outcome = 'ignored';
  let payout = null;
  let reversal = null;

  if (status) {
    const result = webhookReconciler.receive({
      eventId,
      eventType,
      status,
      identifiers
    });
    payout = result.payout;
    reversal = result.reversal;
    outcome = result.outcome;
  }

  reportWebhook({
    stage: 'paypal.webhook',
    source: 'paypal.webhook',
    level: outcome === 'handled' ? 'ok' : outcome === 'unmatched' ? 'warn' : 'info',
    title:
      outcome === 'handled'
        ? `Payout ${status} · ledger updated`
        : outcome === 'duplicate'
          ? 'Webhook redelivered · item already final'
          : outcome === 'deferred'
            ? 'Webhook held · payout not yet committed'
            : outcome === 'unmatched'
              ? 'Webhook acknowledged · no matching payout'
              : 'Webhook acknowledged · nothing to apply',
    detail:
      `${eventType} · ${batchId || senderBatchId || itemId || 'no batch id'}` +
      (reversal?.reversed ? ` · reversed €${money(reversal.restored)}` : '') +
      (outcome === 'deferred' ? ` · queued for reconciliation (${webhookReconciler.size} held)` : ''),
    data: {
      eventId,
      eventType,
      outcome,
      signature: signature.status,
      batchId: batchId || null,
      senderBatchId: senderBatchId || null,
      itemId: itemId || null,
      status,
      reversal,
      payoutId: payout?.id || null,
      pendingWebhooks: webhookReconciler.size
    }
  });

  if (eventId) rememberWebhookEvent(eventId, { type: eventType, at: new Date().toISOString(), outcome });

  res.set('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    received: true,
    event_id: eventId,
    event_type: eventType,
    outcome,
    signature: signature.status,
    signature_reason: signature.reason || '',
    rail: RAILS.PAYPAL,
    batch_id: batchId || null,
    status,
    reversal,
    payout: payout || null,
    balance: snapshot()
  });
}

/**
 * Mounts the protocol at a prefix. Both `/api/l402` (the URL advertised in the
 * contract) and `/l402` (protocol-native) point at the same handlers.
 */
function mountL402(base) {
  app.get(`${base}/offer`, handleL402Offer);
  app.post(`${base}/challenge`, handleL402Challenge);
  app.post(`${base}/settle`, handleL402Settle);
  app.post(`${base}/solana/confirm`, handleSolanaConfirm);
  app.get(`${base}/receipt/:token`, handleL402Receipt);
  app.get(`${base}/sessions`, handleL402Sessions);
}

/**
 * Verifies a devnet transaction against an L402 payment hash and records the
 * result on the terminal stream.
 *
 * Shared by the settle route and the confirm route so both apply identical
 * rules: a proof is only valid when the transaction confirmed, the memo commits
 * to this invoice's `sha256(preimage)`, and the signature has not already
 * settled something else.
 */
async function verifySolanaProof({ signature, paymentHash, context = null, trigger = 'confirm', recipient = '', units = null }) {
  const proof = await solana.verifyProof({
    signature,
    paymentHash,
    recipient,
    units
  });

  const failed = proof.checks.filter((check) => !check.passed);

  emit({
    stage: 'solana.verify',
    source: 'solana.rail',
    level: proof.valid ? 'ok' : 'error',
    title: proof.valid ? 'On-chain L402 proof verified' : 'On-chain proof rejected',
    detail: proof.valid
      ? `${proof.signature.slice(0, 20)}… · slot ${proof.slot} · memo bound to ${String(proof.paymentHash || '').slice(0, 16)}…`
      : proof.reason,
    data: {
      trigger,
      rail: RAILS.SOLANA,
      cluster: config.solana.cluster,
      signature: proof.signature,
      slot: proof.slot,
      confirmationStatus: proof.confirmationStatus,
      memo: proof.memo,
      memoFields: proof.memoFields,
      paymentHash,
      transfers: proof.transfers,
      checks: proof.checks,
      failed: failed.map((check) => check.id),
      explorerUrl: proof.explorerUrl,
      contextToken: context?.payment_context_token || null
    }
  });

  return proof;
}

/**
 * Writes the settled invoice hash on-chain.
 *
 * Failure is never fatal: a settlement is valid because attention was proven,
 * and an unfunded devnet treasury must not take the demo down. The receipt
 * records exactly what happened — `anchored`, `pending` or `unfunded` — so the
 * terminal can show the truth rather than a decorative badge.
 */
async function anchorSettlement({ paymentHash, reference, score, offerId }) {
  const rail = solana.publicProfile();

  if (!config.solana.anchorProofs || !solana.isEnabled()) {
    return {
      status: 'disabled',
      rail: RAILS.SOLANA,
      cluster: config.solana.cluster,
      paymentHash,
      reason: 'SOLANA_ANCHOR_PROOFS is off or the rail is disabled.'
    };
  }

  try {
    const anchor = await solana.anchorProof({ paymentHash, reference, score, offerId });
    emit({
      stage: 'solana.anchor',
      source: 'solana.rail',
      level: 'ok',
      title: 'L402 hash anchored on Solana',
      detail: `${paymentHash.slice(0, 16)}… · ${anchor.signature.slice(0, 20)}… · slot ${anchor.slot}`,
      data: { ...anchor, rail: RAILS.SOLANA, verified: anchor.status === 'confirmed' || anchor.status === 'finalized' }
    });
    return anchor;
  } catch (error) {
    const unfunded = solana.isUnfundedError(error);
    emit({
      stage: 'solana.anchor',
      source: 'solana.rail',
      level: unfunded ? 'warn' : 'error',
      title: unfunded ? 'Anchor skipped · treasury unfunded' : 'Anchor failed',
      detail: unfunded
        ? `${error.message} · fund ${rail.treasury} at https://faucet.solana.com`
        : error?.message || 'Unknown Solana error',
      data: {
        code: error?.code || 'SOLANA_ANCHOR_FAILED',
        rail: RAILS.SOLANA,
        status: unfunded ? 'unfunded' : 'failed',
        paymentHash,
        reference,
        treasury: rail.treasury,
        cluster: config.solana.cluster,
        faucetUrl: `https://faucet.solana.com?address=${rail.treasury || ''}&network=devnet`,
        explorerUrl: rail.treasury ? solana.addressUrl(rail.treasury) : rail.explorerBase
      }
    });
    return {
      status: unfunded ? 'unfunded' : 'failed',
      rail: RAILS.SOLANA,
      cluster: config.solana.cluster,
      paymentHash,
      code: error?.code || 'SOLANA_ANCHOR_FAILED',
      reason: error?.message || 'Unknown Solana error',
      treasury: rail.treasury,
      explorerUrl: rail.treasury ? solana.addressUrl(rail.treasury) : rail.explorerBase
    };
  }
}

/**
 * POST /api/l402/solana/confirm
 *
 * Out-of-band confirmation of a devnet payment. The body is either the raw
 * signature or a `solana` object; the expected hash comes from the settlement
 * context when a `payment_context_token` is supplied, so a client cannot point
 * one proof at another invoice.
 *
 * Accepted: { signature, payment_context_token?, payment_hash?, recipient?, units? }
 */
async function handleSolanaConfirm(req, res) {
  const body = requestBody(req);
  const signature = sanitizeText(body.signature || body.tx_signature || body.solana?.signature, 120);
  const token = sanitizeText(body.payment_context_token, 80);

  if (!signature) {
    return res.status(400).json({
      error: 'MISSING_SIGNATURE',
      message: 'Provide the Solana transaction signature to confirm.',
      accepted: ['signature', 'tx_signature', 'solana.signature']
    });
  }

  const context = token ? l402Sessions.get(token) : null;
  if (token && !context) {
    return res.status(404).json({
      error: 'UNKNOWN_PAYMENT_CONTEXT',
      message: 'This payment context token is unknown or has expired.'
    });
  }

  const expectedHash =
    context?.challenge?.paymentHash ||
    sanitizeText(body.payment_hash, 80).toLowerCase();

  if (!expectedHash) {
    return res.status(400).json({
      error: 'MISSING_PAYMENT_HASH',
      message: 'Pass a payment_context_token (preferred) or the 64-character payment_hash the proof must commit to.',
      retryable: true
    });
  }

  if (solana.isConsumed(signature)) {
    return res.status(409).json({
      error: 'SIGNATURE_ALREADY_SETTLED',
      message: 'This transaction signature has already been used for a settlement.',
      signature,
      explorerUrl: solana.explorerUrl(signature)
    });
  }

  // When the caller names the recipient/amount, verification checks them too;
  // otherwise the memo binding is the guarantee and the checks say so.
  const recipient = sanitizeText(body.recipient, 64);
  const units = Number.isFinite(Number(body.units)) ? Number(body.units) : null;

  const proof = await verifySolanaProof({
    signature,
    paymentHash: expectedHash,
    context,
    trigger: 'confirm',
    recipient,
    units
  }).catch((error) => ({
    valid: false,
    checks: [
      {
        id: 'rail',
        label: 'Solana rail responded',
        passed: false,
        detail: error?.message || 'Unknown Solana error'
      }
    ],
    reason: error?.message || 'The Solana rail could not verify the proof.',
    explorerUrl: solana.explorerUrl(signature)
  }));

  if (proof.valid) {
    solana.consumeSignature(signature, {
      contextToken: context?.payment_context_token || '',
      paymentHash: expectedHash
    });
    if (context) {
      l402Sessions.attachSolanaProof(context, {
        phase: 'payment',
        valid: true,
        signature,
        slot: proof.slot,
        confirmationStatus: proof.confirmationStatus,
        memo: proof.memo,
        checks: proof.checks,
        explorerUrl: proof.explorerUrl,
        verifiedAt: new Date().toISOString()
      });
    }
  }

  res.status(proof.valid ? 200 : 402).json({
    verified: proof.valid,
    protocol: L402_PROTOCOL,
    rail: RAILS.SOLANA,
    cluster: config.solana.cluster,
    signature,
    payment_hash: expectedHash,
    slot: proof.slot,
    confirmation_status: proof.confirmationStatus,
    memo: proof.memo,
    memo_fields: proof.memoFields,
    transfers: proof.transfers,
    checks: proof.checks,
    reason: proof.reason,
    explorerUrl: proof.explorerUrl,
    context: context ? l402Sessions.view(context) : null,
    balance: snapshot()
  });
}

mountL402('/api/l402');
mountL402('/l402');

// PayPal's asynchronous payout notifications. Registered after the raw-body
// middleware at the top of the file, so `req.body` here is the untouched buffer.
app.post('/api/webhooks/paypal', handlePaypalWebhook);

app.post('/api/offer', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const requestedPrice = body.price === undefined || body.price === null
    ? config.defaultOfferPrice
    : Number(body.price);
  if (!Number.isFinite(requestedPrice) || requestedPrice <= 0) {
    emit({
      stage: 'request',
      source: 'adserver.agent',
      level: 'error',
      title: 'Offer rejected · invalid price',
      detail: 'The requested price must be a positive number.'
    });
    return res.status(400).json({
      error: 'INVALID_PRICE',
      message: 'The requested price must be a positive number.',
      balance: snapshot()
    });
  }

  if (requestedPrice > config.maxOfferPrice + 1e-9) {
    emit({
      stage: 'request',
      source: 'adserver.agent',
      level: 'error',
      title: 'Offer rejected · price above cap',
      detail: `Requested €${money(requestedPrice)} · cap €${money(config.maxOfferPrice)}`
    });
    return res.status(400).json({
      error: 'PRICE_TOO_HIGH',
      message: `The requested price exceeds the €${money(config.maxOfferPrice)} cap.`,
      balance: snapshot()
    });
  }

  const price = round4(requestedPrice);
  const clientId = sanitizeText(body.clientId, 64) || req.ip || 'anonymous';
  const now = Date.now();

  /*
   * The presence gate.
   *
   * `/api/offer` is the only route that can create an impression, so it is the
   * only place this check has to be enforced. Without a live, visible session
   * there is no reader to show an ad to, and no telemetry event that asked for
   * one — which is precisely the ghost-transaction case: a replay, a script, or
   * a tab that was closed before the request landed.
   */
  if (config.presence.required) {
    const alive = presence.requireActive(clientId);
    if (!alive.ok) {
      // One warn per reason per few seconds, so a probe cannot flood the
      // terminal the way the refused request itself would have flooded it.
      const key = `${clientId}:${alive.reason}`;
      const lastWarn = lastPresenceWarnAt.get(key) || 0;
      if (now - lastWarn > 5000) {
        lastPresenceWarnAt.set(key, now);
        emit({
          stage: 'presence',
          source: 'extension.agent',
          level: 'warn',
          title: 'Offer refused · no active reader',
          detail: `${alive.reason} · an impression requires a live /demo/ session`,
          data: {
            client: clientLabel(clientId),
            reason: alive.reason,
            ageMs: alive.ageMs,
            activeReaders: alive.activeCount
          }
        });
      }

      return res.status(409).json({
        ok: false,
        approved: false,
        error: 'NO_ACTIVE_SESSION',
        reason: alive.reason,
        message:
          alive.reason === 'TAB_NOT_VISIBLE'
            ? 'The reader tab is not visible; no impression was sold.'
            : 'No live /demo/ reader session; no impression was sold.',
        presence: presence.snapshot(),
        balance: snapshot()
      });
    }
  } else if (body.clientId) {
    // Presence tracking still runs when the gate is disabled, so the terminal
    // can show the session even for scripted checks.
    presence.touch({ clientId, page: { title: sanitizeText(body.page?.title, 120), host: sanitizeText(body.page?.host, 120) } });
  }

  const lastOfferAt = lastOfferByClient.get(clientId) || 0;
  if (now - lastOfferAt < OFFER_COOLDOWN_MS) {
    emit({
      stage: 'request',
      source: 'adserver.agent',
      level: 'warn',
      title: 'Offer throttled',
      detail: 'Client already requested an offer within the last second.'
    });
    return res.status(429).json({
      error: 'RATE_LIMITED',
      message: 'Too many offer requests. Wait one second.',
      balance: snapshot()
    });
  }

  lastOfferByClient.set(clientId, now);
  if (lastOfferByClient.size > 500) {
    for (const [key, timestamp] of lastOfferByClient) {
      if (now - timestamp > 10 * 60 * 1000) lastOfferByClient.delete(key);
    }
  }
  // Same bound for the refusal-warning debounce; it is keyed per client+reason
  // and would otherwise keep one entry per probe for the life of the process.
  if (lastPresenceWarnAt.size > 500) {
    for (const [key, timestamp] of lastPresenceWarnAt) {
      if (now - timestamp > 60 * 1000) lastPresenceWarnAt.delete(key);
    }
  }

  const publisher = sanitizeText(body.page?.host, 80) || 'unknown-publisher';
  const pageTitle = sanitizeText(body.page?.title, 120) || 'Untitled page';
  const pageHost = sanitizeText(body.page?.host, 120);
  const slotDetected = body.slot?.detected === true;

  emit({
    stage: 'request',
    source: 'extension.agent',
    level: 'info',
    title: 'Offer requested',
    detail: `€${money(price)} · ${publisher} · ${pageTitle}`,
    data: {
      price,
      publisher,
      pageTitle,
      slot: slotDetected ? 'declared' : 'unknown',
      client: clientLabel(clientId)
    }
  });

  const evaluation = evaluateAttention(
    { signals: body.signals },
    { receivedAt: now, threshold: config.humanThreshold }
  );

  const passedChecks = evaluation.checks.filter((check) => check.status === 'pass').length;

  emit({
    stage: 'checks',
    source: 'heuristic',
    level: passedChecks === evaluation.checks.length ? 'ok' : 'warn',
    title: `Bot checks ${passedChecks}/${evaluation.checks.length} passed`,
    detail: evaluation.checks
      .filter((check) => check.status === 'fail')
      .map((check) => check.label)
      .join(', ') || 'No automation signals detected.',
    data: { checks: evaluation.checks }
  });

  emit({
    stage: 'score',
    source: 'heuristic',
    level: evaluation.approved ? 'ok' : 'warn',
    title: `Attention score ${evaluation.score}/100`,
    detail: evaluation.approved
      ? `Threshold ${evaluation.threshold} · human verified · proof accepted`
      : `Threshold ${evaluation.threshold} · verdict ${evaluation.verdict}`,
    data: {
      score: evaluation.score,
      threshold: evaluation.threshold,
      verdict: evaluation.verdict,
      approved: evaluation.approved,
      contractOfferId: L402_OFFER_ID,
      factors: evaluation.factors
    }
  });

  /*
   * Agent cognition over the telemetry.
   *
   * The heuristic above decides; this layer explains the decision in prose so
   * the terminal shows a reasoning trace ("reading cadence", "pointer
   * dynamics", "viewport discipline") instead of a bare boolean. It runs before
   * the approval branch, so a rejected session gets a justification too.
   */
  const attentionReasoning = await agentCognition.assessAttention({
    signals: body.signals || {},
    heuristic: evaluation,
    page: { title: pageTitle, host: pageHost || publisher }
  });
  emitAttentionReasoning(attentionReasoning);

  if (!evaluation.approved) {
    const offer = ledger.recordRejection({
      score: evaluation.score,
      reason: evaluation.reason,
      publisher,
      pageTitle,
      pageHost
    });

    emit({
      stage: 'decision',
      source: 'adserver.agent',
      level: 'warn',
      title: 'Offer withheld',
      detail: evaluation.reason,
      data: { offerId: offer.id, hint: evaluation.hint }
    });

    console.log(
      `[offer] withheld ${String(evaluation.score).padStart(3)}/100 · ${publisher} · ${evaluation.reason}`
    );

    return res.json({
      approved: false,
      offerId: offer.id,
      price,
      score: evaluation.score,
      verdict: evaluation.verdict,
      reason: evaluation.reason,
      hint: evaluation.hint,
      threshold: evaluation.threshold,
      flags: evaluation.flags,
      checks: evaluation.checks,
      factors: evaluation.factors,
      split: {
        user: 0,
        publisher: 0,
        userRate: config.userShare,
        publisherRate: config.publisherShare
      },
      balance: snapshot()
    });
  }

  if (ledger.advertiser.budget + 1e-9 < price) {
    emit({
      stage: 'decision',
      source: 'adserver.agent',
      level: 'error',
      title: 'Offer rejected · budget exhausted',
      detail: `Remaining budget €${money(ledger.advertiser.budget)} · requested €${money(price)}`
    });
    return res.status(402).json({
      error: 'ADVERTISER_BUDGET_EXHAUSTED',
      message: 'The simulated advertiser budget is exhausted.',
      balance: snapshot()
    });
  }

  /*
   * Multi-advertiser rotation, now driven by agent reasoning.
   *
   * The slot key comes from the placement the extension reported, so each
   * placement rotates independently and never shows the advertiser it just
   * showed. The rotation only returns profiles whose campaign budget can still
   * cover this impression; every eligible advertiser agent then reads the page
   * context and returns a scored bid with a written justification, and the
   * highest relevant bid wins the slot. The advertiser agent still authorizes
   * the spend through the PayPal Agent Toolkit before any money is moved.
   */
  const slotIndex = sanitizeText(String(body.slot?.index ?? ''), 12);
  const slotKey = slotIndex ? `slot-${slotIndex}` : 'page';
  const lastCreativeId = sanitizeText(body.slot?.lastCreativeId, 60);

  const candidates = rotation.candidates({
    slotKey,
    price,
    excludeCreativeId: lastCreativeId
  });

  let negotiation = null;
  let placement = null;

  if (candidates.length > 0) {
    negotiation = await agentCognition.negotiate({
      page: { title: pageTitle, host: pageHost || publisher, slot: slotKey },
      price,
      candidates
    });
    emitBidReasoning(negotiation, { slotKey, price, pageTitle });

    if (negotiation.winnerId) {
      placement = rotation.pick({
        slotKey,
        price,
        excludeCreativeId: lastCreativeId,
        prefer: negotiation.winnerId
      });
    } else {
      // Every agent looked at the page and declined. Withholding the impression
      // is the product working: nobody should be shown an ad no agent would
      // fund, and the reasoning above says exactly why.
      emit({
        stage: 'decision',
        source: 'advertiser.agent',
        level: 'warn',
        title: 'Offer withheld · no relevant bid',
        detail: `All ${negotiation.bids.length} advertiser agents declined at the ${negotiation.floor.toFixed(2)} relevance floor`,
        data: {
          floor: negotiation.floor,
          bids: negotiation.bids,
          pageProfile: negotiation.pageProfile
        }
      });
      console.log('[agent] withheld · no advertiser cleared the relevance floor');

      return res.status(402).json({
        error: 'NO_RELEVANT_ADVERTISER',
        message: 'No advertiser agent judged this placement relevant enough to fund.',
        floor: negotiation.floor,
        bids: negotiation.bids.map((bid) => ({
          agentId: bid.agentId,
          sponsor: bid.sponsor,
          relevance: bid.relevance,
          verdict: bid.verdict
        })),
        balance: snapshot()
      });
    }
  } else {
    // Nothing eligible to reason over (every candidate is the creative this
    // slot just showed). Fall back to the rotation's own rules.
    placement = rotation.pick({ slotKey, price, excludeCreativeId: lastCreativeId });
  }

  if (!placement) {
    emit({
      stage: 'decision',
      source: 'adserver.agent',
      level: 'error',
      title: 'Offer rejected · every campaign is spent',
      detail: 'No advertiser has enough campaign budget left for this placement.'
    });
    return res.status(402).json({
      error: 'NO_ADVERTISER_BUDGET',
      message: 'Every advertiser campaign has exhausted its budget.',
      balance: snapshot()
    });
  }

  const fundingDecision = await toolkit.authorizeAdvertiserSpend({
    advertiser: placement.advertiser,
    price
  });

  if (!fundingDecision.authorized) {
    emit({
      stage: 'decision',
      source: 'adserver.agent',
      level: 'error',
      title: 'Offer rejected · advertiser declined',
      detail: `${placement.advertiser.sponsor} · ${fundingDecision.code}`
    });
    return res.status(402).json({
      error: fundingDecision.code || 'ADVERTISER_DECLINED',
      message: 'The advertiser agent declined to fund this impression.',
      advertiser: placement.advertiser,
      balance: snapshot()
    });
  }

  const offer = ledger.creditOffer({
    price,
    score: evaluation.score,
    reason: evaluation.reason,
    publisher,
    pageTitle,
    pageHost,
    sessionId: clientId
  });

  if (!offer) {
    emit({
      stage: 'decision',
      source: 'adserver.agent',
      level: 'error',
      title: 'Offer rejected · credit failed',
      detail: 'The ledger could not credit this impression.'
    });
    return res.status(402).json({
      error: 'CREDIT_FAILED',
      message: 'The offer could not be credited.',
      balance: snapshot()
    });
  }

  rotation.record({
    slotKey,
    advertiserId: placement.advertiser.id,
    creativeId: placement.advertiser.creativeId,
    price
  });

  const creative = placement.creative;
  const agent = {
    id: placement.advertiser.id,
    name: placement.advertiser.name,
    bid: offer.price,
    currency: config.currency,
    creativeId: creative.id,
    sponsor: creative.sponsor,
    objective: placement.advertiser.objective
  };

  emit({
    stage: 'rotation',
    source: 'adserver.agent',
    level: 'ok',
    title: `Advertiser rotation · ${creative.sponsor}`,
    detail: `${slotKey} · ${placement.reason} · budget left €${money(placement.advertiser.budgetRemaining - price)}`,
    data: {
      slotKey,
      reason: placement.reason,
      advertiser: placement.advertiser,
      creativeId: creative.id,
      roster: rotation.snapshot().advertisers
    }
  });

  emit({
    stage: 'decision',
    source: 'adserver.agent',
    level: 'ok',
    title: 'Offer approved',
    detail: evaluation.reason,
    data: { offerId: offer.id, price: offer.price, agent }
  });

  /**
   * L402 settlement, in the two steps the protocol actually defines:
   *
   *  1. challenge — the resource server returns 402 with a payment hash and
   *     the caveats the token will carry;
   *  2. proof — the advertiser agent returns a macaroon bound to that payment
   *     hash, whose preimage here is the verified attention session.
   *
   * The token is verified immediately so the terminal can show a real
   * cryptographic result rather than a cosmetic badge.
   */
  const challenge = l402.challenge({
    offerId: offer.id,
    price: offer.price,
    publisher,
    agentId: agent.id
  });

  emit({
    stage: 'l402.challenge',
    source: 'adserver.agent',
    level: 'info',
    title: '402 Payment Required',
    detail: challenge.header,
    data: {
      phase: 'challenge',
      status: 402,
      contractOfferId: L402_OFFER_ID,
      offerId: offer.id,
      agentId: agent.id,
      price: offer.price,
      amount: { value: offer.price, currency: config.currency },
      currency: config.currency,
      paymentHash: challenge.paymentHash,
      caveats: ['offer_id', 'agent_id', 'publisher', 'max_price', 'currency', 'issued_at', 'expires_at', 'attenuation'],
      expiresAt: new Date(challenge.expiresAt).toISOString(),
      header: { 'WWW-Authenticate': challenge.header }
    }
  });

  const issued = l402.issue({
    offerId: offer.id,
    price: offer.price,
    publisher,
    agentId: agent.id,
    preimage: challenge.preimage,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt
  });

  const verification = l402.verify(issued.token, {
    price: offer.price,
    publisher,
    offerId: offer.id,
    preimage: issued.preimage
  });

  const macaroon = describe(issued, verification);

  emit({
    stage: 'l402.issue',
    source: 'adserver.agent',
    level: 'info',
    title: 'Macaroon minted',
    detail: `${macaroon.id} · ${macaroon.caveats} caveats · HMAC-SHA256 chain`,
    data: {
      phase: 'issue',
      contractOfferId: L402_OFFER_ID,
      offerId: offer.id,
      macaroon: {
        ...macaroon,
        // Full token, because this is the dedicated protocol log rather than
        // the article. It is a demo token with a five-minute lifetime.
        token: issued.token,
        signature: verification.valid ? 'valid' : 'invalid',
        preimageMatchesPaymentHash: verification.status !== 'preimage_mismatch'
      },
      agent
    }
  });

  emit({
    stage: 'l402.verify',
    source: 'adserver.agent',
    level: verification.valid ? 'ok' : 'error',
    title: `Macaroon ${verification.status}`,
    detail: verification.valid
      ? `Signature chain, 8 caveats and expiry all valid · ${macaroon.id}`
      : `${macaroon.id} · ${verification.reason}`,
    data: {
      phase: 'verify',
      contractOfferId: L402_OFFER_ID,
      offerId: offer.id,
      macaroon,
      verification,
      preimage: issued.preimage,
      checks: {
        signatureChain: verification.status !== 'invalid_signature',
        paymentHashBinding: verification.status !== 'preimage_mismatch',
        caveatOffer: verification.status !== 'caveat_failed',
        expiry: verification.status !== 'expired'
      }
    }
  });

  emit({
    stage: 'creative',
    source: 'adserver.agent',
    level: 'info',
    title: 'Creative assigned',
    detail: `${creative.sponsor} · ${creative.id}`,
    data: { creative: creativePayload(creative), advertiser: agent }
  });

  emit({
    stage: 'ledger',
    source: 'ledger',
    level: 'ok',
    title: 'Revenue split calculated',
    detail:
      `${Math.round(offer.split.userRate * 100)}% reader / ` +
      `${Math.round(offer.split.publisherRate * 100)}% publisher · ` +
      `€${money(offer.split.user)} / €${money(offer.split.publisher)}`,
    data: {
      offerId: offer.id,
      contractOfferId: L402_OFFER_ID,
      split: offer.split,
      amount: { value: offer.price, currency: config.currency },
      balances: {
        user: ledger.user.balance,
        publisher: ledger.publisher.balance,
        advertiser: ledger.advertiser.budget
      }
    }
  });

  console.log(
    `[offer] approved ${String(evaluation.score).padStart(3)}/100 · €${money(offer.price)} ` +
    `→ €${money(offer.split.user)} user / €${money(offer.split.publisher)} publisher · ${agent.id}`
  );

  // Same trigger as the L402 settle route: once a credited impression pushes
  // the reader balance past the threshold, the protocol agent pays out.
  queueAutoPayout(`offer ${offer.id}`, {
    rail: config.payoutRail,
    paymentHash: challenge.paymentHash,
    sessionId: clientId
  });

  res.json({
    approved: true,
    offerId: offer.id,
    price: offer.price,
    score: evaluation.score,
    verdict: evaluation.verdict,
    reason: evaluation.reason,
    hint: '',
    threshold: evaluation.threshold,
    flags: evaluation.flags,
    checks: evaluation.checks,
    factors: evaluation.factors,
    split: offer.split,
    creative: creativePayload(creative),
    agent,
    macaroon,
    balance: snapshot()
  });
});

/* ------------------------------------------------------------------ */
/* Payout rails                                                        */
/* ------------------------------------------------------------------ */

/** @type {null | number} */
let lastAutoPayoutAt = 0;
/** Serializes automatic payouts so two settlements can never race. */
let autoPayoutChain = Promise.resolve();

/**
 * Creates a PayPal Payouts batch for the current balances.
 *
 * Used by both the terminal's manual button and the automatic L402 trigger
 * when the active rail is `paypal_payouts`. It:
 *
 * 1. reserves the reader (70%) and publisher (30%) shares in the ledger;
 * 2. hands the reservation to the protocol agent, which splits the invoice and
 *    calls the `paypal_create_payout` tool from the agent toolkit;
 * 3. commits the debit only when PayPal accepted the batch.
 *
 * @param {{ auto?: boolean, reason?: string, receiverEmail?: string, publisherEmail?: string }} options
 * @returns {Promise<{ status: number, body: object }>}
 */
async function runPaypalPayout({ auto = false, reason = 'manual', receiverEmail, publisherEmail, sessionId = '' } = {}) {
  const profile = paypal.publicProfile();
  const trigger = auto ? 'auto' : 'manual';

  if (!paypal.isConfigured()) {
    emit({
      stage: 'payout',
      source: 'ledger',
      level: 'error',
      title: 'PayPal not configured',
      detail: 'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in server/.env.',
      data: { trigger, reason }
    });
    return {
      status: 503,
      body: {
        settled: false,
        error: 'PAYPAL_NOT_CONFIGURED',
        message: 'PayPal credentials are missing. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to server/.env.',
        paypal: profile,
        balance: snapshot()
      }
    };
  }

  const receiver = sanitizeText(receiverEmail, 120) || profile.receiverEmail;
  const publisher = sanitizeText(publisherEmail, 120) || profile.publisherEmail || '';
  // Only move the publisher share when a distinct second receiver exists.
  const paysPublisher = Boolean(publisher) && publisher.toLowerCase() !== receiver.toLowerCase();

  const prepared = ledger.preparePayout({
    maxAmount: profile.maxPayout,
    payPublisher: paysPublisher,
    rail: RAILS.PAYPAL
  });

  if (!prepared.ok) {
    const messages = {
      PAYOUT_IN_PROGRESS: 'A payout is already in progress on the other rail.',
      THRESHOLD_NOT_REACHED:
        `Payout threshold of €${money(prepared.threshold)} not reached: €${money(prepared.missing)} short.`,
      AMOUNT_TOO_SMALL: prepared.message
    };
    const message = messages[prepared.reason] || 'Payout not available.';

    // An automatic attempt below the threshold is normal: the run keeps
    // accumulating until four impressions cross it. Stay quiet about it so the
    // terminal does not fill with "not yet" lines.
    if (!(auto && prepared.reason === 'THRESHOLD_NOT_REACHED')) {
      emit({
        stage: 'payout',
        source: 'ledger',
        level: 'warn',
        title: 'Payout not started',
        detail: message,
        data: { trigger, reason, missing: prepared.missing ?? 0 }
      });
    }

    return {
      status: 409,
      body: {
        settled: false,
        error: prepared.reason,
        message,
        threshold: prepared.threshold,
        missing: prepared.missing ?? 0,
        paypal: profile,
        balance: snapshot()
      }
    };
  }

  const { reservation } = prepared;

  emit({
    stage: 'payout',
    source: 'ledger',
    level: 'info',
    title: auto ? 'Payout triggered automatically' : 'PayPal payout requested',
    detail:
      `${reservation.reference} · €${money(reservation.userAmount)} reader` +
      (reservation.publisherAmount >= 0.01
        ? ` + €${money(reservation.publisherAmount)} publisher`
        : '') +
      ' → PayPal',
    data: {
      trigger,
      reason,
      reference: reservation.reference,
      amount: reservation.userAmount,
      publisherAmount: reservation.publisherAmount,
      receiverEmail: receiver,
      publisherEmail: paysPublisher ? publisher : null,
      split: reservation.split,
      mode: profile.mode
    }
  });

  let routed;
  try {
    // The protocol agent owns the split and the Payouts call; the toolkit
    // applies the documented request shape (idempotent sender_item_id,
    // PayPal-Request-Id, retry on 429).
    routed = await toolkit.routeSettlement({
      reservation,
      receiverEmail: receiver,
      publisherEmail: paysPublisher ? publisher : '',
      currency: profile.currency,
      userShare: config.userShare,
      subject: 'Your AdPal attention payout',
      message:
        'Thanks for reading The Courier. This is your 70% share of the ad that was shown while you were reading.'
    });
  } catch (error) {
    ledger.cancelPayout(error?.message || 'PayPal request failed');

    const detail = error instanceof paypal.PayPalError
      ? `${error.code} · ${error.message}`
      : error?.message || 'Unknown PayPal error';

    emit({
      stage: 'payout',
      source: 'adserver.agent',
      level: 'error',
      title: 'PayPal payout failed',
      detail,
      data: {
        trigger,
        code: error?.code || 'PAYPAL_ERROR',
        issues: error?.issues || [],
        debugId: error?.debugId || '',
        reference: reservation.reference
      }
    });

    console.error(`[payout] failed · ${detail}`);

    return {
      status: error?.status || 502,
      body: {
        settled: false,
        error: error?.code || 'PAYPAL_ERROR',
        message: detail,
        issues: error?.issues || [],
        debugId: error?.debugId || '',
        reference: reservation.reference,
        paypal: profile,
        balance: snapshot()
      }
    };
  }

  const { batch, items, split } = routed;
  const payout = ledger.commitPayout(reservation, { ...batch, rail: RAILS.PAYPAL });
  if (auto) lastAutoPayoutAt = Date.now();

  // A webhook that beat the create response to the server is already buffered.
  // Apply it now, in the same tick, so the ledger is consistent before the
  // batch is even reported to the terminal.
  const reconciled = webhookReconciler.flush(payout);

  emit({
    stage: 'payout',
    source: 'adserver.agent',
    level: 'ok',
    title: `PayPal batch ${batch.status}`,
    detail:
      `${batch.batchId} · €${money(batch.amount)} ${batch.currency} → ${batch.receiverEmail}` +
      (batch.items?.length > 1 ? ` (+${batch.items.length - 1} publisher item)` : '') +
      (reservation.reconciliation.carried.gross > 0
        ? ` · €${money(reservation.reconciliation.carried.gross)} carried (sub-cent)`
        : ' · cent-exact'),
    data: {
      trigger,
      payoutId: payout?.id,
      batchId: batch.batchId,
      senderBatchId: batch.senderBatchId,
      status: batch.status,
      rawStatus: batch.rawStatus,
      amount: batch.amount,
      currency: batch.currency,
      receiverEmail: batch.receiverEmail,
      items: batch.items || [],
      itemCount: items.length,
      publisherAmount: reservation.publisherAmount,
      split,
      reconciliation: reservation.reconciliation,
      reconciledWebhooks: reconciled,
      sessionId: String(sessionId || '').slice(0, 24),
      mode: batch.mode,
      reference: reservation.reference,
      selfUrl: batch.selfUrl
    }
  });

  console.log(
    `[payout] ${batch.batchId} ${batch.status} · €${money(batch.amount)} ${batch.currency} → ${batch.receiverEmail}` +
      (auto ? ` · auto (${reason})` : '')
  );

  return {
    status: 200,
    body: {
      settled: true,
      rail: RAILS.PAYPAL,
      trigger,
      payout,
      split: reservation.split,
      reconciliation: reservation.reconciliation,
      reconciledWebhooks: reconciled,
      accounting: ledger.audit(),
      paypal: {
        configured: true,
        mode: batch.mode,
        batchId: batch.batchId,
        senderBatchId: batch.senderBatchId,
        status: batch.status,
        rawStatus: batch.rawStatus,
        amount: batch.amount,
        currency: batch.currency,
        receiverEmail: batch.receiverEmail,
        items: batch.items || [],
        senderEmail: profile.senderEmail,
        selfUrl: batch.selfUrl,
        links: batch.links,
        dashboardUrl: profile.dashboardUrl
      },
      balance: snapshot()
    }
  };
}

/* ------------------------------------------------------------------ */
/* Solana Devnet payout                                               */
/* ------------------------------------------------------------------ */

/**
 * Moves the 70/30 split on Solana Devnet.
 *
 * The euro ledger is converted once, at the boundary:
 *
 *   units = round(euros × unitsPerEuro)
 *
 * and the split is then computed in base units from the *total*, with the
 * publisher leg as the remainder. That is what prevents rounding drift: the two
 * transfers always sum to the exact total, even when the total is an odd number
 * of lamports. The ledger reservation is re-quantised to the same base units, so
 * what the ledger debits is exactly what the chain moved.
 *
 * @param {{ auto?: boolean, reason?: string, paymentHash?: string }} options
 */
async function runSolanaPayout({ auto = false, reason = 'manual', paymentHash = '', anchorSignature = '' } = {}) {
  const trigger = auto ? 'auto' : 'manual';
  const profile = solana.publicProfile();

  if (!profile.enabled) {
    emit({
      stage: 'solana.payout',
      source: 'solana.rail',
      level: 'error',
      title: 'Solana rail disabled',
      detail: 'Set SOLANA_ENABLED=true in server/.env to pay on devnet.',
      data: { trigger, reason }
    });
    return {
      status: 503,
      body: {
        settled: false,
        rail: RAILS.SOLANA,
        error: 'SOLANA_DISABLED',
        message: 'The Solana rail is disabled.',
        solana: profile,
        balance: snapshot()
      }
    };
  }

  // The ledger is stored in integer micro-euros. Solana's quantum is one base
  // unit, i.e. `1 / unitsPerEuro` euros, which for native SOL (1e8 units/€) is
  // 1e-8 € — finer than a micro. Quantising to the nearest representable micro
  // (100 lamports) keeps the reservation and the transfer identical, and the
  // residual is reported by `solana.splitUnits` rather than hidden.
  const unitsPerEuro = Math.max(1, Number(config.solana.unitsPerEuro) || 1);
  const quantumMicros = Math.max(1, Math.round(MICROS_PER_EURO / unitsPerEuro));
  const quantize = (micros) => Math.round(Number(micros) / quantumMicros) * quantumMicros;

  const prepared = ledger.preparePayout({
    maxAmount: config.solana.maxPayout,
    // The rail always has a distinct publisher destination.
    payPublisher: true,
    quantize,
    minMicros: quantumMicros,
    rail: RAILS.SOLANA
  });

  if (!prepared.ok) {
    const messages = {
      PAYOUT_IN_PROGRESS: 'A payout is already in progress on the other rail.',
      THRESHOLD_NOT_REACHED:
        `Payout threshold of €${money(prepared.threshold)} not reached: €${money(prepared.missing)} short.`,
      AMOUNT_TOO_SMALL: prepared.message
    };
    const message = messages[prepared.reason] || 'Payout not available.';

    if (!(auto && prepared.reason === 'THRESHOLD_NOT_REACHED')) {
      emit({
        stage: 'solana.payout',
        source: 'ledger',
        level: 'warn',
        title: 'Payout not started',
        detail: message,
        data: { trigger, reason, rail: RAILS.SOLANA, missing: prepared.missing ?? 0 }
      });
    }

    return {
      status: 409,
      body: {
        settled: false,
        rail: RAILS.SOLANA,
        error: prepared.reason,
        message,
        threshold: prepared.threshold,
        missing: prepared.missing ?? 0,
        solana: profile,
        balance: snapshot()
      }
    };
  }

  const { reservation } = prepared;
  const splitUnits = solana.splitUnits(
    reservation.userAmount,
    reservation.publisherAmount,
    config.userShare
  );

  // Re-base the reservation on the exact split so the debit matches the chain.
  const settledReservation = {
    ...reservation,
    userAmount: splitUnits.readerEuros,
    publisherAmount: splitUnits.publisherEuros,
    total: Math.round((splitUnits.readerEuros + splitUnits.publisherEuros) * 10000) / 10000,
    userRemainder: Math.round((ledger.user.balance - splitUnits.readerEuros) * 10000) / 10000,
    publisherRemainder:
      Math.round((ledger.publisher.balance - splitUnits.publisherEuros) * 10000) / 10000,
    split: { ...reservation.split, reader: splitUnits.readerEuros, publisher: splitUnits.publisherEuros }
  };

  emit({
    stage: 'solana.payout',
    source: 'ledger',
    level: 'info',
    title: auto ? 'On-chain payout triggered automatically' : 'Solana payout requested',
    detail:
      `${reservation.reference} · ${splitUnits.reader} + ${splitUnits.publisher} base units ` +
      `(${splitUnits.reader} reader / ${splitUnits.publisher} publisher) → ${config.solana.cluster}`,
    data: {
      trigger,
      reason,
      rail: RAILS.SOLANA,
      reference: reservation.reference,
      cluster: config.solana.cluster,
      currency: config.solana.currency,
      unitsPerEuro: config.solana.unitsPerEuro,
      units: splitUnits,
      reader: { address: profile.reader, units: splitUnits.reader },
      publisher: { address: profile.publisher, units: splitUnits.publisher },
      treasury: profile.treasury,
      split: settledReservation.split
    }
  });

  let transfer;
  try {
    transfer = await solana.sendSplit({
      readerUnits: splitUnits.reader,
      publisherUnits: splitUnits.publisher,
      reference: reservation.reference,
      paymentHash,
      anchorSignature
    });
  } catch (error) {
    const unfunded = solana.isUnfundedError(error);
    ledger.cancelPayout(error?.message || 'Solana transfer failed');

    emit({
      stage: 'solana.payout',
      source: 'solana.rail',
      level: unfunded ? 'warn' : 'error',
      title: unfunded ? 'On-chain payout skipped · treasury unfunded' : 'On-chain payout failed',
      detail: error?.message || 'Unknown Solana error',
      data: {
        trigger,
        rail: RAILS.SOLANA,
        code: error?.code || 'SOLANA_ERROR',
        status: unfunded ? 'unfunded' : 'failed',
        reference: reservation.reference,
        treasury: profile.treasury,
        faucetUrl: `https://faucet.solana.com?address=${profile.treasury || ''}&network=devnet`,
        explorerUrl: solana.addressUrl(profile.treasury)
      }
    });

    console.error(`[solana] payout failed · ${error?.message || error}`);

    // A devnet faucet outage should not end the demo. The reservation was
    // already cancelled above, so the PayPal rail starts from clean balances.
    if (config.solana.fallbackToPaypal && paypal.isConfigured()) {
      emit({
        stage: 'solana.payout',
        source: 'solana.rail',
        level: 'warn',
        title: 'Falling back to the PayPal rail',
        detail: `${error?.code || 'SOLANA_ERROR'} · the same 70/30 split will be sent through PayPal instead.`,
        data: {
          trigger,
          reason,
          status: unfunded ? 'unfunded' : 'failed',
          failedRail: RAILS.SOLANA,
          fallbackRail: RAILS.PAYPAL,
          treasury: profile.treasury,
          faucetUrl: `https://faucet.solana.com?address=${profile.treasury || ''}&network=devnet`
        }
      });
      const fallback = await runPaypalPayout({ auto, reason: `${reason} (solana fallback)` });
      // Say so explicitly: a caller that asked for Solana must not have to infer
      // from a PayPal batch id that the rail changed under it.
      return {
        ...fallback,
        body: {
          ...fallback.body,
          requestedRail: RAILS.SOLANA,
          fallback: {
            from: RAILS.SOLANA,
            to: RAILS.PAYPAL,
            code: error?.code || 'SOLANA_ERROR',
            message: error?.message || 'Unknown Solana error'
          }
        }
      };
    }

    return {
      status: error?.status || 502,
      body: {
        settled: false,
        rail: RAILS.SOLANA,
        error: error?.code || 'SOLANA_ERROR',
        message: error?.message || 'Unknown Solana error',
        reference: reservation.reference,
        solana: profile,
        balance: snapshot()
      }
    };
  }

  const payout = ledger.commitPayout(settledReservation, {
    rail: RAILS.SOLANA,
    cluster: transfer.cluster,
    signature: transfer.signature,
    slot: transfer.slot,
    status: transfer.status,
    pending: transfer.pending,
    memo: transfer.memo,
    currency: config.solana.currency,
    units: {
      reader: splitUnits.reader,
      publisher: splitUnits.publisher,
      total: splitUnits.total,
      unitsPerEuro: config.solana.unitsPerEuro,
      drift: splitUnits.drift
    },
    mint: transfer.mint,
    decimals: transfer.decimals,
    reader: transfer.reader,
    publisher: transfer.publisher,
    treasury: transfer.treasury,
    explorerUrl: transfer.explorerUrl,
    fee: transfer.fee
  });
  if (auto) lastAutoPayoutAt = Date.now();

  emit({
    stage: 'solana.payout',
    source: 'solana.rail',
    level: 'ok',
    title: `On-chain split ${transfer.status}`,
    detail:
      `${transfer.signature} · ${splitUnits.reader} + ${splitUnits.publisher} base units ` +
      `(${config.solana.currency}) · ${config.solana.cluster}`,
    data: {
      trigger,
      rail: RAILS.SOLANA,
      payoutId: payout?.id,
      signature: transfer.signature,
      slot: transfer.slot,
      status: transfer.status,
      pending: transfer.pending,
      cluster: transfer.cluster,
      currency: config.solana.currency,
      memo: transfer.memo,
      units: splitUnits,
      reader: transfer.reader,
      publisher: transfer.publisher,
      treasury: transfer.treasury,
      fee: transfer.fee,
      reference: reservation.reference,
      explorerUrl: transfer.explorerUrl,
      readerExplorerUrl: transfer.reader?.explorerUrl,
      publisherExplorerUrl: transfer.publisher?.explorerUrl
    }
  });

  console.log(
    `[solana] ${transfer.signature} ${transfer.status} · ${splitUnits.reader}+${splitUnits.publisher} units ` +
      `→ ${transfer.reader.address.slice(0, 8)}…/${transfer.publisher.address.slice(0, 8)}…` +
      (auto ? ` · auto (${reason})` : '')
  );

  return {
    status: 200,
    body: {
      settled: true,
      rail: RAILS.SOLANA,
      trigger,
      payout,
      split: settledReservation.split,
      solana: {
        configured: true,
        cluster: transfer.cluster,
        currency: config.solana.currency,
        mint: transfer.mint,
        decimals: transfer.decimals,
        signature: transfer.signature,
        slot: transfer.slot,
        status: transfer.status,
        pending: transfer.pending,
        memo: transfer.memo,
        units: splitUnits,
        reader: transfer.reader,
        publisher: transfer.publisher,
        treasury: transfer.treasury,
        fee: transfer.fee,
        funded: transfer.funded,
        explorerUrl: transfer.explorerUrl
      },
      balance: snapshot()
    }
  };
}

/**
 * Dispatch a payout to the requested rail.
 *
 * Both rails share the ledger reservation model, the threshold and the 70/30
 * rule; only the settlement call differs. The rail can be named per request
 * (`POST /api/payout { rail }`) and defaults to `PAYOUT_RAIL`.
 *
 * @param {{ auto?: boolean, reason?: string, rail?: string, receiverEmail?: string, publisherEmail?: string, paymentHash?: string }} options
 */
async function runPayoutBatch({
  auto = false,
  reason = 'manual',
  rail,
  receiverEmail,
  publisherEmail,
  paymentHash = '',
  anchorSignature = '',
  sessionId = ''
} = {}) {
  const selected = normalizeRail(rail);

  if (selected === RAILS.SOLANA) {
    return runSolanaPayout({ auto, reason, paymentHash, anchorSignature, sessionId });
  }

  return runPaypalPayout({ auto, reason, receiverEmail, publisherEmail, sessionId });
}

/**
 * Called after every credited attention proof (extension offer or L402 settle).
 *
 * It runs once the reader balance crosses the payout threshold — but only while
 * the session that earned the money is still alive. That check is what removes
 * the last ghost-transaction path: the queue used to fire on a timer, so a tab
 * closed a second after an impression still produced a PayPal batch. Now a
 * departed reader means the batch is abandoned, the balance stays on the
 * ledger, and the next live impression (or an explicit manual settle) pays it.
 *
 * The chain still serialises batches so a burst cannot create a burst of rail
 * calls, but it no longer sleeps first: settlement and payout land in the same
 * tick, which is what the terminal is supposed to show.
 *
 * @param {string} reason
 * @param {{ rail?: string, paymentHash?: string, anchorSignature?: string, sessionId?: string }} options
 */
function queueAutoPayout(
  reason,
  { rail, paymentHash = '', anchorSignature = '', sessionId = '', explicit = false } = {}
) {
  if (!config.paypal.autoPayout) return;

  // The configured rail wins unless the caller names one. If the chosen rail
  // cannot move money (missing credentials, disabled rail) the other one is
  // used instead — a demo should not stall because of a configuration gap.
  let selected = normalizeRail(rail);
  if (!railReady(selected)) {
    const alternate = selected === RAILS.SOLANA ? RAILS.PAYPAL : RAILS.SOLANA;
    if (!railReady(alternate)) return;
    selected = alternate;
  }

  if (ledger.pendingPayout) return;
  if (ledger.user.balance + 1e-9 < config.payoutThreshold) return;
  if (Date.now() - lastAutoPayoutAt < config.paypal.autoPayoutMinIntervalMs) return;
  // No reader, no payout. Checked here *and* again when the chain reaches the
  // front, because the reader can leave while an earlier batch is in flight.
  // `explicit` is reserved for a request that paid its own 402 challenge: that
  // request is the instruction, so it does not need a browser heartbeat.
  if (!explicit && !presence.isActive(sessionId)) {
    emit({
      stage: 'payout',
      source: 'ledger',
      level: 'info',
      title: 'Auto payout skipped · reader not present',
      detail: `€${money(ledger.user.balance)} stays on the ledger until a live session settles it.`,
      data: { trigger: 'auto', reason, rail: selected, sessionId: String(sessionId || '').slice(0, 24) }
    });
    return;
  }

  const epoch = presence.epoch;

  const step = async () => {
    // A reset between queueing and execution must not let an old run's payout
    // land in the new one.
    if (presence.epoch !== epoch) return null;
    if (!explicit && !presence.isActive(sessionId)) {
      emit({
        stage: 'payout',
        source: 'ledger',
        level: 'info',
        title: 'Auto payout cancelled · reader left',
        detail: 'The impression was real; the transfer waits for a live session.',
        data: { trigger: 'auto', reason, rail: selected }
      });
      return null;
    }
    if (ledger.pendingPayout) return null;
    if (ledger.user.balance + 1e-9 < config.payoutThreshold) return null;
    return runPayoutBatch({
      auto: true,
      reason,
      rail: selected,
      paymentHash,
      anchorSignature,
      // Forwarded so the rail layer can emit the same presence evidence the
      // ledger used to authorise the batch.
      sessionId
    });
  };

  const delay = config.paypal.autoPayoutDelayMs;
  autoPayoutChain = autoPayoutChain
    .then(() =>
      delay > 0
        ? new Promise((resolve) => {
            const timer = setTimeout(resolve, delay);
            // Do not hold the process open for a cosmetic pause.
            timer.unref?.();
          })
        : undefined
    )
    .then(step)
    .catch((error) => {
      console.error(`[payout] auto failed · ${error?.message || error}`);
    });
}

/**
 * POST /api/payout — manual settlement from the terminal or the extension
 * popup. `POST /api/flush-payout` is a backwards-compatible alias.
 */
async function handlePayout(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await runPayoutBatch({
    auto: false,
    reason: sanitizeText(body.reason, 60) || 'manual',
    rail: normalizeRail(body.rail),
    receiverEmail: sanitizeText(body.receiverEmail, 120),
    publisherEmail: sanitizeText(body.publisherEmail, 120),
    paymentHash: sanitizeText(body.payment_hash, 80).toLowerCase(),
    anchorSignature: sanitizeText(body.anchor_signature, 120)
  });

  res.status(result.status).json(result.body);
}

app.post('/api/payout', handlePayout);
app.post('/api/flush-payout', handlePayout);

/**
 * GET /api/payout/:id — re-reads a payout so a PENDING transfer can be shown as
 * settled once the rail finishes processing it.
 *
 * `id` is a PayPal batch id or a Solana transaction signature; both are opaque
 * strings, so the rail is detected from the shape (a base58 signature is not a
 * batch id) and confirmed against the ledger.
 */
app.get('/api/payout/:id', async (req, res) => {
  const id = String(req.params.id || '');
  const looksLikeSolana = /^[1-9A-HJ-NP-Za-km-z]{60,90}$/.test(id) && !id.startsWith('ADPAL');

  if (looksLikeSolana) {
    if (!solana.isEnabled()) {
      return res.status(503).json({
        ok: false,
        rail: RAILS.SOLANA,
        error: 'SOLANA_DISABLED',
        message: 'The Solana rail is disabled.'
      });
    }

    try {
      const status = await solana.getStatus(id);
      const payout = ledger.updatePayoutStatus(id, status.confirmationStatus);

      emit({
        stage: 'solana.status',
        source: 'solana.rail',
        level: status.err ? 'error' : 'info',
        title: `Solana transaction ${status.confirmationStatus}`,
        detail: `${id.slice(0, 24)}… · slot ${status.slot ?? '—'}`,
        data: { rail: RAILS.SOLANA, ...status }
      });

      return res.json({
        ok: true,
        rail: RAILS.SOLANA,
        status,
        payout: payout || null,
        explorerUrl: status.explorerUrl,
        balance: snapshot()
      });
    } catch (error) {
      return res.status(error?.status || 502).json({
        ok: false,
        rail: RAILS.SOLANA,
        error: error?.code || 'SOLANA_ERROR',
        message: error?.message || 'Unknown Solana error'
      });
    }
  }

  try {
    const status = await paypal.getPayout(id);
    const payout = ledger.updatePayoutStatus(status.batchId, status.status);

    emit({
      stage: 'payout',
      source: 'adserver.agent',
      level: status.status === 'SUCCESS' ? 'ok' : 'info',
      title: `PayPal batch ${status.status}`,
      detail: `${status.batchId} · item ${status.itemStatus || 'pending'}`,
      data: status
    });

    res.json({ ok: true, rail: RAILS.PAYPAL, status, payout: payout || null, balance: snapshot() });
  } catch (error) {
    const detail = error instanceof paypal.PayPalError
      ? `${error.code} · ${error.message}`
      : error?.message || 'Unknown PayPal error';

    res.status(error?.status || 502).json({
      ok: false,
      rail: RAILS.PAYPAL,
      error: error?.code || 'PAYPAL_ERROR',
      message: detail,
      issues: error?.issues || []
    });
  }
});

// Developer tool: resets counters between demos.
app.post('/api/dev/reset', (_req, res) => {
  ledger.reset();
  rotation.reset();
  ledger.setAdvertiserBudget(rotation.totalBudget({ initial: true }));
  l402Sessions.clear();
  lastOfferByClient.clear();
  lastPresenceWarnAt.clear();
  lastAutoPayoutAt = 0;
  solana.reset();
  /*
   * Invalidates every live reader session and every queued payout.
   *
   * Without this, a batch queued a moment earlier can land *after* the reset,
   * so run N+1 opens with a payout that belongs to run N. Bumping the epoch is
   * what the queue checks; clearing the map stops a stale heartbeat from
   * re-authorising an impression in the new run.
   */
  presence.reset();
  // The webhook replay guard is in-memory state like everything else reset
  // here. Clearing it is what lets the documented demo events be replayed by
  // a repeat run instead of being answered `duplicate` forever.
  seenWebhookEvents.clear();
  webhookReconciler.clear();
  emit({
    stage: 'system',
    source: 'simulator',
    level: 'info',
    title: 'Simulator reset',
    detail: 'Ledger balances, advertiser campaigns, L402 contexts, reader sessions and counters were reset to zero.'
  });
  console.log('[dev] counters reset');
  res.json({ reset: true, balance: snapshot(), accounting: ledger.audit() });
});

/* ------------------------------------------------------------------ */
/* Presentation surfaces                                               */
/* ------------------------------------------------------------------ */

/*
 * Two independent views, deliberately separated:
 *
 *   /demo/      → the publication. Editorial only, no telemetry chrome.
 *   /terminal/  → the agent terminal. Protocol logs only, no article.
 *
 * `serveView` owns both: it sends no-store headers locally, stamps every local
 * stylesheet and script with a content hash, and keeps CSS synchronous in the
 * document head. See src/view-assets.js for the why.
 */

const viewOptions = { production: config.isProduction };

app.use('/terminal', serveView(path.join(config.demoDir, 'terminal'), viewOptions));
app.use('/demo', serveView(config.demoDir, viewOptions));

app.get('/terminal', (_req, res) => res.redirect('/terminal/'));
app.get('/', (_req, res) => res.redirect('/demo/'));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown endpoint.' });
});

app.use((_req, res) => {
  res
    .status(404)
    .type('text/plain')
    .send('AdPal — page not found. Publication: /demo/ · Agent terminal: /terminal/');
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'Invalid JSON body.' });
  }
  console.error('[error]', error);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal simulator error.' });
});

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

/*
 * Express 4 does not forward a rejected promise from an async route to the
 * error handler above, and Node exits on an unhandled rejection. The Solana
 * routes talk to a public devnet RPC that throttles and times out, so a single
 * 429 must not be able to end a running demo: log it loudly and keep serving.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[error] unhandled rejection ·', reason?.stack || reason);
});

/**
 * Starts the simulator, walking forward through ports when the preferred one
 * is taken. A busy port is a normal situation during a demo (a previous
 * terminal still holds it), so it must never crash the process.
 */
function startListening(preferredPort, attempt = 0) {
  /*
   * Bind every interface explicitly.
   *
   * `app.listen(port)` alone usually binds `::`, but a host that resolves to
   * loopback only is unreachable from the platform's reverse proxy — every
   * request, webhooks included, dies before it can be logged. Naming 0.0.0.0
   * removes that failure mode entirely.
   */
  const server = app.listen(preferredPort, '0.0.0.0');
  let started = false;

  server.once('listening', () => {
    started = true;
    serverState.port = preferredPort;
    serverState.url = `http://localhost:${preferredPort}`;
    printBanner(preferredPort);
  });

  server.once('error', (error) => {
    if (started) {
      console.error('[error]', error);
      return;
    }

    const nextPort = preferredPort + 1;
    /*
     * Never scan when the platform assigned the port. Render routes traffic to
     * exactly $PORT; moving to $PORT+1 would leave the service listening on a
     * port nothing can reach, so every request — PayPal's webhooks included —
     * would vanish with no log line anywhere. Failing loudly is the correct
     * outcome there, because the platform will restart the dyno.
     */
    const canRetry =
      error.code === 'EADDRINUSE' &&
      !config.portFromPlatform &&
      attempt < config.portScanRange &&
      nextPort <= 65535;

    if (canRetry) {
      console.warn(`[AdPal] Port ${preferredPort} is busy, trying ${nextPort}…`);
      startListening(nextPort, attempt + 1);
      return;
    }

    if (error.code === 'EADDRINUSE') {
      console.error(
        config.portFromPlatform
          ? `\n[AdPal] Port ${preferredPort} (assigned by the platform) is already in use.` +
            '\nThe port is not negotiable when PORT comes from the environment; refusing to bind elsewhere.\n'
          : `\n[AdPal] Ports ${config.port}-${preferredPort} are all in use.` +
            '\nStop the process holding them, or set PORT / PORT_SCAN_RANGE in server/.env.\n'
      );
      process.exit(1);
    }

    throw error;
  });
}

function printBanner(port) {
  const shifted = port !== config.port;
  const base = `http://localhost:${port}`;

  console.log('');
  console.log('  AdPal — local simulator');
  console.log(`  API        ${base}/api/balance`);
  console.log(`  Demo       ${base}/demo/`);
  console.log(`  Terminal   ${base}/terminal/`);
  console.log(`  Logs       ${base}/api/logs  (SSE)`);
  console.log(`  Split      ${Math.round(config.userShare * 100)}% user · ${Math.round(config.publisherShare * 100)}% publisher`);
  console.log(`  Threshold  €${money(config.payoutThreshold)} · offer cap €${money(config.maxOfferPrice)}`);
  console.log(
    `  Payouts    ${config.paypal.mode} · ${config.paypal.receiverEmail}` +
      (paypal.isConfigured() ? '' : ' · credentials missing')
  );

  /*
   * Webhook environment, stated at boot.
   *
   * A Sandbox webhook id and Live credentials (or any other mix) cannot work
   * together — verification would answer FAILURE for every event, forever, with
   * nothing in the log explaining it. Printing the mode, host and id presence
   * together on one line is what makes that mismatch obvious at deploys.
   */
  const { webhook } = config.paypal;
  console.log(
    `  Webhooks   ${config.paypal.mode} · ${config.paypal.apiBase}` +
      (webhook.id
        ? ` · id ${webhook.id.length > 6 ? `${webhook.id.slice(0, 6)}…` : webhook.id}`
        : ' · PAYPAL_WEBHOOK_ID unset') +
      (webhook.strict ? ' · strict' : '')
  );
  if (!webhook.id) {
    console.log('             notifications are acknowledged unverified; set PAYPAL_WEBHOOK_ID');
  }

  if (shifted) {
    console.log(`  Note       port ${config.port} was busy, using ${port}`);
    console.log('             (the extension discovers this port automatically)');
  }
  console.log('  Stop       Ctrl+C');
  console.log('');
}

startListening(config.port);
