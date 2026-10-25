// AdPal Solana rail smoke test.
//
// Exercises the dual-rail flow end to end against a running server:
//   1. 402 challenge → settle with attention proof;
//   2. read the anchor recorded on the receipt;
//   3. confirm an on-chain signature through /api/l402/solana/confirm;
//   4. keep settling until the reader balance crosses the payout threshold;
//   5. force a payout on each rail and print the resulting identifiers.
//
// A devnet treasury with no SOL is a normal outcome here: the anchor is then
// reported as `unfunded` with a faucet link, and the payout reports the exact
// reason instead of silently pretending to have paid. The script prints what
// actually happened and exits non-zero only when the API itself misbehaves.
//
// Usage: node scripts/solana-smoke.js [baseUrl]
'use strict';

const base = process.argv[2] || 'http://localhost:3000';

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const signals = {
  durationMs: 7600,
  pageDwellMs: 15400,
  mouseMoves: 96,
  directionChanges: 21,
  scrollEvents: 14,
  scrollDepth: 0.72,
  clicks: 2,
  keyPresses: 8,
  visibleRatio: 0.94,
  focusRatio: 0.88,
  slotVisibleRatio: 0.91,
  webdriver: false
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settleOnce(label = '') {
  const challenge = await call('/api/l402/challenge', {
    method: 'POST',
    body: JSON.stringify({ offer_id: 'attention_session_v1' })
  });
  const token = challenge.body?.payment_context_token;
  const paymentHash = challenge.body?.challenge?.payment_hash || challenge.body?.challenge?.paymentHash;

  if (!token) {
    console.log('challenge', challenge.status, JSON.stringify(challenge.body));
    return null;
  }

  const settle = await call('/api/l402/settle', {
    method: 'POST',
    body: JSON.stringify({ payment_context_token: token, attention: { signals } })
  });

  console.log(
    `settle${label} ${settle.status} ${settle.body?.message || settle.body?.error || ''} · hash ${String(paymentHash || '').slice(0, 12)}…`
  );
  if (settle.body?.receipt) {
    console.log('  score', settle.body.receipt.score, 'split', JSON.stringify(settle.body.receipt.split));
    console.log('  anchor', JSON.stringify(settle.body.receipt.solana?.anchor));
    console.log('  payoutRail', settle.body.receipt.payoutRail);
  }

  return { token, paymentHash, settle };
}

/**
 * One-line summary of a payout response, whatever rail answered.
 *
 * The Solana call can legitimately return a PayPal batch id when the devnet
 * treasury is unfunded and `SOLANA_FALLBACK_TO_PAYPAL` is on, so the rail is
 * read from the response instead of assumed from the request.
 */
function describePayout(requestedRail, result) {
  const body = result.body || {};
  const signature = body.solana?.signature || null;
  const batchId = body.paypal?.batchId || null;
  const rail = body.rail || (batchId ? 'paypal_payouts' : signature ? 'solana-devnet' : null);

  return {
    status: result.status,
    requested: requestedRail,
    rail: rail || null,
    fallback: Boolean(rail) && rail !== requestedRail,
    id: signature || batchId || null,
    state: signature
      ? body.solana.pending
        ? 'pending'
        : body.solana.status
      : batchId
        ? body.paypal.status || 'sent'
        : body.error || 'settled',
    units: body.solana?.units || null,
    explorerUrl: body.solana?.explorerUrl || null,
    fallbackReason: body.fallback ? `${body.fallback.code}: ${body.fallback.message}` : null,
    message: body.message || null
  };
}

(async () => {
  const health = await call('/api/health');
  console.log('health', health.status, 'rails', JSON.stringify(health.body?.rails?.active ?? health.body?.rails));

  const rail = await call('/api/solana');
  console.log(
    'solana',
    rail.status,
    rail.body?.cluster,
    'treasury',
    rail.body?.treasury,
    'balances',
    JSON.stringify(rail.body?.balances)
  );

  const first = await settleOnce();
  if (!first) process.exit(1);

  // Proving the confirm route works needs a signature to confirm. Without a
  // funded treasury there is none, so the route's rejection path is what gets
  // exercised — and it must reject cleanly rather than 500.
  const anchorSignature = first.settle.body?.solana?.anchorSignature;
  if (anchorSignature) {
    const confirm = await call('/api/l402/solana/confirm', {
      method: 'POST',
      body: JSON.stringify({ signature: anchorSignature, payment_context_token: first.token })
    });
    console.log(
      'confirm anchor',
      confirm.status,
      confirm.body?.verified,
      confirm.body?.checks?.map((check) => `${check.id}:${check.passed}`).join(',')
    );
  } else {
    // No anchor to confirm, so the two rejection paths are exercised instead:
    // a shape-valid signature that devnet has never seen, and a malformed one.
    // Both must be a 402 with per-check detail — never a 500, and never a crash.
    const unknown = await call('/api/l402/solana/confirm', {
      method: 'POST',
      body: JSON.stringify({
        // 64 base58 '1's decode to 64 zero bytes: the right size, no such tx.
        signature: '1'.repeat(64),
        payment_context_token: first.token
      })
    });
    console.log(
      'confirm (unknown signature)',
      unknown.status,
      unknown.body?.verified,
      unknown.body?.checks?.map((check) => `${check.id}:${check.passed}`).join(',')
    );

    const malformed = await call('/api/l402/solana/confirm', {
      method: 'POST',
      body: JSON.stringify({
        // 64 chars but only ~47 bytes: the RPC answers WrongSize for this, so it
        // has to be rejected locally.
        signature: '5'.repeat(64),
        payment_context_token: first.token
      })
    });
    console.log(
      'confirm (wrong-size signature)',
      malformed.status,
      malformed.body?.verified,
      malformed.body?.checks?.map((check) => `${check.id}:${check.passed}`).join(',')
    );
  }

  // The reader keeps only 70%, and the payout threshold applies to the reader
  // balance, so one settlement is deliberately not enough.
  let balance = (await call('/api/balance')).body;
  let attempts = 1;
  while (balance && Number(balance.user?.balance ?? 0) + 1e-9 < Number(balance.threshold ?? 0.05) && attempts < 6) {
    attempts += 1;
    await settleOnce(` #${attempts}`);
    // An automatic payout can fire the moment the threshold is crossed, so give
    // the ledger a beat before reading the balance back.
    await sleep(400);
    balance = (await call('/api/balance')).body;
  }

  console.log(
    'balance',
    JSON.stringify({
      reader: balance?.user?.balance,
      publisher: balance?.publisher?.balance,
      threshold: balance?.threshold
    })
  );

  const payoutSolana = await call('/api/payout', {
    method: 'POST',
    body: JSON.stringify({ reason: 'smoke', rail: 'solana-devnet' })
  });
  console.log('payout solana', JSON.stringify(describePayout('solana-devnet', payoutSolana)));

  const payoutPaypal = await call('/api/payout', {
    method: 'POST',
    body: JSON.stringify({ reason: 'smoke', rail: 'paypal_payouts' })
  });
  console.log('payout paypal', JSON.stringify(describePayout('paypal_payouts', payoutPaypal)));

  // A payout id is opaque: the same endpoint has to serve both rails.
  const id = payoutSolana.body?.solana?.signature || payoutPaypal.body?.paypal?.batchId;
  if (id) {
    const status = await call(`/api/payout/${encodeURIComponent(id)}`);
    const body = status.body || {};
    console.log(
      'payout status',
      status.status,
      JSON.stringify({
        rail: body.rail || body.payout?.rail || null,
        state: body.payout?.status || body.status || body.error || null
      })
    );
  }

  await sleep(200);
})().catch((error) => {
  console.error('smoke failed', error?.message || error);
  process.exitCode = 1;
});
