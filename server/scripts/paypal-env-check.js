#!/usr/bin/env node
'use strict';

/**
 * PayPal environment consistency check.
 *
 * Answers one question with evidence: do the credentials, the API host and the
 * webhook id all belong to the same PayPal environment (Sandbox or Live)?
 *
 * This cannot be answered by reading `.env`, because the three values are
 * configured independently and a mismatch is silent at runtime:
 *
 *  - PayPal rejects credentials from the other environment with 401
 *    invalid_client, so the credential environment is provable by trying both.
 *  - A webhook id is registered per environment. Verifying against the wrong
 *    one returns verification_status=FAILURE for every event — the same answer a
 *    forged signature gets — so a mismatch looks exactly like tampering and
 *    PayPal retries it forever.
 *
 * The webhook id's environment is proven by reading it from the Webhooks API of
 * the environment the credentials authenticated against. If it resolves, the two
 * match; if it 404s, it was registered elsewhere.
 *
 * Usage:
 *   node scripts/paypal-env-check.js                 # uses server/.env
 *   node scripts/paypal-env-check.js --json          # machine-readable
 *
 * Exit codes: 0 consistent, 1 mismatch or unusable configuration.
 *
 * Run it locally with the deployment's variables when you cannot run it on the
 * host itself:
 *   PAYPAL_MODE=... PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... \
 *   PAYPAL_WEBHOOK_ID=... node scripts/paypal-env-check.js
 */

const config = require('../src/config');
const { paypal } = config;

const SANDBOX = 'https://api-m.sandbox.paypal.com';
const LIVE = 'https://api-m.paypal.com';
const wantJson = process.argv.includes('--json');

const findings = [];
function note(ok, label, detail) {
  findings.push({ ok, label, detail });
  if (!wantJson) console.log(`  ${ok === null ? '—   ' : ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}`);
}

async function tokenFor(base) {
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${paypal.clientId}:${paypal.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000)
  }).catch((error) => ({ ok: false, status: 0, error }));

  if (response.status === 0) {
    return { ok: false, status: 0, error: response.error?.message || 'unreachable' };
  }

  const data = await response.json().catch(() => null);
  return {
    ok: response.ok,
    status: response.status,
    token: data?.access_token || '',
    // The app id prefix is not secret and identifies the REST app.
    appId: data?.app_id ? `${String(data.app_id)}` : '',
    error: data?.error || data?.error_description || ''
  };
}

async function webhookFor(base, bearer, id) {
  const response = await fetch(`${base}/v1/notifications/webhooks/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  }).catch(() => null);
  if (!response) return { status: 0 };
  const data = await response.json().catch(() => null);
  return { status: response.status, url: data?.url || '', events: (data?.event_types || []).map((e) => e.name) };
}

async function listWebhooks(base, bearer) {
  const response = await fetch(`${base}/v1/notifications/webhooks`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  }).catch(() => null);
  if (!response || !response.ok) return [];
  const data = await response.json().catch(() => null);
  return data?.webhooks || [];
}

(async () => {
  if (!wantJson) {
    console.log('PayPal environment consistency\n');
    console.log(`  configured mode   ${paypal.mode}`);
    console.log(`  configured apiBase ${paypal.apiBase}`);
    console.log(`  webhook id        ${paypal.webhook.id || '(unset)'}`);
    console.log('');
  }

  if (!paypal.clientId || !paypal.clientSecret) {
    note(false, 'credentials present', 'set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
    finish();
    return;
  }

  // --- 1. which environment do the credentials belong to? --------------
  const sandbox = await tokenFor(SANDBOX);
  const live = await tokenFor(LIVE);

  note(
    !(sandbox.ok && live.ok),
    'credentials identify one environment',
    sandbox.ok && live.ok ? 'both environments accepted them, which is not expected' : ''
  );

  const credentialEnv = sandbox.ok && !live.ok ? 'sandbox' : live.ok && !sandbox.ok ? 'live' : 'unknown';
  note(
    credentialEnv !== 'unknown',
    'credentials authenticate',
    credentialEnv === 'unknown'
      ? `sandbox HTTP ${sandbox.status} ${sandbox.error || ''} / live HTTP ${live.status} ${live.error || ''}`.trim()
      : `${credentialEnv} (app ${(credentialEnv === 'sandbox' ? sandbox.appId : live.appId).slice(0, 12)}…)`
  );

  // --- 2. does the configured mode agree with the credentials? --------
  note(
    credentialEnv === paypal.mode,
    'PAYPAL_MODE matches the credentials',
    credentialEnv === 'unknown' ? 'cannot compare without a working credential set' : `${paypal.mode} vs ${credentialEnv}`
  );

  // --- 3. is the webhook id in that same environment? -----------------
  const base = credentialEnv === 'live' ? LIVE : SANDBOX;
  const bearer = credentialEnv === 'live' ? live.token : sandbox.token;

  if (!bearer) {
    note(null, 'webhook id environment', 'skipped: no usable token');
    finish();
    return;
  }

  if (!paypal.webhook.id) {
    note(null, 'webhook id environment', 'skipped: PAYPAL_WEBHOOK_ID unset, notifications are accepted unverified');
    finish();
    return;
  }

  const hook = await webhookFor(base, bearer, paypal.webhook.id);
  const registered = hook.status === 200;
  note(
    registered,
    `webhook id resolves in ${credentialEnv}`,
    registered ? hook.url : `HTTP ${hook.status} — registered in the other environment?`
  );

  if (registered) {
    const hosts = await listWebhooks(base, bearer);
    note(
      hosts.some((entry) => entry.id === paypal.webhook.id),
      'webhook id is listed on the same REST app',
      `${hosts.length} webhook(s) on this app`
    );
    note(
      Boolean(hook.url),
      'registered callback URL',
      hook.url || 'none'
    );
    note(
      hook.events.includes('*') ||
        hook.events.some((name) => name.startsWith('PAYMENT.PAYOUTS')),
      'subscribed to payout events',
      hook.events.join(', ') || 'none'
    );
  }

  finish();

  function finish() {
    const failed = findings.filter((entry) => entry.ok === false);
    if (wantJson) {
      console.log(
        JSON.stringify(
          {
            mode: paypal.mode,
            apiBase: paypal.apiBase,
            webhookId: paypal.webhook.id,
            consistent: failed.length === 0,
            findings
          },
          null,
          2
        )
      );
    } else {
      console.log(
        failed.length
          ? `\nMISMATCH · ${failed.length} problem(s): ${failed.map((entry) => entry.label).join(', ')}`
          : '\nCONSISTENT · credentials, API host and webhook id are all the same environment.'
      );
    }
    process.exitCode = failed.length ? 1 : 0;
  }
})().catch((error) => {
  console.error('\ncheck failed ·', error?.stack || error);
  process.exitCode = 1;
});
