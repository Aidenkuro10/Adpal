#!/usr/bin/env node
'use strict';

/**
 * AdPal L402 inspection client.
 *
 * Modelled on CrawlerPal's `client/main.py`: a small, dependency-free CLI that
 * walks the whole negotiation from the terminal so the protocol can be checked
 * without the browser, the extension or the terminal UI.
 *
 *   1. GET  <server>/api/l402/offer                  → 402 + offer contract
 *   2. POST <payment_request_url>                    → attention proof → bearer
 *   3. GET  <server>/api/l402/offer  (Bearer …)      → paid resource
 *   4. GET  <server>/api/balance                     → PayPal ledger state
 *
 * Usage:
 *   node client/inspect.js
 *   node client/inspect.js --offer attention_session_v1
 *   node client/inspect.js --bot                      # prove the 402 refusal path
 *   node client/inspect.js --with-auth <bearer>       # replay an existing token
 *   node client/inspect.js --json                     # machine-readable transcript
 *   node client/inspect.js --server http://localhost:3001
 */

const DEFAULTS = {
  server: process.env.ADPAL_SERVER || 'http://localhost:3000',
  offer: 'attention_impression_v1',
  timeoutMs: 15000
};

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = {
  dim: (value) => (COLOR ? `\u001b[2m${value}\u001b[0m` : String(value)),
  bold: (value) => (COLOR ? `\u001b[1m${value}\u001b[0m` : String(value)),
  green: (value) => (COLOR ? `\u001b[32m${value}\u001b[0m` : String(value)),
  red: (value) => (COLOR ? `\u001b[31m${value}\u001b[0m` : String(value)),
  yellow: (value) => (COLOR ? `\u001b[33m${value}\u001b[0m` : String(value)),
  cyan: (value) => (COLOR ? `\u001b[36m${value}\u001b[0m` : String(value)),
  violet: (value) => (COLOR ? `\u001b[35m${value}\u001b[0m` : String(value))
};

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = {
    server: DEFAULTS.server,
    offer: DEFAULTS.offer,
    bot: false,
    json: false,
    help: false,
    withAuth: '',
    publisher: 'localhost',
    settleTwice: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--server':
      case '-s':
        args.server = next();
        break;
      case '--offer':
      case '-o':
        args.offer = next();
        break;
      case '--with-auth':
      case '-t':
        args.withAuth = next();
        break;
      case '--publisher':
        args.publisher = next();
        break;
      case '--bot':
        args.bot = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--settle-twice':
        // Proves the settle endpoint is idempotent.
        args.settleTwice = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.server = args.server.replace(/\/+$/, '');
  return args;
}

