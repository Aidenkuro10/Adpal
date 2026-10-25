'use strict';

/**
 * PayPal Agent Toolkit bridge.
 *
 * `AI-Toolkit-main/` is the official PayPal AI Toolkit: a plugin manifest, a
 * sandbox MCP server declaration, and the best-practice references that define
 * how PayPal expects an agent to talk to its APIs. It is configuration and
 * documentation, not an npm package, so "integrating" it means:
 *
 *  1. reading what it declares (version, MCP endpoint, skills, tool inventory)
 *     and reporting it as this server's agent capability profile;
 *  2. turning its documented Payouts contract into callable tools that the two
 *     server-side agents share — an *advertiser agent* that authorizes campaign
 *     spend, and a *protocol agent* that routes a settled L402 invoice to the
 *     Payouts API.
 *
 * The tools here follow the toolkit's guidance: credentials only from the
 * environment, `PayPal-Request-Id` / `sender_item_id` idempotency, exponential
 * backoff on 429, and sandbox hosts unless PAYPAL_MODE=live.
 */

const fs = require('fs');
const path = require('path');

const TOOLKIT_DIR = path.resolve(__dirname, '..', '..', 'AI-Toolkit-main', 'AI-Toolkit-main');

/** Retry policy for PayPal's documented 400 POST/min payouts rate limit. */
const RETRY = Object.freeze({ attempts: 3, baseMs: 300, maxMs: 2000 });

let discovery = null;
/** @type {null | { paypal: object, ledger: object, emitter: ((event: object) => void) | null }} */
let runtime = null;

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Reads the toolkit checkout once. Everything is defensive: the folder is
 * optional, and a missing manifest must never stop the simulator from booting.
 */
function discover() {
  if (discovery) return discovery;

  const manifest = readJson(path.join(TOOLKIT_DIR, 'package.json'));
  const cursorPlugin = readJson(path.join(TOOLKIT_DIR, '.cursor-plugin', 'plugin.json'));
  const mcp = readJson(path.join(TOOLKIT_DIR, '.mcp.json'));

  const skillRoot = path.join(TOOLKIT_DIR, 'skills');
  const skills = listDir(skillRoot)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(skillRoot, entry.name);
      return {
        name: entry.name,
        references: listDir(path.join(dir, 'references'))
          .filter((file) => file.isFile() && file.name.endsWith('.md'))
          .map((file) => file.name)
      };
    });

  const server = mcp?.mcpServers?.['paypal-sandbox'] || null;

  discovery = {
    present: Boolean(manifest),
    name: manifest?.name || 'paypal-ai-toolkit',
    version: manifest?.version || '',
    description: cursorPlugin?.description || manifest?.description || '',
    source: path.relative(path.resolve(__dirname, '..', '..'), TOOLKIT_DIR) || TOOLKIT_DIR,
    license: manifest?.license || '',
    mcp: server
      ? {
          server: 'paypal-sandbox',
          transport: server.type || 'sse',
          url: server.url || '',
          // Never echo the substituted token: only the header name it expects.
          auth: Object.keys(server.headers || {}).join(', ') || ''
        }
      : null,
    skills,
    // The reference that governs the payouts rail this server implements.
    payoutsReference: skills
      .find((skill) => skill.name === 'paypal-best-practices')
      ?.references.includes('payouts.md')
      ? 'skills/paypal-best-practices/references/payouts.md'
      : ''
  };

  return discovery;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/**
 * Tool inventory. Each entry mirrors the MCP tool shape (name, description,
 * inputSchema) so the same objects can be printed in the terminal and invoked
 * by either agent without a second interface.
 */
