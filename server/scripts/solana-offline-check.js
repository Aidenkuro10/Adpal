// Offline checks for the Solana rail: base-unit maths, transaction shape and
// proof evaluation. No SOL is spent and no transaction is broadcast.
//
// Usage: node scripts/solana-offline-check.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { SystemProgram } = require('@solana/web3.js');
const solana = require('../src/solana');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`  FAIL ${name} · ${error.message}`);
  }
}

(async () => {
  console.log('base units');
  await check('1 euro maps to unitsPerEuro', () => {
    assert.strictEqual(solana.toBaseUnits(1), 100_000_000);
  });
  await check('0.056 and 0.024 stay exactly 70/30', () => {
    const split = solana.splitUnits(0.056, 0.024);
    assert.strictEqual(split.total, 8_000_000);
    assert.strictEqual(split.reader, 5_600_000);
    assert.strictEqual(split.publisher, 2_400_000);
    assert.strictEqual(split.drift, 0);
    assert.strictEqual(split.aligned, true);
  });
  await check('the two legs always sum to the total, odd totals included', () => {
    for (const [reader, publisher] of [
      [0.07, 0.03],
      [0.035, 0.015],
      [0.001, 0.0001],
      [0.00000001, 0]
    ]) {
      const split = solana.splitUnits(reader, publisher);
      assert.strictEqual(split.reader + split.publisher, split.total);
      assert.ok(Number.isInteger(split.reader) && Number.isInteger(split.publisher));
    }
  });
  await check('no cent truncation: 0.014 keeps every base unit', () => {
    // PayPal would floor this to 0.01 (14 000 000 → 1 000 000 units); Solana
    // moves the whole amount.
    assert.strictEqual(solana.toBaseUnits(0.014), 1_400_000);
  });
  await check('euro round trip is lossless on the payout grid', () => {
    for (const value of [0.014, 0.056, 0.0987]) {
      assert.strictEqual(solana.fromBaseUnits(solana.toBaseUnits(value)), value);
    }
  });

  console.log('\ntransaction shape');
  const paymentHash = crypto.randomBytes(32).toString('hex');
  const split = solana.splitUnits(0.07, 0.03);
  const prepared = await solana.buildSplitInstructions({
    readerUnits: split.reader,
    publisherUnits: split.publisher,
    reference: 'ADPAL-OFFLINE',
    paymentHash
  });

  await check('one instruction per leg, plus the memo', () => {
    assert.strictEqual(prepared.instructions.length, 3);
  });
  await check('legs carry the integer amounts in order', () => {
    const [readerLeg, publisherLeg] = prepared.instructions;
    assert.strictEqual(readerLeg.programId.toBase58(), SystemProgram.programId.toBase58());
    assert.strictEqual(Number(readerLeg.data.readBigUInt64LE(4)), split.reader);
    assert.strictEqual(Number(publisherLeg.data.readBigUInt64LE(4)), split.publisher);
    assert.strictEqual(readerLeg.keys[1].pubkey.toBase58(), prepared.readerAddress.toBase58());
    assert.strictEqual(publisherLeg.keys[1].pubkey.toBase58(), prepared.publisherAddress.toBase58());
  });
  await check('memo commits to the L402 hash and both legs', () => {
    const memo = prepared.memo;
    assert.ok(memo.startsWith('ADPAL/v1|kind=payout|'));
    assert.ok(memo.includes(`hash=${paymentHash}`));
    assert.ok(memo.includes(`reader=${split.reader}`));
    assert.ok(memo.includes(`publisher=${split.publisher}`));
    const parsed = solana.parseMemo(memo);
    assert.strictEqual(parsed.hash, paymentHash);
    assert.strictEqual(Number(parsed.reader) + Number(parsed.publisher), split.total);
  });
  await check('memo stays inside the 566-byte program limit', () => {
    assert.ok(Buffer.byteLength(prepared.memo, 'utf8') < 566);
  });
  await check('a payout memo carries the anchor signature whole', async () => {
    // Truncating a base58 signature would make it unresolvable on an explorer,
    // so the anchor is the one field that is never sliced.
    const anchorSignature = '3'.repeat(87);
    const withAnchor = await solana.buildSplitInstructions({
      readerUnits: split.reader,
      publisherUnits: split.publisher,
      reference: 'ADPAL-OFFLINE',
      paymentHash,
      anchorSignature
    });
    assert.ok(withAnchor.memo.includes(`anchor=${anchorSignature}`));
    assert.strictEqual(solana.parseMemo(withAnchor.memo).anchor, anchorSignature);
    assert.ok(Buffer.byteLength(withAnchor.memo, 'utf8') < 566);
  });

  console.log('\nsignature decoding');
  const { Transaction } = require('@solana/web3.js');
  // A real signed transaction, never sent: signing is local, so this produces a
  // genuine 64-byte signature without touching the network. web3.js hands the
  // signature back as bytes, so the test encodes it the way the RPC does.
  const realTx = new Transaction().add(prepared.instructions[2]);
  realTx.feePayer = prepared.treasury.publicKey;
  realTx.recentBlockhash = '11111111111111111111111111111111';
  realTx.sign(prepared.treasury);

  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function encodeBase58(buffer) {
    const bytes = Buffer.from(buffer);
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
    const digits = [];
    for (let i = zeros; i < bytes.length; i += 1) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j += 1) {
        carry += digits[j] * 256;
        digits[j] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = Math.floor(carry / 58);
      }
    }
    return '1'.repeat(zeros) + digits.reverse().map((digit) => ALPHABET[digit]).join('');
  }

  const realSignature = encodeBase58(realTx.signatures[0].signature);

  await check('accepts a real 64-byte signature', () => {
    assert.ok(realSignature.length >= 86 && realSignature.length <= 90, `length ${realSignature.length}`);
    const decoded = solana.decodeSignature(realSignature);
    assert.ok(decoded);
    assert.strictEqual(decoded.length, 64);
  });
  await check('rejects 64 base58 chars that are not 64 bytes', () => {
    // This is the exact shape that made the RPC answer "WrongSize" and crashed
    // the process before it was validated locally.
    assert.strictEqual(solana.decodeSignature('5'.repeat(64)), null);
  });
  await check('rejects an over-long signature', () => {
    assert.strictEqual(solana.decodeSignature('1'.repeat(88)), null);
  });
  await check('rejects non-base58 text', () => {
    assert.strictEqual(solana.decodeSignature('0OIl-not-base58'), null);
    assert.strictEqual(solana.decodeSignature(''), null);
  });

  console.log('\nproof evaluation');
  const tx = {
    signature: 'x'.repeat(64),
    slot: 42,
    blockTime: 1,
    err: null,
    fee: 5000,
    memo: prepared.memo,
    memos: [prepared.memo],
    transfers: [
      { kind: 'sol', from: prepared.treasury.publicKey.toBase58(), to: prepared.readerAddress.toBase58(), units: split.reader },
      { kind: 'sol', from: prepared.treasury.publicKey.toBase58(), to: prepared.publisherAddress.toBase58(), units: split.publisher }
    ],
    confirmationStatus: 'confirmed',
    explorerUrl: 'https://explorer.solana.com/tx/x?cluster=devnet'
  };

  await check('valid when hash, recipient and amount all match', () => {
    const result = solana.evaluateTransaction(tx, {
      paymentHash,
      recipient: prepared.readerAddress.toBase58(),
      units: split.reader
    });
    assert.strictEqual(result.valid, true, result.reason);
  });
  await check('rejects another invoice hash', () => {
    const result = solana.evaluateTransaction(tx, { paymentHash: 'b'.repeat(64) });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.checks.find((c) => c.id === 'memo').passed, false);
  });
  await check('rejects one lamport of drift', () => {
    const result = solana.evaluateTransaction(tx, { paymentHash, units: split.reader + 1 });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.checks.find((c) => c.id === 'amount').passed, false);
  });
  await check('rejects a failed transaction', () => {
    const result = solana.evaluateTransaction({ ...tx, err: { InstructionError: [0, 'Custom'] } }, { paymentHash });
    assert.strictEqual(result.valid, false);
  });
  await check('rejects an unconfirmed transaction', () => {
    const result = solana.evaluateTransaction({ ...tx, confirmationStatus: 'processed' }, { paymentHash });
    assert.strictEqual(result.valid, false);
  });
  await check('rejects a missing transaction', () => {
    const result = solana.evaluateTransaction(null, { paymentHash });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.checks[0].id, 'exists');
  });

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` · ${failed.map((result) => result.name).join(', ')}` : '')
  );
  process.exitCode = failed.length ? 1 : 0;
})().catch((error) => {
  console.error('offline check failed', error?.stack || error);
  process.exitCode = 1;
});
