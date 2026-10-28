'use strict';

/**
 * The page agent must never hit the temporal dead zone.
 *
 * `createRuntime` in `demo-publisher/adpal-agent.js` is written with an early
 * `return runtime;` followed by a long block of function declarations. That
 * works because function declarations hoist — but a `let`/`const` placed below
 * the return is never evaluated, so the binding stays in the TDZ forever and
 * the first access throws:
 *
 *   ReferenceError: Cannot access 'impressionId' before initialization
 *
 * That is exactly how a duplicate-payout fix shipped a blocking crash: the
 * `let impressionId` needed by `runSession`'s `finally` was appended below the
 * return. This check catches the whole bug class two ways:
 *
 *   1. statically, by rejecting any `let`/`const`/`var` declared after an early
 *      top-level return in any factory function in the file;
 *   2. at runtime, by extracting the real `createRuntime`, running the real
 *      `runSession` through its `finally`, and asserting that control reached
 *      the end of that block (which is the statement that threw).
 *
 * Usage: node scripts/agent-scope-check.js
 *
 * Set AGENT_FILE to check a different copy of the agent (used to confirm the
 * check fails against the pre-fix revision in git history).
 */

const fs = require('fs');
const path = require('path');

const AGENT = process.env.AGENT_FILE
  ? path.resolve(process.env.AGENT_FILE)
  : path.join(__dirname, '..', 'demo-publisher', 'adpal-agent.js');

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` · ${detail}` : ''}`);
  }
}

// Normalise line endings: the extraction below matches on "\n" and this file is
// checked out with CRLF on Windows.
const source = fs.readFileSync(AGENT, 'utf8').replace(/\r\n/g, '\n');
const lines = source.split('\n');

/* ------------------------------------------------------------------ */
/* 1. Static: no declaration may live below an early top-level return  */
/* ------------------------------------------------------------------ */

console.log('Static scope check · declarations after an early return');

/**
 * Finds `function name(...)` openings at a given indent and returns the span of
 * each body, matching braces while ignoring strings, template literals and
 * comments well enough for this file.
 */
function findFunctions(text, indent) {
  const open = new RegExp(`^${' '.repeat(indent)}(?:async )?function (\\w+)\\s*\\(`, 'm');
  const found = [];
  const scan = text.split(/\r?\n/);
  for (let i = 0; i < scan.length; i += 1) {
    const match = open.exec(scan[i]);
    if (!match) continue;
    // Walk to the matching closing brace at the same indent.
    const close = new RegExp(`^${' '.repeat(indent)}\\}$`);
    for (let j = i + 1; j < scan.length; j += 1) {
      if (close.test(scan[j])) {
        found.push({ name: match[1], start: i, end: j });
        i = j;
        break;
      }
    }
  }
  return found;
}

const factories = findFunctions(source, 2);
check('the file declares factory functions at the top level', factories.length > 0, String(factories.length));

const offenders = [];
for (const fn of factories) {
  const body = lines.slice(fn.start + 1, fn.end);
  const indent = ' '.repeat(4);
  const firstReturn = body.findIndex((line) => line.startsWith(`${indent}return `));
  if (firstReturn === -1) continue;
  for (let i = firstReturn + 1; i < body.length; i += 1) {
    if (/^ {4}(?:let|const|var) /.test(body[i])) {
      offenders.push(`${fn.name}() line ${fn.start + i + 2}: ${body[i].trim()}`);
    }
  }
}

check(
  'no let/const/var is declared after an early return (the TDZ trap)',
  offenders.length === 0,
  offenders.join(' | ')
);

/* ------------------------------------------------------------------ */
/* 2. Runtime: the real createRuntime, driven through the finally      */
/* ------------------------------------------------------------------ */

console.log('\nRuntime check · runSession reaches the end of its finally');

/** Extract the `function createRuntime(...) { ... }` source verbatim. */
function extractCreateRuntime(text) {
  const startIndex = text.indexOf('\n  function createRuntime(');
  if (startIndex === -1) throw new Error('createRuntime not found');
  const from = startIndex + 1;
  const closeIndex = text.indexOf('\n  }\n', from);
  if (closeIndex === -1) throw new Error('createRuntime end not found');
  return text.slice(from, closeIndex + 4);
}

const runtimeSource = extractCreateRuntime(source);
check(
  'createRuntime extracted verbatim',
  runtimeSource.trimStart().startsWith('function createRuntime('),
  runtimeSource.trimStart().slice(0, 40)
);

/*
 * A minimal but honest sandbox. The stubs exist so the real function body can
 * run unmodified; nothing about the code under test is rewritten, which is the
 * point — a rewritten copy would not reproduce the bug.
 */
const CONFIG = {
  sessionMs: 6000,
  tickMs: 200,
  outOfViewAbortMs: 4000,
  pauseCooldownMs: 1500,
  rotateAfterMs: 20000,
  retryCooldownMs: 10000,
  offlineCooldownMs: 20000,
  viewportThreshold: 0.55,
  dwellBeforeStartMs: 900,
  minNewSignals: 4,
  maxPerSlot: 3,
  maxImpressionsPerPage: 9,
  virtualSlotHeight: 160,
  minSlotVisibleRatio: 0.5,
  minEngagementMs: 2500
};

let now = 0;
const performance = { now: () => now };

/*
 * The measurement window runs on a timer. Rather than wait 4 real seconds for
 * the out-of-view abort, this driver advances a fake clock and fires the
 * interval callback until the session settles. The code under test is unaware.
 */
const windowStub = {
  setInterval(fn) {
    const handle = { id: 1, fn };
    let guard = 0;
    while (guard < 200) {
      now += CONFIG.tickMs;
      fn();
      guard += 1;
      if (handle.cleared) break;
    }
    return handle;
  },
  clearInterval(handle) {
    if (handle) handle.cleared = true;
  },
  setTimeout: (fn) => fn(),
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { protocol: 'http:', host: 'localhost:3000' }
};

const documentStub = {
  visibilityState: 'visible',
  documentElement: { dataset: {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, setAttribute() {}, addEventListener() {}
  }),
  addEventListener: () => {},
  removeEventListener: () => {}
};

const viewportStub = {
  measure: () => {},
  ratio: () => 0,
  // Out of view: the session aborts and returns through the finally block.
  inView: () => false
};

const trackerStub = {
  inViewRatio: () => 0,
  visibleRatio: () => 0,
  focusRatio: () => 0,
  pageDwell: () => 10000,
  totals: () => ({ mouseMoves: 10, scrollEvents: 5, clicks: 1, scrollDepth: 0.5 }),
  beginSession: () => {},
  endSession: () => ({ durationMs: 1, mouseMoves: 1, scrollEvents: 0, clicks: 0, keyPresses: 0, directionChanges: 0 }),
  setSlotVisible: () => {}
};

const hostStub = {
  dataset: {},
  style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {},
  setAttribute() {},
  removeAttribute() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  attachShadow: () => documentStub.createElement(),
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 })
};

const factory = new Function(
  'CONFIG',
  'READY_PHASES',
  'clamp',
  'round3',
  'emitClientEvent',
  'createViewportWatcher',
  'createAttentionScore',
  'cash',
  'currencySymbol',
  'post',
  'sendPresence',
  'delay',
  'document',
  'window',
  'performance',
  'crypto',
  'fetch',
  `${runtimeSource}
  return createRuntime;`
);

const createRuntime = factory(
  CONFIG,
  new Set(['idle', 'delivered', 'rejected', 'invalid', 'paused', 'offline']),
  (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0)),
  (value) => Number((Number(value) || 0).toFixed(3)),
  () => {},
  () => viewportStub,
  () => ({ current: () => 0 }),
  (value) => `$${Number(value).toFixed(3)}`,
  () => '$',
  async () => ({ ok: false, status: 0, data: {}, error: 'stubbed' }),
  async () => ({ ok: false }),
  async () => {},
  documentStub,
  windowStub,
  performance,
  { randomUUID: () => 'imp-test-0001' },
  async () => { throw new Error('network disabled in this check'); }
);

const coordinator = { busy: false, delivered: 0, started: false };
const runtime = createRuntime({
  host: hostStub,
  index: 0,
  total: () => 1,
  layout: 'banner',
  tracker: trackerStub,
  coordinator,
  report: () => {}
});

check('the runtime exposes runSession', typeof runtime.runSession === 'function');

(async () => {
  let thrown = null;
  try {
    await runtime.runSession();
  } catch (error) {
    thrown = error;
  }

  check(
    'runSession did not throw a ReferenceError',
    !(thrown instanceof ReferenceError),
    thrown ? `${thrown.name}: ${thrown.message}` : ''
  );
  check('runSession completed without throwing at all', thrown === null, thrown ? `${thrown.name}: ${thrown.message}` : '');

  /*
   * The decisive assertion. `coordinator.busy = false` is the statement AFTER
   * `impressionId = ''` in the finally, so a reset proves control ran past the
   * declaration that used to be in the TDZ. Before the fix this stayed `true`
   * and the rejection surfaced as "Uncaught (in promise)".
   */
  check('the finally block ran to completion (busy released)', coordinator.busy === false, String(coordinator.busy));

  /* A second session must be possible: the id was cleared, so no wedge. */
  coordinator.busy = false;
  let secondThrown = null;
  try {
    await runtime.runSession();
  } catch (error) {
    secondThrown = error;
  }
  check('a second session also completes', secondThrown === null, secondThrown ? `${secondThrown.name}: ${secondThrown.message}` : '');
  check('busy is released again', coordinator.busy === false, String(coordinator.busy));

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all page-agent scope checks passed');
})();