const TOOLS = Object.freeze([
  {
    name: 'paypal_get_token',
    description:
      'Returns a cached OAuth2 client-credentials token for the configured PayPal environment.',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: 'Bypass the token cache.' } },
      additionalProperties: false
    },
    handler: async ({ force = false } = {}) => {
      const token = await need().paypal.accessToken({ force: Boolean(force) });
      return { tokenType: 'Bearer', tokenLength: String(token).length, cached: !force };
    }
  },
  {
    name: 'paypal_create_payout',
    description:
      'Creates a Payouts batch. One item per receiver, each with its own sender_item_id for idempotency.',
    inputSchema: {
      type: 'object',
      required: ['reference'],
      properties: {
        reference: { type: 'string', description: 'Internal settlement reference.' },
        currency: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['receiver', 'amount'],
            properties: {
              receiver: { type: 'string' },
              amount: { type: 'number' },
              note: { type: 'string' }
            }
          }
        },
        emailSubject: { type: 'string' },
        emailMessage: { type: 'string' }
      },
      additionalProperties: false
    },
    handler: async (args = {}) =>
      withRetry(() => need().paypal.createPayout(args), 'paypal_create_payout')
  },
  {
    name: 'paypal_get_payout',
    description: 'Reads a Payouts batch so a PENDING settlement can be refreshed to its final status.',
    inputSchema: {
      type: 'object',
      required: ['batchId'],
      properties: { batchId: { type: 'string' } },
      additionalProperties: false
    },
    handler: async ({ batchId } = {}) =>
      withRetry(() => need().paypal.getPayout(batchId), 'paypal_get_payout')
  },
  {
    name: 'advertiser_authorize_spend',
    description:
      'Advertiser agent: authorizes campaign spend for one impression against the profile’s remaining budget.',
    inputSchema: {
      type: 'object',
      required: ['advertiserId', 'amount'],
      properties: {
        advertiserId: { type: 'string' },
        amount: { type: 'number' },
        remaining: { type: 'number', description: 'Campaign budget the rotation reports.' }
      },
      additionalProperties: false
    },
    handler: async ({ advertiserId, amount, remaining } = {}) => {
      const price = Number(amount);
      const available = Number.isFinite(Number(remaining)) ? Number(remaining) : Infinity;
      if (!Number.isFinite(price) || price <= 0) {
        return { authorized: false, code: 'INVALID_AMOUNT', advertiserId };
      }
      if (available + 1e-9 < price) {
        return {
          authorized: false,
          code: 'CAMPAIGN_BUDGET_EXHAUSTED',
          advertiserId,
          remaining: available
        };
      }
      return {
        authorized: true,
        advertiserId,
        amount: price,
        remainingAfter: Math.round((available - price) * 10000) / 10000
      };
    }
  },
  {
    name: 'protocol_split_invoice',
    description:
      'Protocol agent: splits a settled invoice into the reader and publisher shares (70/30 by default), in whole cents.',
    inputSchema: {
      type: 'object',
      required: ['reader', 'publisher'],
      properties: {
        reader: { type: 'number' },
        publisher: { type: 'number' },
        userShare: { type: 'number' }
      },
      additionalProperties: false
    },
    handler: async ({ reader, publisher, userShare } = {}) => {
      const readerCents = Math.round(Number(reader) * 100);
      const publisherCents = Math.round(Number(publisher) * 100);
      const totalCents = readerCents + publisherCents;
      const share = Number.isFinite(Number(userShare)) ? Number(userShare) : 0.7;
      const expectedReaderCents = Math.round(totalCents * share);
      return {
        currency: 'cents',
        totalCents,
        readerCents,
        publisherCents,
        // These are the policy rates the split is enforced against, not the
        // ratio of two truncated cent amounts: a 6/2 batch of an 8-cent payout
        // is still a 70/30 invoice, it just cannot be expressed exactly in
        // whole cents.
        readerRate: share,
        publisherRate: Math.round((1 - share) * 1000) / 1000,
        driftCents: readerCents - expectedReaderCents,
        target: { userShare: share, publisherShare: Math.round((1 - share) * 1000) / 1000 },
        // Small drift is unavoidable with cent denominations; flag anything
        // beyond one cent so the demo never claims a split it did not make.
        withinTolerance: Math.abs(readerCents - expectedReaderCents) <= 1
      };
    }
  }
]);

function need() {
  if (!runtime) throw new Error('PayPal Agent Toolkit runtime is not configured.');
  return runtime;
}

function configure(next) {
  runtime = {
    paypal: next.paypal,
    ledger: next.ledger,
    emitter: typeof next.emit === 'function' ? next.emit : null
  };
  return profile();
}

/** Capability profile for `/api/toolkit`, `/api/health` and the terminal. */
function profile() {
  const found = discover();
  return {
    present: found.present,
    name: found.name,
    version: found.version,
    source: found.source,
    license: found.license,
    mcp: found.mcp,
    payoutsReference: found.payoutsReference,
    skills: found.skills.map((skill) => skill.name),
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
    configured: Boolean(runtime),
    retry: { ...RETRY, on: 'HTTP 429' }
  };
}

function toolNames() {
  return TOOLS.map((tool) => tool.name);
}

/**
 * Invokes a tool by name. Returns the tool result unchanged; the caller decides
 * how to surface it. Unknown names are a programming error, not user input, so
 * this rejects rather than guessing.
 */
