'use strict';

/**
 * Solana Devnet rail for AdPal.
 *
 * AdPal already has a real L402 token format: the macaroon identifier is
 * `l402:sha256(preimage)`, and the invoice is settled when attention proof
 * matches that hash. What that flow could never do is prove anything to a third
 * party — the hash only ever lived in this process. This module gives the same
 * hash a public existence on Solana Devnet:
 *
 *   anchor  — a Memo instruction carrying the payment hash, signed by the
 *             treasury, so anyone can look the hash up on an explorer;
 *   verify  — re-reads a signature, checks confirmation, the memo binding, the
 *             exact base-unit amount and the recipient, and refuses replays;
 *   payout  — one transaction, one memo and two System transfers (70% reader /
 *             30% publisher), so the split is atomic and exactly denominated.
 *
 * Everything is integer base units. The euro ledger is only converted at the
 * boundary through `unitsPerEuro`, and the split is computed from the total in
 * base units so the two legs always sum back to the exact amount.
 */

const fs = require('fs');
const path = require('path');
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction
} = require('@solana/web3.js');
const {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  getMint,
  getOrCreateAssociatedTokenAccount
} = require('@solana/spl-token');

const config = require('./config');

const { solana } = config;

/** Devnet is fast but not instant; polling beats a blind fixed sleep. */
const POLL_INTERVAL_MS = 700;
/** A memo instruction is limited to 566 bytes; ours is well under 200. */
const MEMO_MAX_BYTES = 560;

class SolanaError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SolanaError';
    this.status = options.status ?? 502;
    this.code = options.code || 'SOLANA_ERROR';
    this.signature = options.signature || null;
    this.checks = options.checks || null;
  }
}

/* ------------------------------------------------------------------ */
/* Keys and connection                                                */
/* ------------------------------------------------------------------ */

/** @type {{ treasury: Keypair, reader: PublicKey, publisher: PublicKey } | null} */
let keys = null;
let connection = null;
let mintInfo = null;
/** @type {Map<string, { paymentHash: string, contextToken: string, at: number }>} */
const consumedSignatures = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal base58 decoder.
 *
 * A treasury secret can be pasted as base58 (the format Phantom and the CLI
 * export). Decoding it locally avoids adding a dependency for 25 lines of
 * arithmetic, and keeps this module loadable even if a transitive package
 * changes its export shape.
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

