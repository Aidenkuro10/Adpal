// Backend health check for the AdPal dual-rail simulator.
//
// Verifies, against a running server:
//   1. core endpoints answer 200 with the expected shape;
//   2. the L402 protocol routes are mounted on both prefixes;
//   3. the Solana rail reports its configuration;
//   4. the terminal SSE stream is open and delivering events.
//
// Usage: node scripts/health-check.js [baseUrl]
'use strict';

const base = process.argv[2] || 'http://localhost:3000';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${name}${detail ? ` · ${detail}` : ''}`);
}

async function probe(method, path, { body = null, expect = 200, note = '' } = {}) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    record(`${method} ${path}`, false, `unreachable · ${error?.message || error}`);
    return null;
  }
  const ms = Date.now() - startedAt;
  let payload = null;
  const text = await response.text();
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  const ok = response.status === expect;
  record(
    `${method} ${path}`,
    ok,
    `${response.status} in ${ms}ms${note ? ` · ${note}` : ''}${ok ? '' : ` · expected ${expect}`}`
  );
  return { status: response.status, ms, payload };
}

(async () => {
  console.log(`AdPal health check · ${base}\n`);

  console.log('core endpoints');
  const health = await probe('GET', '/api/health');
  if (health) {
    const rails = health.payload?.rails || {};
    record(
      'health reports both rails',
      rails.paypal === true && rails.solana === true,
      `paypal=${rails.paypal} solana=${rails.solana} active=${rails.active}`
    );
    record('health reports the Solana cluster', Boolean(health.payload?.solana?.cluster), health.payload?.solana?.cluster);
  }

  await probe('GET', '/api/toolkit');
  await probe('GET', '/api/agents');
  await probe('GET', '/api/balance');
  await probe('GET', '/api/telemetry');

  console.log('\nSolana rail');
  const solana = await probe('GET', '/api/solana');
  if (solana) {
    const p = solana.payload || {};
    record('solana profile is complete', Boolean(p.cluster && p.treasury && p.reader && p.publisher),
      `treasury ${String(p.treasury || '').slice(0, 8)}… · ${p.unitsPerEuro ?? '?'} units/€`);
    record('solana explorer base present', Boolean(p.explorerBase), p.explorerBase);
    // An unfunded treasury is a state to report, not a failure to fix here.
    const bal = p.balances || {};
    console.log(
      `       treasury balance ${bal.treasury ?? '?'} lamports (${bal.treasurySol ?? '?'} SOL)` +
        (bal.error ? ` · ${bal.error}` : '')
    );
  }

  console.log('\nL402 protocol (both prefixes)');
  // `/offer` is the gated resource itself, so it answers 402 until a bearer
  // token is presented. That is the protocol working, not an outage.
  const offerUnauth = await probe('GET', '/api/l402/offer', { expect: 402, note: 'unauthenticated → 402 by design' });
  record(
    'unauthenticated offer carries a WWW-Authenticate challenge',
    Boolean(offerUnauth?.payload?.challenge?.www_authenticate || offerUnauth?.payload?.challenge?.payment_hash),
    'challenge present'
  );
  await probe('GET', '/api/l402/sessions');
  await probe('GET', '/l402/offer', { expect: 402, note: 'protocol-native alias' });

  const challenge = await probe('POST', '/api/l402/challenge', {
    body: { offer_id: 'attention_session_v1' },
    expect: 402,
    note: 'expects 402'
  });
  const token = challenge?.payload?.payment_context_token;
  const hash = challenge?.payload?.challenge?.payment_hash || challenge?.payload?.challenge?.paymentHash;
  record(
    'challenge returns a context token and payment hash',
    Boolean(token) && /^[0-9a-f]{64}$/.test(String(hash)),
    `token ${String(token || '').slice(0, 8)}… · hash ${String(hash || '').slice(0, 12)}…`
  );

  console.log('\nL402 settlement (402 → macaroon → 200)');
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
  const settle = await probe('POST', '/api/l402/settle', {
    body: { payment_context_token: token, attention: { signals } }
  });
  const bearer = settle?.payload?.bearer_token;
  record(
    'settle mints a macaroon and records the split',
    Boolean(bearer) && Boolean(settle?.payload?.receipt),
    `score ${settle?.payload?.receipt?.score ?? '?'} · rail ${settle?.payload?.receipt?.payoutRail ?? '?'}`
  );

  // Presenting the macaroon must unlock the same resource that 402'd above.
  // The minted credential is a `Bearer` token (see token_type in the settle
  // response); the `L402` scheme is not accepted by readBearer.
  const startedAt = Date.now();
  const unlocked = await fetch(`${base}/api/l402/offer`, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(15000)
  }).catch(() => null);
  record(
    'macaroon unlocks the paid resource · 200',
    unlocked?.status === 200,
    unlocked ? `${unlocked.status} in ${Date.now() - startedAt}ms` : 'unreachable'
  );

  const anchor = settle?.payload?.solana?.anchor || settle?.payload?.receipt?.solana?.anchor;
  console.log(
    `       anchor ${anchor?.status || 'none'}` +
      (anchor?.signature ? ` · ${anchor.signature.slice(0, 16)}…` : ` · ${anchor?.code || 'no signature'}`)
  );

  console.log('\nSolana verification route');
  await probe('POST', '/api/l402/solana/confirm', {
    body: { signature: '5'.repeat(64), payment_context_token: token },
    expect: 402,
    note: 'malformed signature rejected, not a 500'
  });

  // The confirm route must reject cleanly rather than take the process down;
  // if the server died here, the next probe would report unreachable.
  const alive = await probe('GET', '/api/health', { note: 'still alive after a bad proof' });
  record('server survived an invalid on-chain proof', Boolean(alive));

  console.log('\nPayPal webhook route');
  const webhook = await probe('POST', '/api/webhooks/paypal', {
    body: {
      id: `WH-HEALTH-${Date.now().toString(36).toUpperCase()}`,
      event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
      resource: { payout_batch_id: 'HEALTH-CHECK-NO-BATCH' }
    },
    note: 'well-formed event acknowledged'
  });
  record(
    'webhook acknowledges with an explicit outcome',
    webhook?.payload?.received === true &&
      ['handled', 'ignored', 'duplicate', 'unmatched'].includes(webhook?.payload?.outcome),
    `outcome=${webhook?.payload?.outcome} signature=${webhook?.payload?.signature}`
  );

  // An unknown event type must be acknowledged, not rejected: PayPal retries
  // every non-2xx forever, so refusing one would be an infinite loop.
  const unknownEvent = await probe('POST', '/api/webhooks/paypal', {
    body: { id: `WH-HEALTH-UNKNOWN-${Date.now().toString(36).toUpperCase()}`, event_type: 'ADPAL.HEALTH.PROBE' },
    note: 'unknown type is not an outage'
  });
  record(
    'unknown event type is ignored, not rejected',
    unknownEvent?.payload?.outcome === 'ignored',
    `outcome=${unknownEvent?.payload?.outcome}`
  );

  await probe('POST', '/api/webhooks/paypal', {
    body: 'not-an-event',
    expect: 400,
    note: 'non-event body refused'
  });

  console.log('\nterminal SSE stream');
  const stream = await new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ open: false, events: 0, reason: 'no data within 6s' });
    }, 6000);

    fetch(`${base}/api/logs`, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
      .then(async (response) => {
        if (!response.ok || !response.body) {
          clearTimeout(timer);
          controller.abort();
          return resolve({ open: false, events: 0, reason: `HTTP ${response.status}` });
        }
        const contentType = response.headers.get('content-type') || '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let events = 0;
        let stages = [];

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            if (!frame.includes('event:') && !frame.includes('data:')) continue;
            events += 1;
            const stage = /"stage"\s*:\s*"([^"]+)"/.exec(frame);
            if (stage) stages.push(stage[1]);
            if (events >= 2) {
              clearTimeout(timer);
              controller.abort();
              return resolve({ open: true, events, contentType, stages });
            }
          }
        }
        clearTimeout(timer);
        resolve({ open: true, events, contentType, stages });
      })
      .catch((error) => {
        clearTimeout(timer);
        // An abort after a successful read is the normal way out of this loop.
        resolve({ open: error?.name === 'AbortError', events: 0, reason: error?.message });
      });
  });

  record('GET /api/logs streams text/event-stream', Boolean(stream.open), stream.contentType || stream.reason);
  record('stream delivers events', stream.events > 0, `${stream.events} event(s)${stream.stages?.length ? ` · ${[...new Set(stream.stages)].join(', ')}` : ''}`);

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? `\n  failed: ${failed.map((result) => result.name).join(', ')}` : '')
  );
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error('\nhealth check aborted ·', error?.stack || error);
  process.exitCode = 1;
});