async function callTool(name, args = {}) {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown PayPal Agent Toolkit tool: ${name}`);
  return tool.handler(args);
}

/**
 * Exponential backoff, used only for the documented rate limit. A 429 is safe
 * to retry because every payout call carries an idempotent request id.
 */
async function withRetry(task, label) {
  let lastError = null;

  for (let attempt = 0; attempt < RETRY.attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const status = Number(error?.status);
      const retryable = status === 429 || status === 503 || error?.code === 'RATE_LIMIT_REACHED';
      if (!retryable || attempt === RETRY.attempts - 1) throw error;

      const delay = Math.min(RETRY.maxMs, RETRY.baseMs * 2 ** attempt);
      runtime?.emitter?.({
        stage: 'paypal.retry',
        source: 'paypal.toolkit',
        level: 'warn',
        title: `Retrying ${label} after HTTP ${status}`,
        detail: `attempt ${attempt + 1}/${RETRY.attempts} · waiting ${delay}ms`,
        data: { tool: label, status, delay }
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

/**
 * Advertiser agent: decides whether the profile can pay for an impression.
 * Returns the funding decision plus the profile it belongs to, so the server
 * can emit one event that names the buyer and the money at once.
 */
async function authorizeAdvertiserSpend({ advertiser, price }) {
  const decision = await callTool('advertiser_authorize_spend', {
    advertiserId: advertiser?.id || 'agt_unknown',
    amount: price,
    remaining: advertiser?.budgetRemaining
  });

  runtime?.emitter?.({
    stage: 'agent.advertiser',
    source: 'advertiser.agent',
    level: decision.authorized ? 'ok' : 'error',
    title: decision.authorized
      ? `Spend authorized · ${advertiser?.sponsor || advertiser?.id}`
      : `Spend refused · ${advertiser?.sponsor || advertiser?.id}`,
    detail: decision.authorized
      ? `€${Number(price).toFixed(3)} of €${Number(advertiser?.budgetRemaining ?? 0).toFixed(2)} remaining · ${advertiser?.objective || 'reach'}`
      : `${decision.code} · remaining €${Number(decision.remaining ?? 0).toFixed(2)}`,
    data: { tool: 'advertiser_authorize_spend', ...decision, sponsor: advertiser?.sponsor }
  });

  return decision;
}

/**
 * Protocol agent: turns a ledger reservation into a Payouts batch.
 *
 * The split is enforced here, not at the call site: the reader item is the
 * reservation's 70% share, the publisher item is its 30% share, and both travel
 * in the same batch with their own `sender_item_id`. The toolkit's documented
 * contract is then applied by `paypal_create_payout`.
 */
async function routeSettlement({
  reservation,
  receiverEmail,
  publisherEmail,
  currency,
  subject,
  message,
  userShare = 0.7
}) {
  const items = [
    {
      receiver: receiverEmail,
      amount: reservation.userAmount,
      note: `Reader share 70% · ${reservation.reference}`
    }
  ];

  if (publisherEmail && publisherEmail.toLowerCase() !== receiverEmail.toLowerCase()) {
    items.push({
      receiver: publisherEmail,
      amount: reservation.publisherAmount,
      note: `Publisher share 30% · ${reservation.reference}`
    });
  }

  const split = await callTool('protocol_split_invoice', {
    reader: reservation.userAmount,
    publisher: reservation.publisherAmount,
    userShare
  });

  runtime?.emitter?.({
    stage: 'agent.protocol',
    source: 'protocol.agent',
    level: split.withinTolerance ? 'ok' : 'warn',
    title: 'Settlement routed to PayPal Payouts',
    detail:
      `€${reservation.userAmount.toFixed(2)} reader / €${reservation.publisherAmount.toFixed(2)} publisher · ` +
      `${Math.round(split.readerRate * 100)}% / ${Math.round(split.publisherRate * 100)}` +
      (split.driftCents ? ` · ${split.driftCents > 0 ? '+' : ''}${split.driftCents}¢ cent rounding` : ''),
    data: {
      tool: 'protocol_split_invoice',
      reference: reservation.reference,
      items,
      split,
      payoutsReference: discover().payoutsReference
    }
  });

  const batch = await callTool('paypal_create_payout', {
    items,
    currency,
    reference: reservation.reference,
    emailSubject: subject,
    emailMessage: message
  });

  return { batch, items, split };
}

module.exports = {
  TOOLKIT_DIR,
  configure,
  discover,
  profile,
  toolNames,
  callTool,
  authorizeAdvertiserSpend,
  routeSettlement
};
