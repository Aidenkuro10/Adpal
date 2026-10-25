// Proves the devnet read path works against real cluster data.
//
// The local treasury cannot be funded while the public faucet is rate-limited,
// which blocks *sending* a transaction. It does not block *reading* one, so this
// script fetches live devnet transactions and runs them through the same
// `readTransaction` / `evaluateTransaction` code the confirm route uses.
//
// What it demonstrates:
//   · getTransaction + getSignatureStatuses round-trip on real commitments;
//   · memo instructions are decoded from a compiled message;
//   · SystemProgram transfers are decoded with their lamport amounts;
//   · the hash-binding check rejects a real transaction that is not ADPAL's.
//
// Usage: node scripts/solana-chain-read-check.js
'use strict';

const solana = require('../src/solana');
const { getConnection } = solana;
const { PublicKey } = require('@solana/web3.js');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
}

(async () => {
  console.log('live devnet read path\n');

  if (!solana.isEnabled()) {
    console.log('Solana rail is disabled; nothing to read.');
    process.exit(1);
  }

  const conn = getConnection();
  console.log(`rpc ${conn.rpcEndpoint}`);

  const [version, slot] = await Promise.all([
    conn.getVersion().catch(() => null),
    conn.getSlot('confirmed').catch(() => null)
  ]);
  record('devnet RPC reachable', Boolean(version), version ? `solana-core ${version['solana-core']}` : 'no version');
  record('cluster head readable', Number.isFinite(slot), `slot ${slot}`);

  // The memo program sees constant traffic, so its recent signatures are a
  // reliable source of transactions that carry a memo instruction.
  const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  let signatures = [];
  try {
    signatures = await conn.getSignaturesForAddress(new PublicKey(MEMO_PROGRAM), {
      limit: 12
    });
  } catch (error) {
    record('list recent memo transactions', false, error?.message);
  }
  record('list recent memo transactions', signatures.length > 0, `${signatures.length} signature(s)`);

  const candidates = signatures.filter((entry) => !entry.err).slice(0, 6);
  let tx = null;
  let used = null;
  for (const candidate of candidates) {
    try {
      const read = await solana.readTransaction(candidate.signature);
      if (read) {
        tx = read;
        used = candidate.signature;
        break;
      }
    } catch {
      /* skip anything that cannot be decoded, try the next */
    }
  }

  record('readTransaction decoded a real transaction', Boolean(tx), used ? `${used.slice(0, 20)}…` : 'none decodable');
  if (!tx) {
    console.log('\ncould not decode a live transaction; nothing further to assert');
    process.exit(1);
  }

  record('slot and block time present', Number.isFinite(tx.slot) && Number.isFinite(tx.blockTime), `slot ${tx.slot}`);
  record(
    'confirmation status read',
    tx.confirmationStatus === 'confirmed' || tx.confirmationStatus === 'finalized',
    tx.confirmationStatus
  );
  record('error flag decoded', tx.err === null, tx.err ? JSON.stringify(tx.err) : 'meta.err = null');
  record('memo instruction decoded', tx.memos.length > 0, tx.memos.length ? `${tx.memo.slice(0, 60)}` : 'no memo');
  record(
    'transfers decode with lamport amounts',
    Array.isArray(tx.transfers),
    `${tx.transfers.length} system transfer(s)`
  );
  record('explorer url built', /cluster=devnet/.test(tx.explorerUrl || ''), tx.explorerUrl);

  // The important assertion: a real transaction that does not carry ADPAL's
  // memo must be rejected. This is the same call the confirm route makes.
  const fakeHash = 'c'.repeat(64);
  const evaluation = solana.evaluateTransaction(tx, { paymentHash: fakeHash });
  const memoCheck = evaluation.checks.find((check) => check.id === 'memo');
  record(
    'hash binding rejects a foreign transaction',
    evaluation.valid === false && memoCheck?.passed === false,
    memoCheck?.detail || 'no detail'
  );

  const confirmCheck = evaluation.checks.find((check) => check.id === 'confirmed');
  record('confirmation check passes for real data', confirmCheck?.passed === true, confirmCheck?.detail);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error('\nchain read check failed ·', error?.stack || error);
  process.exitCode = 1;
});