function usage() {
  return `AdPal — L402 inspection client

Usage
  node client/inspect.js [options]

Options
  -s, --server <url>     Simulator base URL (default ${DEFAULTS.server})
  -o, --offer <id>       Offer to negotiate (default ${DEFAULTS.offer})
  -t, --with-auth <tok>  Skip negotiation and read the resource with this Bearer token
      --publisher <host> Publisher host recorded in the contract (default localhost)
      --bot              Send empty/automated signals to exercise the refusal path
      --settle-twice     Repeat the settle call to demonstrate idempotency
      --json             Print a machine-readable transcript instead of a report
  -h, --help             Show this help

Flow
  1. GET  /api/l402/offer        → expect HTTP 402 + offer contract
  2. POST /api/l402/settle       → attention proof → macaroon bearer token
  3. GET  /api/l402/offer        → expect HTTP 200 + paid resource
  4. GET  /api/balance           → reader/publisher ledger + PayPal state
`;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

const transcript = [];

/** Set by `--json`: the human-readable report is suppressed. */
let SILENT = false;

function out(text) {
  if (!SILENT) process.stdout.write(text);
}

function step(index, title) {
  if (SILENT) return;
  const label = paint.violet(`[${index}]`);
  out(`\n${label} ${paint.bold(title)}\n`);
}

function line(label, value) {
  if (SILENT) return;
  process.stdout.write(`    ${paint.dim(`${label}:`)} ${value}\n`);
}

function ok(message) {
  if (SILENT) return;
  process.stdout.write(`    ${paint.green('✓')} ${message}\n`);
}

function fail(message) {
  if (SILENT) return;
  process.stdout.write(`    ${paint.red('✗')} ${message}\n`);
}

function note(message) {
  if (SILENT) return;
  process.stdout.write(`    ${paint.yellow('!')} ${message}\n`);
}

function block(value) {
  if (SILENT) return;
  const text = JSON.stringify(value, null, 2)
    .split('\n')
    .map((entry) => `    ${paint.dim(entry)}`)
    .join('\n');
  process.stdout.write(`${text}\n`);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function request(method, url, { body, token, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'adpal-inspect/1.0 (+node)'
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new Error(
      timedOut
        ? `${method} ${url} timed out after ${timeoutMs / 1000}s`
        : `${method} ${url} failed: ${error?.message || 'network error'}`
    );
  }

  const raw = await response.text();
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { raw: raw.slice(0, 500) };
    }
  }

  const result = {
    method,
    url,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - started,
    headers: {
      'content-type': response.headers.get('content-type') || '',
      'www-authenticate': response.headers.get('www-authenticate') || '',
      'cache-control': response.headers.get('cache-control') || ''
    },
    body: parsed
  };

  transcript.push(result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

/**
 * Human-like aggregated signals. These are the same shape the extension sends,
 * so the server cannot tell a CLI proof from a real reading session — which is
 * exactly the point of an L402 challenge: the proof is what is being bought.
 */
function humanSignals() {
  return {
    durationMs: 6400,
    pageDwellMs: 12000,
    mouseMoves: 38,
    directionChanges: 14,
    scrollEvents: 7,
    scrollDepth: 0.71,
    clicks: 1,
    keyPresses: 3,
    visibleRatio: 0.98,
    focusRatio: 0.96,
    slotVisibleRatio: 0.94,
    webdriver: false,
    clientSentAt: Date.now()
  };
}

/** A script: no dwell, no interaction, automation flag set. */
function botSignals() {
  return {
    durationMs: 40,
    pageDwellMs: 40,
    mouseMoves: 0,
    directionChanges: 0,
    scrollEvents: 0,
    scrollDepth: 0,
    clicks: 0,
    keyPresses: 0,
    visibleRatio: 0.1,
    focusRatio: 0,
    slotVisibleRatio: 0,
    webdriver: true,
    clientSentAt: Date.now()
  };
}

/* ------------------------------------------------------------------ */
/* Flow                                                                */
/* ------------------------------------------------------------------ */

async function run(args) {
  const startedAt = Date.now();
  const summary = {
    server: args.server,
    offer: args.offer,
    mode: args.withAuth ? 'with-auth' : args.bot ? 'bot' : 'human',
    steps: [],
    result: 'incomplete'
  };

  out(`\n${paint.bold('AdPal · L402 inspection')} ${paint.dim(`→ ${args.server}`)}\n`);

  /* -- with-auth: verify an existing token -------------------------- */
  if (args.withAuth) {
    step(1, 'Reading the paid resource with the supplied Bearer token');
    const resource = await request('GET', `${args.server}/api/l402/offer`, { token: args.withAuth });

    line('GET', `${args.server}/api/l402/offer`);
    line('status', statusLabel(resource.status));

    if (resource.status === 200) {
      ok('token accepted · resource served');
      printResource(resource.body);
      summary.steps.push({ name: 'access', status: resource.status, ok: true });
      summary.result = 'resource-served';
    } else if (resource.status === 402) {
      fail(`token refused · ${resource.body?.error?.code || 'PAYMENT_REQUIRED'}`);
      note(resource.body?.error?.message || 'The server returned a fresh contract.');
      block(resource.body);
      summary.steps.push({ name: 'access', status: resource.status, ok: false });
      summary.result = 'token-refused';
    } else {
      fail(`unexpected status ${resource.status}`);
      block(resource.body);
      summary.steps.push({ name: 'access', status: resource.status, ok: false });
      summary.result = 'unexpected';
    }

    await printLedger(args, summary, 2);
    return finish(args, summary, startedAt);
  }

  /* -- 1. Fetch the 402 contract ------------------------------------ */
  step(1, 'Requesting the offer contract (unauthenticated)');
  const offerUrl = `${args.server}/api/l402/offer?offer_id=${encodeURIComponent(args.offer)}&publisher=${encodeURIComponent(args.publisher)}`;
  const contractResponse = await request('GET', offerUrl);

  line('GET', `/api/l402/offer?offer_id=${args.offer}`);
  line('status', statusLabel(contractResponse.status));

  if (contractResponse.status !== 402) {
    fail(`expected 402, received ${contractResponse.status}`);
    block(contractResponse.body);
    summary.steps.push({ name: 'contract', status: contractResponse.status, ok: false });
    return finish(args, summary, startedAt);
  }

  const contract = contractResponse.body || {};
  ok('402 Payment Required · contract received');
  line('protocol', contract.protocol || '—');
  line('version', contract.version || '—');
  line('payment_request_url', contract.payment_request_url || '—');
  line('payment_context_token', contract.payment_context_token || '—');
  line('payment_hash', contract.challenge?.payment_hash || '—');
  line('expires_at', contract.expires_at || '—');
  if (contractResponse.headers['www-authenticate']) {
    line('WWW-Authenticate', truncate(contractResponse.headers['www-authenticate'], 88));
  }

  out(`\n    ${paint.dim('offers')}\n`);
  for (const offer of Array.isArray(contract.offers) ? contract.offers : []) {
    const selected = offer.id === contract.selected_offer_id ? paint.green(' ← selected') : '';
    out(
      `      ${paint.cyan(offer.id)} · ${money(offer.amount, offer.currency)} · ` +
        `${offer.payment_methods?.join(', ') || '—'}${selected}\n`
    );
    out(`        ${paint.dim(offer.description || '')}\n`);
  }

  summary.steps.push({ name: 'contract', status: 402, ok: true, contract });

  if (!contract.payment_request_url || !contract.payment_context_token) {
    fail('contract is missing payment_request_url or payment_context_token');
    return finish(args, summary, startedAt);
  }

  /* -- 2. Settle with an attention proof ---------------------------- */
  step(2, args.bot ? 'Settling with deliberately bot-like signals' : 'Settling with an attention proof');

  const signals = args.bot ? botSignals() : humanSignals();
  const settleBody = {
    payment_context_token: contract.payment_context_token,
    offer_id: contract.selected_offer_id || args.offer,
    attention: { signals }
  };

  out(`    ${paint.dim('proof:')}\n`);
  block({
    durationMs: signals.durationMs,
    mouseMoves: signals.mouseMoves,
    scrollEvents: signals.scrollEvents,
    scrollDepth: signals.scrollDepth,
    visibleRatio: signals.visibleRatio,
    webdriver: signals.webdriver
  });

  const settle = await request('POST', contract.payment_request_url, { body: settleBody });
  line('POST', new URL(contract.payment_request_url).pathname);
  line('status', statusLabel(settle.status));

  if (settle.status !== 200) {
    const error = settle.body?.error || {};
    const code = typeof error === 'string' ? error : error.code;
    note(`settlement refused · ${code || settle.status}`);
    note(typeof error === 'object' ? error.message || settle.body?.message || '' : settle.body?.message || '');
    if (settle.body?.checks) printChecks(settle.body.checks);
    summary.steps.push({ name: 'settle', status: settle.status, ok: false, body: settle.body });
    summary.result = 'settlement-refused';

    if (settle.status === 402 && settle.body?.payment_context_token) {
      note('the context token stays valid — retry with a real reading session');
    }

    await printLedger(args, summary, 3);
    return finish(args, summary, startedAt);
  }

  const bearer = settle.body?.bearer_token || '';
  ok('settled · bearer token issued');
  line('bearer_token', bearer ? `${bearer.slice(0, 28)}… (${bearer.length} chars)` : '—');
  line('macaroon id', settle.body?.macaroon?.id || '—');
  line('caveats', settle.body?.macaroon?.caveats ?? '—');
  line('payment_hash', settle.body?.macaroon?.paymentHashFull || '—');
  line('expires_at', settle.body?.expires_at || '—');

  if (settle.body?.proof) {
    line('attention', `${settle.body.proof.score}/100 · ${settle.body.proof.verdict}`);
    printChecks(settle.body.proof.checks);
  }

  summary.steps.push({ name: 'settle', status: 200, ok: true, bearerToken: bearer });

  if (args.settleTwice) {
    out(`\n    ${paint.dim('replaying the settle call to prove idempotency')}\n`);
    const replay = await request('POST', contract.payment_request_url, { body: settleBody });
    if (replay.status === 200 && replay.body?.idempotent === true) {
      ok(`idempotent · same bearer token returned (${replay.body.context?.state || 'settled'})`);
      summary.steps.push({ name: 'settle-replay', status: 200, ok: true, idempotent: true });
    } else {
      fail(`replay was not idempotent (status ${replay.status})`);
      summary.steps.push({ name: 'settle-replay', status: replay.status, ok: false });
    }
  }

  if (!bearer) {
    fail('no bearer_token in the settle response');
    return finish(args, summary, startedAt);
  }

  /* -- 3. Read the paid resource ------------------------------------ */
  step(3, 'Reading the paid resource with the Bearer token');
  const resource = await request('GET', `${args.server}/api/l402/offer`, { token: bearer });
  line('GET', '/api/l402/offer  Authorization: Bearer …');
  line('status', statusLabel(resource.status));

  if (resource.status === 200) {
    ok('resource served');
    printResource(resource.body);
    summary.steps.push({ name: 'access', status: 200, ok: true });
    summary.result = 'settled';
  } else {
    fail(`expected 200, received ${resource.status}`);
    block(resource.body);
    summary.steps.push({ name: 'access', status: resource.status, ok: false });
    summary.result = 'access-refused';
  }

  /* -- 4. Ledger ---------------------------------------------------- */
  await printLedger(args, summary);

  /* -- 5. Context receipt ------------------------------------------- */
  step(5, 'Negotiation context receipt');
  const receipt = await request('GET', `${args.server}/api/l402/receipt/${contract.payment_context_token}`);
  line('state', receipt.body?.context?.state || statusLabel(receipt.status));
  line('attempts', receipt.body?.context?.attempts ?? '—');
  line('reads', receipt.body?.context?.reads ?? '—');
  if (receipt.body?.context?.receipt?.publisher) {
    line('publisher', receipt.body.context.receipt.publisher);
  }
  summary.steps.push({ name: 'receipt', status: receipt.status, ok: receipt.ok });

  return finish(args, summary, startedAt);
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

function printChecks(checks) {
  if (SILENT) return;
  if (!Array.isArray(checks) || checks.length === 0) return;
  const failed = checks.filter((check) => check.status === 'fail');
  process.stdout.write(
    `    ${paint.dim('guards:')} ${checks.length - failed.length}/${checks.length} passed`
  );
  if (failed.length > 0) {
    process.stdout.write(` ${paint.red(`· failed: ${failed.map((check) => check.id).join(', ')}`)}`);
  }
  process.stdout.write('\n');
}

function printResource(body) {
  if (!body || typeof body !== 'object') return;

  line('resource', `${body.resource?.type || '—'} · ${body.resource?.offer_id || '—'}`);
  line('credential', body.grant?.credential || '—');
  line('max_price', body.grant?.max_price ? `${body.grant.max_price} EUR` : '—');

  const impression = body.impression;
  if (impression) {
    line('receipt', impression.reference || '—');
    line('score', `${impression.score}/100 · ${impression.verdict}`);
    line(
      'split',
      `${money(impression.split?.user, impression.currency)} reader / ` +
        `${money(impression.split?.publisher, impression.currency)} publisher`
    );
    line('creative', `${impression.creative?.sponsor || '—'} · ${impression.creative?.id || '—'}`);
    line('agent', `${impression.agent?.id || '—'} (${impression.agent?.name || '—'})`);
    line('payout rail', impression.payoutRail || '—');
  } else {
    note('no impression receipt on this grant (macaroon replayed without a context)');
  }
}

async function printLedger(args, summary, index = 4) {
  step(index, 'PayPal ledger state');
  let balance;
  try {
    balance = await request('GET', `${args.server}/api/balance`);
  } catch (error) {
    fail(error.message);
    summary.steps.push({ name: 'ledger', status: 0, ok: false });
    return;
  }

  if (!balance.ok) {
    fail(`/api/balance returned ${balance.status}`);
    summary.steps.push({ name: 'ledger', status: balance.status, ok: false });
    return;
  }

  const data = balance.body || {};
  const user = data.user || {};
  const publisher = data.publisher || {};
  const paypalProfile = data.paypal || {};

  line('reader balance', paint.bold(money(user.balance, data.currency)));
  line('reader lifetime', money(user.lifetime, data.currency));
  line('publisher balance', money(publisher.balance, data.currency));
  line('threshold', money(data.threshold, data.currency));
  line('offers accepted', user.offersAccepted ?? 0);
  line(
    'paypal',
    `${paypalProfile.mode || '—'} · ${paypalProfile.configured ? 'configured' : 'missing credentials'} · ` +
      `${paypalProfile.receiverEmail || '—'}`
  );

  const payout = Array.isArray(data.payouts) ? data.payouts[0] : null;
  if (payout?.paypal?.batchId) {
    line('last batch', `${payout.paypal.batchId} · ${payout.paypal.status}`);
  } else if ((user.balance || 0) >= (data.threshold || Infinity)) {
    note('balance is above the payout threshold — settle a payout from the terminal');
  }

  summary.steps.push({
    name: 'ledger',
    status: balance.status,
    ok: true,
    balance: {
      user: user.balance,
      publisher: publisher.balance,
      threshold: data.threshold,
      currency: data.currency
    }
  });
}

function statusLabel(status) {
  if (status === 402) return paint.yellow('402 Payment Required');
  if (status === 200) return paint.green('200 OK');
  if (status >= 400) return paint.red(`${status}`);
  return String(status);
}

function money(value, currency = 'EUR') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  const code = String(currency || 'EUR').toUpperCase();
  const formatted = amount.toFixed(code === 'EUR' ? 3 : 2);
  return code === 'EUR' ? `€${formatted}` : `${code} ${formatted}`;
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function finish(args, summary, startedAt) {
  summary.durationMs = Date.now() - startedAt;

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ summary, transcript }, null, 2)}\n`);
    return summary.result === 'settled' || summary.result === 'resource-served' ? 0 : 1;
  }

  process.stdout.write(`\n${paint.bold('Summary')}\n`);
  for (const entry of summary.steps) {
    const mark = entry.ok ? paint.green('✓') : paint.red('✗');
    process.stdout.write(`  ${mark} ${entry.name.padEnd(14)} ${entry.status}\n`);
  }

  const verdict =
    summary.result === 'settled' || summary.result === 'resource-served'
      ? paint.green(`completed (${summary.result})`)
      : paint.yellow(summary.result);
  process.stdout.write(`\n  ${paint.dim('result:')} ${verdict} ${paint.dim(`· ${summary.durationMs} ms`)}\n\n`);

  return summary.result === 'settled' || summary.result === 'resource-served' ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${paint.red('error:')} ${error.message}\n\n${usage()}`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  SILENT = args.json;

  try {
    return await run(args);
  } catch (error) {
    process.stderr.write(`\n${paint.red('fatal:')} ${error.message}\n`);
    if (error.code === 'ECONNREFUSED') {
      process.stderr.write(
        `\nThe simulator does not seem to be running. Start it with:\n  cd server && npm start\n`
      );
    }
    return 1;
  }
}

main().then((code) => {
  process.exitCode = Number.isInteger(code) ? code : 1;
});