function decodeBase58(value) {
  const text = String(value || '').trim();
  if (!text) return Buffer.alloc(0);

  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;

  const bytes = [];
  for (let i = zeros; i < text.length; i += 1) {
    const carry = BASE58_MAP.get(text[i]);
    if (carry === undefined) throw new Error('Invalid base58 character in SOLANA_TREASURY_SECRET.');
    let value = carry;
    for (let j = 0; j < bytes.length; j += 1) {
      value += bytes[j] * 58;
      bytes[j] = value & 0xff;
      value >>= 8;
    }
    while (value > 0) {
      bytes.push(value & 0xff);
      value >>= 8;
    }
  }

  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

function decodeSecret(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  // Accept both the JSON array solana-keygen writes and a base58 secret key,
  // because every tutorial and every tool uses one or the other.
  if (raw.startsWith('[')) {
    const bytes = JSON.parse(raw);
    if (!Array.isArray(bytes)) throw new Error('SOLANA_TREASURY_SECRET is not a byte array.');
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  }

  try {
    const secret = decodeBase58(raw);
    if (secret.length !== 64) {
      throw new Error(`expected 64 bytes, got ${secret.length}`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (error) {
    throw new Error(`SOLANA_TREASURY_SECRET must be a base58 secret key or a JSON byte array (${error?.message}).`);
  }
}

function secretToJson(keypair) {
  return Array.from(keypair.secretKey);
}

/**
 * Loads the demo keypairs once.
 *
 * A configured treasury secret always wins. Otherwise a keypair file is read,
 * and on first boot one is generated and persisted, so the treasury address, the
 * reader and the publisher are stable across restarts — a fresh address every
 * restart would make yesterday's Explorer links meaningless.
 */
function loadKeys() {
  if (keys) return keys;

  const file = solana.keypairFile;
  let stored = null;
  try {
    if (file && fs.existsSync(file)) stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(`[solana] could not read keypair file: ${error?.message || error}`);
  }

  let treasury;
  if (solana.treasurySecret) {
    treasury = decodeSecret(solana.treasurySecret);
  } else if (stored?.treasury && Array.isArray(stored.treasury)) {
    treasury = Keypair.fromSecretKey(Uint8Array.from(stored.treasury));
  } else {
    treasury = Keypair.generate();
  }

  const readerKey = stored?.reader && Array.isArray(stored.reader)
    ? Keypair.fromSecretKey(Uint8Array.from(stored.reader))
    : Keypair.generate();
  const publisherKey = stored?.publisher && Array.isArray(stored.publisher)
    ? Keypair.fromSecretKey(Uint8Array.from(stored.publisher))
    : Keypair.generate();

  const reader = solana.readerAddress ? new PublicKey(solana.readerAddress) : readerKey.publicKey;
  const publisher = solana.publisherAddress
    ? new PublicKey(solana.publisherAddress)
    : publisherKey.publicKey;

  // Only persist keys this process owns; an externally supplied treasury
  // secret is never written to disk.
  if (!solana.treasurySecret && file) {
    try {
      const payload = {
        cluster: solana.cluster,
        note: 'AdPal demo keypairs. Devnet only. Never reuse on mainnet.',
        treasury: secretToJson(treasury),
        reader: secretToJson(readerKey),
        publisher: secretToJson(publisherKey)
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[solana] could not persist keypair file: ${error?.message || error}`);
    }
  }

  keys = { treasury, reader, publisher };
  return keys;
}

function getConnection() {
  if (!connection) {
    connection = new Connection(solana.rpcUrl, 'confirmed');
  }
  return connection;
}

function isEnabled() {
  return Boolean(solana.enabled && solana.rpcUrl);
}

/** Safe-to-expose rail description for the terminal and API responses. */
function publicProfile() {
  let profile = {
    enabled: isEnabled(),
    rail: 'solana-devnet',
    cluster: solana.cluster,
    rpcUrl: solana.rpcUrl,
    currency: solana.currency,
    mint: solana.mint || null,
    decimals: solana.decimals,
    unitsPerEuro: solana.unitsPerEuro,
    explorerBase: solana.explorerBase,
    anchorProofs: solana.anchorProofs,
    airdrop: solana.airdrop,
    maxPayout: solana.maxPayout,
    treasury: null,
    reader: null,
    publisher: null,
    ready: false
  };

  if (!isEnabled()) return profile;

  try {
    const loaded = loadKeys();
    profile = {
      ...profile,
      treasury: loaded.treasury.publicKey.toBase58(),
      reader: loaded.reader.toBase58(),
      publisher: loaded.publisher.toBase58(),
      ready: true
    };
  } catch (error) {
    profile.error = error?.message || 'keypair error';
  }

  return profile;
}

/* ------------------------------------------------------------------ */
/* Base units                                                         */
/* ------------------------------------------------------------------ */

/** Euro ledger amount → integer base units. One place, one rounding rule. */
function toBaseUnits(amountEuros) {
  const value = Number(amountEuros);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value * solana.unitsPerEuro));
}

/** Integer base units → euro ledger amount (inverse of the conversion above). */
function fromBaseUnits(units) {
  const value = Number(units);
  if (!Number.isFinite(value)) return 0;
  return Math.round((value / solana.unitsPerEuro) * 10000) / 10000;
}

/**
 * Converts the two ledger legs into base units.
 *
 * Each leg is converted on its own, exactly once: `round(euros × unitsPerEuro)`.
 * That is what removes PayPal's cent truncation — nothing is floored, and the
 * two integers sum back to the integer image of the total, so no fraction of a
 * unit is silently dropped between the ledger and the transaction.
 *
 * The 70/30 rule lives one level up, in the per-impression split, so the two
 * balances are already in that ratio. `exactReader` re-derives the ratio from the
 * total in base units and `drift` reports the difference; it is zero in normal
 * operation. Cross-subsidising the legs to force a 70/30 total would move money
 * the ledger never reserved (a capped reader payout would drain the publisher
 * balance), so the legs are never rebalanced here — only measured.
 */
function splitUnits(userAmountEuros, publisherAmountEuros, userShare = config.userShare) {
  const reader = toBaseUnits(userAmountEuros);
  const publisher = toBaseUnits(publisherAmountEuros);
  const total = reader + publisher;

  const exactReader = Math.round(total * userShare);
  const exactPublisher = total - exactReader;

  return {
    total,
    reader,
    publisher,
    readerEuros: fromBaseUnits(reader),
    publisherEuros: fromBaseUnits(publisher),
    exactReader,
    exactPublisher,
    drift: reader - exactReader,
    aligned: reader === exactReader,
    userShare,
    publisherShare: Math.round((1 - userShare) * 1000) / 1000
  };
}

function explorerUrl(signature, { address = null, suffix = '' } = {}) {
  if (!signature && !address) return solana.explorerBase;
  const target = signature || address;
  const query = `?cluster=${encodeURIComponent(solana.cluster)}${suffix}`;
  return `${solana.explorerBase}/tx/${encodeURIComponent(target)}${query}`;
}

function addressUrl(address) {
  return `${solana.explorerBase}/address/${encodeURIComponent(address)}?cluster=${encodeURIComponent(
    solana.cluster
  )}`;
}

/* ------------------------------------------------------------------ */
/* Memo (the L402 anchor)                                             */
/* ------------------------------------------------------------------ */

/**
 * Memo format. Deliberately line-oriented key=value rather than JSON: it stays
 * under the memo limit, and `hash=` can be read by any tool without a schema.
 *
 * `anchor` is the one field kept at full length: a truncated signature cannot be
 * looked up on an explorer, so it would be worse than leaving it out.
 */
function buildMemo({ kind = 'proof', paymentHash = '', reference = '', score = null, anchor = '', extra = {} }) {
  const parts = ['ADPAL/v1', `kind=${kind}`];
  if (paymentHash) parts.push(`hash=${String(paymentHash).toLowerCase()}`);
  if (reference) parts.push(`ref=${String(reference).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48)}`);
  if (Number.isFinite(Number(score))) parts.push(`score=${Math.round(Number(score))}`);
  if (anchor) {
    const signature = String(anchor).trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{60,90}$/.test(signature)) {
      throw new SolanaError('The anchor signature is not a base58 transaction signature.', {
        code: 'SOLANA_INVALID_ANCHOR',
        status: 400
      });
    }
    parts.push(`anchor=${signature}`);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined || value === '') continue;
    parts.push(`${key}=${String(value).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48)}`);
  }
  const memo = parts.join('|');
  if (Buffer.byteLength(memo, 'utf8') > MEMO_MAX_BYTES) {
    throw new SolanaError('The memo would exceed the Solana memo limit.', {
      code: 'SOLANA_MEMO_TOO_LONG',
      status: 400
    });
  }
  return memo;
}

function parseMemo(text) {
  const flat = String(text || '');
  if (!flat.startsWith('ADPAL/v1')) return null;
  const map = {};
  for (const part of flat.split('|').slice(1)) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    map[part.slice(0, index)] = part.slice(index + 1);
  }
  return map;
}

function memoInstruction(memo, signer) {
  return new TransactionInstruction({
    programId: new PublicKey(solana.memoProgram),
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, 'utf8')
  });
}

/* ------------------------------------------------------------------ */
/* Funding                                                            */
/* ------------------------------------------------------------------ */

/**
 * Codes that mean "the treasury has no SOL", as opposed to "the transfer is
 * wrong". The UI shows a faucet link for these and an error badge for the rest,
 * so the classification lives in one place.
 */
const UNFUNDED_CODES = Object.freeze([
  'SOLANA_TREASURY_UNFUNDED',
  'SOLANA_AIRDROP_FAILED',
  'SOLANA_AIRDROP_COOLDOWN'
]);

function isUnfundedError(error) {
  return UNFUNDED_CODES.includes(error?.code);
}

/** @type {{ at: number, ok: boolean, message: string } | null} */
let lastAirdrop = null;
const AIRDROP_COOLDOWN_MS = 60_000;

/**
 * One JSON-RPC call with a hard timeout and no hidden retries.
 *
 * web3.js retries 429s with exponential backoff, which is right for a normal
 * RPC read and wrong for a faucet that is simply dry: it turned a fast "no test
 * SOL today" into ~9 s inside a settlement. The faucet is therefore called
 * directly.
 */
async function rpcOnce(method, params, timeoutMs = 8000) {
  const response = await fetch(solana.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'adpal-airdrop', method, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (body?.error) {
    throw new Error(`${body.error.code}: ${body.error.message}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return body?.result;
}

/**
 * Makes sure the treasury can pay for a transaction.
 *
 * A fresh devnet keypair has no SOL, and a payout that fails for lack of fees is
 * an unhelpful demo. When the balance is short the devnet faucet is tried once
 * per minute (it is rate-limited, so silently retrying on every settlement would
 * only produce a wall of 429s).
 */
async function ensureFunded(lamportsNeeded) {
  const { treasury } = loadKeys();
  const conn = getConnection();
  const balance = await conn.getBalance(treasury.publicKey, 'confirmed');

  if (balance >= lamportsNeeded) {
    return { funded: true, balance, airdropped: 0 };
  }

  if (!solana.airdrop) {
    throw new SolanaError(
      `Solana treasury ${treasury.publicKey.toBase58()} needs ${lamportsNeeded} lamports but holds ${balance}.`,
      { status: 503, code: 'SOLANA_TREASURY_UNFUNDED' }
    );
  }

  if (lastAirdrop && Date.now() - lastAirdrop.at < AIRDROP_COOLDOWN_MS && !lastAirdrop.ok) {
    throw new SolanaError(
      `Devnet faucet is cooling down after "${lastAirdrop.message}". Fund the treasury manually.`,
      { status: 503, code: 'SOLANA_AIRDROP_COOLDOWN', treasury: treasury.publicKey.toBase58() }
    );
  }

  const requested = Math.max(lamportsNeeded, Math.round(solana.airdropSol * 1e9));
  let airdropped = 0;

  try {
    const signature = await rpcOnce(
      'requestAirdrop',
      [treasury.publicKey.toBase58(), requested],
      8000
    );
    await waitForSignature(signature, { timeoutMs: 20000 });
    airdropped = requested;
    lastAirdrop = { at: Date.now(), ok: true, message: signature };
  } catch (error) {
    lastAirdrop = { at: Date.now(), ok: false, message: error?.message || 'airdrop failed' };
    throw new SolanaError(
      `Could not fund the devnet treasury: ${error?.message || error}. Fund ${treasury.publicKey.toBase58()} at https://faucet.solana.com and retry.`,
      { status: 503, code: 'SOLANA_AIRDROP_FAILED', treasury: treasury.publicKey.toBase58() }
    );
  }

  const after = await conn.getBalance(treasury.publicKey, 'confirmed');
  return { funded: after >= lamportsNeeded, balance: after, airdropped };
}

/* ------------------------------------------------------------------ */
/* Broadcasting                                                       */
/* ------------------------------------------------------------------ */

async function waitForSignature(signature, { timeoutMs = solana.timeoutMs } = {}) {
  const conn = getConnection();
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let last = null;

  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = value?.[0];
    if (status) {
      last = status;
      if (status.err) {
        throw new SolanaError(`Transaction ${signature} failed on-chain.`, {
          status: 502,
          code: 'SOLANA_TX_FAILED',
          signature
        });
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { signature, slot: status.slot, status: status.confirmationStatus };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Broadcast, not confirmed. The signature is real and the transaction may
  // still land, so callers report it as pending rather than discarding it.
  return {
    signature,
    slot: last?.slot ?? null,
    status: 'processed',
    pending: true,
    note: 'Broadcast accepted but not confirmed before the timeout.'
  };
}

async function submit(instructions, signers, { timeoutMs = solana.timeoutMs } = {}) {
  const conn = getConnection();
  const transaction = new Transaction();
  for (const instruction of instructions) transaction.add(instruction);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = signers[0].publicKey;

  try {
    const raw = transaction.serialize();
    const signature = await conn.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    });
    const confirmation = await waitForSignature(signature, { timeoutMs });
    return {
      ...confirmation,
      explorerUrl: explorerUrl(signature),
      blockhash,
      lastValidBlockHeight,
      fee: null
    };
  } catch (error) {
    if (error instanceof SolanaError) throw error;
    throw new SolanaError(`Solana transaction failed: ${error?.message || error}`, {
      status: 502,
      code: 'SOLANA_TX_ERROR'
    });
  }
}

/* ------------------------------------------------------------------ */
/* Anchor                                                             */
/* ------------------------------------------------------------------ */

/**
 * Writes `sha256(preimage)` on-chain so the L402 hash is publicly verifiable.
 *
 * The transaction carries no money; it is a signed, timestamped memo from the
 * treasury. Its signature is returned with the receipt, so a settlement can be
 * checked against Devnet by anyone holding the receipt.
 */
async function anchorProof({ paymentHash, reference = '', score = null, offerId = '', extra = {} }) {
  if (!isEnabled()) {
    throw new SolanaError('The Solana rail is disabled.', { code: 'SOLANA_DISABLED', status: 503 });
  }
  const hash = String(paymentHash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new SolanaError('A 32-byte hex payment hash is required to anchor a proof.', {
      code: 'SOLANA_INVALID_HASH',
      status: 400
    });
  }

  const { treasury } = loadKeys();
  await ensureFunded(20_000);

  const memo = buildMemo({
    kind: 'l402-proof',
    paymentHash: hash,
    reference,
    score,
    extra: { offer: offerId, ...extra }
  });

  const result = await submit([memoInstruction(memo, treasury.publicKey)], [treasury], {
    timeoutMs: solana.anchorTimeoutMs
  });

  return {
    rail: 'solana-devnet',
    cluster: solana.cluster,
    signature: result.signature,
    slot: result.slot,
    status: result.status,
    pending: Boolean(result.pending),
    memo,
    paymentHash: hash,
    reference,
    treasury: treasury.publicKey.toBase58(),
    explorerUrl: result.explorerUrl,
    at: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ */
/* Verification                                                       */
/* ------------------------------------------------------------------ */

/** A base58 transaction signature, or null when the text is not exactly 64 bytes. */
function decodeSignature(value) {
  const text = String(value || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(text)) return null;
  try {
    const bytes = decodeBase58(text);
    return bytes.length === 64 ? bytes : null;
  } catch {
    return null;
  }
}

/** Reads a transaction and flattens the checks the caller cares about. */
async function readTransaction(signature) {
  const conn = getConnection();
  let tx;
  let status = null;
  try {
    tx = await conn.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    if (!tx) return null;

    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    status = value?.[0] || null;
  } catch (error) {
    // A devnet RPC can 429, time out or reject a signature it cannot decode. A
    // proof check must never take the process down, so the failure is reported
    // as a result the caller can show rather than an exception.
    throw new SolanaError(`Could not read the transaction from devnet: ${error?.message || error}`, {
      code: 'SOLANA_RPC_ERROR',
      status: 502,
      signature
    });
  }

  const memos = [];
  const transfers = [];

  const message = tx.transaction.message;
  // web3.js exposes compiled instructions and static account keys on both the
  // legacy Message and MessageV0 shapes, but the field names differ by version,
  // so every access is defensive.
  const instructions = message.compiledInstructions || message.instructions || [];
  const accountKeys = message.staticAccountKeys || message.accountKeys || [];

  for (const instruction of instructions) {
    const programId = accountKeys[instruction.programIdIndex]?.toBase58?.() || '';
    const data = Buffer.from(instruction.data || []);
    const keyIndexes = instruction.accountKeyIndexes || instruction.accounts || [];

    if (programId === solana.memoProgram) {
      memos.push(data.toString('utf8'));
    }

    // SystemProgram::Transfer — u32 discriminator 2, then u64 lamports.
    if (programId === SystemProgram.programId.toBase58() && data.length >= 12 && data.readUInt32LE(0) === 2) {
      const lamports = Number(data.readBigUInt64LE(4));
      transfers.push({
        kind: 'sol',
        from: accountKeys[keyIndexes[0]]?.toBase58?.() || '',
        to: accountKeys[keyIndexes[1]]?.toBase58?.() || '',
        units: lamports
      });
    }
  }

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    err: tx.meta?.err ?? null,
    fee: tx.meta?.fee ?? null,
    memo: memos.join(' '),
    memos,
    transfers,
    confirmationStatus: status?.confirmationStatus || (tx.meta ? 'confirmed' : null),
    confirmations: status?.confirmations ?? null,
    explorerUrl: explorerUrl(signature)
  };
}

/**
 * Pure evaluation of a decoded transaction.
 *
 * Separated from the RPC call so the checks can be tested against a known
 * transaction snapshot without spending devnet money, and so the same rules are
 * applied whether the transaction was just read or replayed from cache.
 *
 * @param {object} tx result of `readTransaction`
 * @param {{ paymentHash?: string, recipient?: string, units?: number | null }} expected
 */
function evaluateTransaction(tx, { paymentHash = '', recipient = '', units = null } = {}) {
  const checks = [];
  const add = (id, label, passed, detail) => checks.push({ id, label, passed, detail });

  add('exists', 'Transaction found on devnet', Boolean(tx), tx ? `slot ${tx.slot}` : 'getTransaction returned null');
  if (!tx) return { checks, valid: false, reason: 'Transaction not found on Solana Devnet.' };

  const confirmed = tx.confirmationStatus === 'confirmed' || tx.confirmationStatus === 'finalized';
  add('confirmed', 'Confirmed on devnet', confirmed, tx.confirmationStatus || 'unknown');
  add('succeeded', 'No on-chain error', tx.err === null, tx.err ? JSON.stringify(tx.err) : 'meta.err = null');

  const expectedHash = String(paymentHash || '').toLowerCase();
  const memoMap = parseMemo(tx.memo);
  const memoHash = String(memoMap?.hash || '').toLowerCase();

  if (expectedHash) {
    const bound = Boolean(memoHash) && memoHash === expectedHash;
    add(
      'memo',
      'Memo commits to the L402 hash',
      bound,
      bound
        ? `hash=${memoHash.slice(0, 16)}…`
        : memoHash
          ? `memo hash ${memoHash.slice(0, 16)}… does not match the invoice`
          : 'no ADPAL memo found'
    );
  } else {
    add(
      'memo',
      'Carries an ADPAL memo',
      Boolean(memoMap),
      memoMap ? `kind=${memoMap.kind || '?'}` : 'no ADPAL memo found'
    );
  }

  if (recipient) {
    const match = tx.transfers.find((transfer) => transfer.to === recipient);
    add('recipient', 'Paid the expected account', Boolean(match), match ? match.to : `no transfer to ${recipient}`);
  }

  if (Number.isFinite(Number(units)) && Number(units) > 0) {
    const expected = Number(units);
    const exact = tx.transfers.find(
      (transfer) => transfer.units === expected && (!recipient || transfer.to === recipient)
    );
    add(
      'amount',
      'Exact amount in base units',
      Boolean(exact),
      exact
        ? `${exact.units} base units`
        : `expected ${expected}, saw ${tx.transfers.map((t) => t.units).join(' / ') || 'none'}`
    );
  }

  const valid = checks.every((check) => check.passed);
  return {
    valid,
    checks,
    paymentHash: memoHash || null,
    memoFields: memoMap,
    reason: valid
      ? 'Transaction confirmed and the memo commits to this L402 hash.'
      : checks.filter((check) => !check.passed).map((check) => check.detail).join(' · ')
  };
}

/**
 * Verifies an on-chain L402 proof.
 *
 * The checks are returned individually rather than collapsed into a boolean,
 * because the terminal shows them and because "the transaction exists but the
 * memo is another offer's hash" is a materially different failure.
 *
 * @param {{ signature: string, paymentHash?: string, recipient?: string, units?: number }} input
 */
async function verifyProof({ signature, paymentHash = '', recipient = '', units = null } = {}) {
  const sig = String(signature || '').trim();

  // Length matters, not just the alphabet: a 64-character base58 string decodes
  // to ~47 bytes, which the RPC rejects with "WrongSize" — a malformed proof
  // must be a 402, never a 500.
  if (!decodeSignature(sig)) {
    return {
      valid: false,
      signature: sig,
      checks: [
        {
          id: 'format',
          label: 'Signature format',
          passed: false,
          detail: 'Expected a base58 string that decodes to 64 bytes.'
        }
      ],
      reason: 'The signature is not a valid base58 transaction signature.',
      explorerUrl: null
    };
  }

  const replay = consumedSignatures.get(sig);
  let tx;
  try {
    tx = await readTransaction(sig);
  } catch (error) {
    return {
      valid: false,
      signature: sig,
      checks: [
        { id: 'format', label: 'Signature format', passed: true, detail: '64 bytes, base58' },
        {
          id: 'reachable',
          label: 'Devnet RPC reachable',
          passed: false,
          detail: error?.message || 'RPC error'
        }
      ],
      reason: error?.message || 'The devnet RPC could not be reached.',
      explorerUrl: explorerUrl(sig)
    };
  }
  const evaluation = evaluateTransaction(tx, { paymentHash, recipient, units });

  const checks = [
    {
      id: 'replay',
      label: 'First use of this signature',
      passed: !replay,
      detail: replay ? `Already used by ${replay.contextToken || 'another settlement'}` : 'Not seen before'
    },
    ...evaluation.checks
  ];

  const valid = evaluation.valid && !replay;

  return {
    valid,
    signature: sig,
    slot: tx?.slot ?? null,
    blockTime: tx?.blockTime ?? null,
    confirmationStatus: tx?.confirmationStatus ?? null,
    memo: tx?.memo ?? '',
    memoFields: evaluation.memoFields || null,
    paymentHash: evaluation.paymentHash || null,
    transfers: tx?.transfers || [],
    fee: tx?.fee ?? null,
    checks,
    reason: replay ? `This signature already settled ${replay.contextToken}.` : evaluation.reason,
    explorerUrl: tx?.explorerUrl || explorerUrl(sig)
  };
}

/**
 * Binds a verified signature to a settlement context so the same on-chain proof
 * cannot settle two invoices. Called only after `verifyProof` succeeded.
 */
function consumeSignature(signature, { contextToken = '', paymentHash = '' } = {}) {
  consumedSignatures.set(String(signature), {
    contextToken,
    paymentHash,
    at: Date.now()
  });
  // The demo runs for hours; keep the replay set bounded.
  if (consumedSignatures.size > 500) {
    const oldest = [...consumedSignatures.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest.slice(0, consumedSignatures.size - 500)) consumedSignatures.delete(key);
  }
}

function isConsumed(signature) {
  return consumedSignatures.has(String(signature || ''));
}

function reset() {
  consumedSignatures.clear();
  lastAirdrop = null;
}

/* ------------------------------------------------------------------ */
/* Payout                                                             */
/* ------------------------------------------------------------------ */

async function mintDetails() {
  if (!solana.mint) return null;
  if (mintInfo) return mintInfo;
  const conn = getConnection();
  const mint = new PublicKey(solana.mint);
  const parsed = await getMint(conn, mint, 'confirmed');
  mintInfo = { address: mint.toBase58(), decimals: parsed.decimals, supply: parsed.supply.toString() };
  return mintInfo;
}

/**
 * Builds the payout instructions without touching the network.
 *
 * Kept separate from `sendSplit` so the exact legs, memo and fee payer can be
 * inspected (and asserted) without spending devnet SOL.
 */
async function buildSplitInstructions({
  readerUnits,
  publisherUnits,
  reference = '',
  paymentHash = '',
  anchorSignature = ''
}) {
  const reader = Math.round(Number(readerUnits) || 0);
  const publisher = Math.round(Number(publisherUnits) || 0);
  if (reader <= 0 && publisher <= 0) {
    throw new SolanaError('Nothing to transfer: both legs are zero.', {
      code: 'SOLANA_ZERO_AMOUNT',
      status: 400
    });
  }

  const { treasury, reader: readerAddress, publisher: publisherAddress } = loadKeys();
  const mint = await mintDetails();
  const instructions = [];

  const memo = buildMemo({
    kind: 'payout',
    paymentHash,
    reference,
    anchor: anchorSignature,
    extra: {
      reader,
      publisher
    }
  });

  if (mint) {
    const conn = getConnection();
    const mintKey = new PublicKey(mint.address);
    const source = await getOrCreateAssociatedTokenAccount(
      conn,
      treasury,
      mintKey,
      treasury.publicKey,
      false,
      'confirmed'
    );

    for (const [destinationOwner, amount] of [
      [readerAddress, reader],
      [publisherAddress, publisher]
    ]) {
      if (amount <= 0) continue;
      const destination = await getOrCreateAssociatedTokenAccount(
        conn,
        treasury,
        mintKey,
        destinationOwner,
        false,
        'confirmed'
      );
      instructions.push(
        createTransferCheckedInstruction(
          source.address,
          mintKey,
          destination.address,
          treasury.publicKey,
          BigInt(amount),
          mint.decimals
        )
      );
    }
  } else {
    for (const [destination, amount] of [
      [readerAddress, reader],
      [publisherAddress, publisher]
    ]) {
      if (amount <= 0) continue;
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: treasury.publicKey,
          toPubkey: destination,
          lamports: amount
        })
      );
    }
  }

  // The memo goes last: it is a note about the transfers above, and a memo-only
  // transaction would still be valid if a leg were dropped, which is not what a
  // payout should ever look like.
  instructions.push(memoInstruction(memo, treasury.publicKey));

  return {
    instructions,
    memo,
    mint,
    treasury,
    reader,
    publisher,
    readerAddress,
    publisherAddress,
    // Where the two legs actually go, in the order the instructions were added.
    legs: [
      { role: 'reader', address: readerAddress.toBase58(), units: reader },
      { role: 'publisher', address: publisherAddress.toBase58(), units: publisher }
    ].filter((leg) => leg.units > 0)
  };
}

/**
 * Moves the 70/30 split on-chain in a single transaction.
 *
 * One transaction means the two legs cannot diverge: either the reader and the
 * publisher are both paid, or neither is. The memo carries the payout reference
 * and the L402 hash, which is what makes a later `verifyProof` able to tie the
 * money back to the attention proof that authorised it.
 *
 * @param {{ readerUnits: number, publisherUnits: number, reference: string, paymentHash?: string }} input
 */
async function sendSplit({
  readerUnits,
  publisherUnits,
  reference = '',
  paymentHash = '',
  anchorSignature = ''
}) {
  if (!isEnabled()) {
    throw new SolanaError('The Solana rail is disabled.', { code: 'SOLANA_DISABLED', status: 503 });
  }

  const prepared = await buildSplitInstructions({
    readerUnits,
    publisherUnits,
    reference,
    paymentHash,
    anchorSignature
  });

  const { instructions, memo, mint, treasury, reader, publisher, readerAddress, publisherAddress } =
    prepared;

  const feeBudget = mint ? 80_000 : 15_000;
  const funding = await ensureFunded(reader + publisher + feeBudget);
  const result = await submit(instructions, [treasury], { timeoutMs: solana.timeoutMs });

  return {
    rail: 'solana-devnet',
    cluster: solana.cluster,
    signature: result.signature,
    slot: result.slot,
    status: result.status,
    pending: Boolean(result.pending),
    memo,
    currency: solana.currency,
    mint: mint?.address || null,
    decimals: mint?.decimals ?? solana.decimals,
    reader: { address: readerAddress.toBase58(), units: reader, explorerUrl: addressUrl(readerAddress) },
    publisher: { address: publisherAddress.toBase58(), units: publisher, explorerUrl: addressUrl(publisherAddress) },
    totalUnits: reader + publisher,
    treasury: treasury.publicKey.toBase58(),
    funded: { balance: funding.balance, airdropped: funding.airdropped || 0 },
    explorerUrl: result.explorerUrl,
    at: new Date().toISOString()
  };
}

/** Re-reads a payout transaction so a pending transfer can settle in the UI. */
async function getStatus(signature) {
  const text = String(signature || '').trim();
  if (!decodeSignature(text)) {
    throw new SolanaError('That is not a base58 transaction signature.', {
      code: 'SOLANA_INVALID_SIGNATURE',
      status: 400,
      signature: text
    });
  }
  const conn = getConnection();
  const { value } = await conn.getSignatureStatuses([text], { searchTransactionHistory: true });
  const status = value?.[0] || null;
  return {
    signature,
    slot: status?.slot ?? null,
    confirmationStatus: status?.confirmationStatus || 'unknown',
    confirmations: status?.confirmations ?? null,
    err: status?.err ?? null,
    explorerUrl: explorerUrl(signature)
  };
}

/** Balances of the three demo accounts, for the terminal card. */
async function balances() {
  if (!isEnabled()) return null;
  try {
    const { treasury, reader, publisher } = loadKeys();
    const conn = getConnection();
    const [treasuryLamports, readerLamports, publisherLamports] = await Promise.all([
      conn.getBalance(treasury.publicKey, 'confirmed'),
      conn.getBalance(reader, 'confirmed'),
      conn.getBalance(publisher, 'confirmed')
    ]);
    return {
      cluster: solana.cluster,
      currency: solana.currency,
      treasury: treasuryLamports,
      reader: readerLamports,
      publisher: publisherLamports,
      treasurySol: Math.round((treasuryLamports / 1e9) * 1e6) / 1e6
    };
  } catch (error) {
    return { error: error?.message || 'balance read failed' };
  }
}

module.exports = {
  SolanaError,
  isEnabled,
  publicProfile,
  toBaseUnits,
  fromBaseUnits,
  splitUnits,
  explorerUrl,
  addressUrl,
  buildMemo,
  parseMemo,
  evaluateTransaction,
  anchorProof,
  verifyProof,
  consumeSignature,
  isConsumed,
  readTransaction,
  decodeSignature,
  getConnection,
  isUnfundedError,
  buildSplitInstructions,
  sendSplit,
  getStatus,
  balances,
  ensureFunded,
  loadKeys,
  reset
};
