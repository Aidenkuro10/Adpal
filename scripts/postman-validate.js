#!/usr/bin/env node
// AdPal Postman suite validator.
//
// Newman is not installed in this repo, so this script does the next best thing:
// it is a small collection runner. It parses `adpal.postman_collection.json`,
// resolves the same variables Postman would, sends every request in order, and
// executes each request's `test` script against a `pm` shim (response, variables,
// and a chai-compatible `expect`).
//
// That means the assertions being checked are the assertions stored in the
// collection file — not a second copy maintained here. If the collection lies,
// this fails.
//
// Usage:
//   node scripts/postman-validate.js                      # lint + run
//   node scripts/postman-validate.js --lint-only          # no network calls
//   node scripts/postman-validate.js --verbose            # print every test
//   node scripts/postman-validate.js --base-url http://localhost:3000
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const COLLECTION_PATH = path.join(ROOT, 'adpal.postman_collection.json');
const ENVIRONMENT_PATH = path.join(ROOT, 'adpal.postman_environment.json');

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const argValue = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

const VERBOSE = hasFlag('--verbose');
const LINT_ONLY = hasFlag('--lint-only');

/* ------------------------------------------------------------------ */
/* Assertion helpers — a deliberately small chai subset               */
/* ------------------------------------------------------------------ */

const CHAIN_WORDS = new Set([
  'to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have',
  'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also', 'deep'
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;

  const ta = typeOf(a);
  if (ta !== typeOf(b)) return false;

  if (ta === 'array') {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (ta === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }

  return false;
}

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function shorten(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 100 ? `${value.slice(0, 97)}…` : value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * Builds a chainable expectation over `actual`.
 *
 * Unknown assertion names throw, so a typo in a collection script fails the run
 * instead of silently passing as a no-op.
 */
function expect(actual, negated = false) {
  const check = (condition, description) => {
    const ok = negated ? !condition : condition;
    if (ok) return;
    const error = new Error(`expected ${shorten(actual)} ${negated ? 'not ' : ''}${description}`);
    error.isAssertion = true;
    throw error;
  };

  const methods = {
    equal: (expected) => check(actual === expected, `to equal ${shorten(expected)}`),
    equals: (expected) => methods.equal(expected),
    eql: (expected) => check(deepEqual(actual, expected), `to eql ${shorten(expected)}`),
    a: (type) => check(typeOf(actual) === type, `to be a ${type} (got ${typeOf(actual)})`),
    an: (type) => methods.a(type),
    include: (expected) => {
      let matched = false;
      if (typeof actual === 'string') matched = actual.includes(String(expected));
      else if (Array.isArray(actual)) matched = actual.some((item) => deepEqual(item, expected));
      else if (actual && typeof actual === 'object') {
        matched = Object.keys(expected).every(
          (key) => Object.prototype.hasOwnProperty.call(actual, key) && deepEqual(actual[key], expected[key])
        );
      }
      check(matched, `to include ${shorten(expected)}`);
    },
    match: (pattern) => {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
      check(regex.test(String(actual)), `to match ${regex}`);
    },
    property: function (key, expected) {
      const holder = actual === null || actual === undefined ? null : Object(actual);
      const present = holder !== null && (Object.prototype.hasOwnProperty.call(holder, key) || key in holder);
      check(present, `to have property ${shorten(key)}`);
      if (arguments.length > 1 && expected !== undefined) {
        check(deepEqual(actual[key], expected), `to have property ${shorten(key)} = ${shorten(expected)}`);
      }
    },
    closeTo: (expected, delta = 0.01) => {
      const gap = Math.abs(Number(actual) - Number(expected));
      check(Number.isFinite(gap) && gap <= delta, `to be within ${delta} of ${shorten(expected)} (gap ${gap})`);
    },
    above: (n) => check(Number(actual) > Number(n), `to be above ${shorten(n)}`),
    least: (n) => check(Number(actual) >= Number(n), `to be at least ${shorten(n)}`),
    below: (n) => check(Number(actual) < Number(n), `to be below ${shorten(n)}`),
    most: (n) => check(Number(actual) <= Number(n), `to be at most ${shorten(n)}`),
    oneOf: function (...options) {
      const list = Array.isArray(options[0]) && options.length === 1 ? options[0] : options;
      check(list.some((option) => deepEqual(actual, option)), `to be one of ${shorten(list)}`);
    },
    lengthOf: (n) => {
      const length = actual === null || actual === undefined ? undefined : actual.length;
      check(length === n, `to have length ${shorten(n)} (got ${shorten(length)})`);
    }
  };

  const getters = {
    true: () => check(actual === true, 'to be true'),
    false: () => check(actual === false, 'to be false'),
    null: () => check(actual === null, 'to be null'),
    undefined: () => check(actual === undefined, 'to be undefined'),
    ok: () => check(Boolean(actual), 'to be truthy'),
    empty: () => check(isEmpty(actual), 'to be empty'),
    exist: () => check(actual !== null && actual !== undefined, 'to exist')
  };

  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'then') return undefined; // never treat as a thenable
        if (prop === 'not') return expect(actual, !negated);
        if (CHAIN_WORDS.has(prop)) return proxy;
        if (prop in getters) {
          getters[prop]();
          return proxy;
        }
        if (prop in methods) return methods[prop];
        throw new Error(`unsupported assertion ".${prop}" — extend the shim in scripts/postman-validate.js`);
      }
    }
  );

  return proxy;
}

/* ------------------------------------------------------------------ */
/* Collection loading and lint                                        */
/* ------------------------------------------------------------------ */

function fail(message) {
  console.error(`\n  ${message}`);
  process.exit(1);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) fail(`${label} not found at ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    // A trailing comma or an unescaped quote in an embedded test script is the
    // usual cause, so name the position rather than just "invalid JSON".
    fail(`${label} is not valid JSON · ${error.message}`);
  }
}

function collectRequests(items, trail = []) {
  const requests = [];
  for (const item of items || []) {
    if (Array.isArray(item.item)) {
      requests.push(...collectRequests(item.item, [...trail, item.name]));
    } else if (item.request) {
      requests.push({ item, folder: trail.join(' / ') });
    }
  }
  return requests;
}

function scriptLines(item, listen) {
  const event = (item.event || []).find((entry) => entry.listen === listen);
  if (!event || !event.script) return [];
  const exec = event.script.exec;
  if (Array.isArray(exec)) return exec;
  return typeof exec === 'string' ? exec.split('\n') : [];
}

function bodyText(request) {
  if (!request.body) return '';
  if (request.body.mode === 'raw') return request.body.raw || '';
  if (request.body.mode === 'urlencoded') {
    return (request.body.urlencoded || []).map((pair) => `${pair.key}=${pair.value}`).join('&');
  }
  return '';
}

function headerPairs(request) {
  return (request.header || []).map((header) => ({ key: header.key, value: header.value }));
}

const VARIABLE_RE = /\{\{\s*([^}\s]+)\s*\}\}/g;

function referencedVariables(request) {
  const texts = [request.url?.raw || '', bodyText(request), ...headerPairs(request).map((h) => h.value)];
  const names = new Set();
  for (const text of texts) {
    for (const match of String(text).matchAll(VARIABLE_RE)) names.add(match[1]);
  }
  return [...names];
}

function declaredCaptureNames(requests) {
  const names = new Set();
  const re = /pm\.(?:variables|collectionVariables|environment|globals)\.set\(\s*['"]([^'"]+)['"]/g;
  for (const { item } of requests) {
    const text = scriptLines(item, 'test').join('\n') + '\n' + scriptLines(item, 'prerequest').join('\n');
    for (const match of text.matchAll(re)) names.add(match[1]);
  }
  return names;
}

function lint(collection, environment, requests) {
  const problems = [];

  const schema = collection.info?.schema || '';
  if (!schema.includes('v2.1.0')) problems.push(`info.schema should target collection/v2.1.0 (found "${schema || 'missing'}")`);
  if (!collection.info?.name) problems.push('info.name is missing');
  if (!Array.isArray(collection.item) || collection.item.length === 0) problems.push('collection has no items');

  const known = new Set([
    ...(collection.variable || []).map((variable) => variable.key),
    ...(environment.values || []).filter((value) => value.enabled !== false).map((value) => value.key),
    ...declaredCaptureNames(requests)
  ]);

  const seen = new Map();
  for (const { item, folder } of requests) {
    const label = `${folder} / ${item.name}`;
    const request = item.request;

    if (!item.name) problems.push('an item is missing a name');
    if (seen.has(label)) problems.push(`duplicate request name: ${label}`);
    seen.set(label, true);

    if (!request.method) problems.push(`${label} · missing method`);
    if (!request.url?.raw) problems.push(`${label} · missing url.raw`);
    if (scriptLines(item, 'test').length === 0) problems.push(`${label} · has no test script`);

    // Unknown variables are the single most common cause of a collection that
    // "passes" by sending an empty token, so they are a hard error.
    for (const name of referencedVariables(request)) {
      if (!known.has(name)) problems.push(`${label} · references undefined variable {{${name}}}`);
    }
  }

  const duplicateKeys = (environment.values || []).map((value) => value.key);
  const dupes = duplicateKeys.filter((key, index) => duplicateKeys.indexOf(key) !== index);
  if (dupes.length) problems.push(`environment has duplicate keys: ${[...new Set(dupes)].join(', ')}`);

  if (!LINT_ONLY) {
    const enabled = (environment.values || []).filter((value) => value.enabled !== false);
    const baseUrl = enabled.find((value) => value.key === 'baseUrl')?.value || '';
    if (!/^https?:\/\//.test(baseUrl)) problems.push(`environment baseUrl is not a URL: "${baseUrl}"`);
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* Runtime                                                            */
/* ------------------------------------------------------------------ */

function createScopes(collection, environment) {
  const collectionScope = new Map();
  for (const variable of collection.variable || []) collectionScope.set(variable.key, String(variable.value ?? ''));

  const environmentScope = new Map();
  for (const value of environment.values || []) {
    if (value.enabled === false) continue;
    environmentScope.set(value.key, String(value.value ?? ''));
  }

  const localScope = new Map();
  const globalScope = new Map();

  const override = argValue('--base-url');
  if (override) environmentScope.set('baseUrl', override);

  // Postman precedence: local > environment > collection.
  const lookup = (key) => {
    if (localScope.has(key)) return localScope.get(key);
    if (environmentScope.has(key)) return environmentScope.get(key);
    if (collectionScope.has(key)) return collectionScope.get(key);
    if (globalScope.has(key)) return globalScope.get(key);
    return undefined;
  };

  const resolve = (text) =>
    String(text ?? '').replace(VARIABLE_RE, (whole, name) => {
      const value = lookup(name);
      if (value === undefined) throw new Error(`unresolved variable {{${name}}}`);
      return value;
    });

  const store = (map) => ({
    get: (key) => lookup(key),
    set: (key, value) => map.set(key, value === null || value === undefined ? '' : String(value)),
    has: (key) => lookup(key) !== undefined,
    unset: (key) => map.delete(key),
    toObject: () => Object.fromEntries(map),
    replaceIn: (text) => resolve(text)
  });

  return {
    lookup,
    resolve,
    scopes: {
      local: store(localScope),
      environment: store(environmentScope),
      collection: store(collectionScope),
      global: store(globalScope)
    }
  };
}

function buildPm({ response, scopes, requestInfo, results }) {
  const test = (name, assertion) => {
    try {
      assertion();
      results.push({ name, status: 'passed' });
    } catch (error) {
      results.push({ name, status: 'failed', error: error?.message || String(error) });
    }
  };
  test.skip = (name) => {
    results.push({ name, status: 'skipped' });
  };

  const statusAssertion = (expected) => {
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!allowed.includes(response.code)) {
      throw new Error(`expected status ${allowed.join(' or ')}, got ${response.code}`);
    }
  };

  return {
    test,
    expect,
    response: {
      code: response.code,
      status: response.statusText,
      responseTime: response.ms,
      responseSize: response.size,
      headers: {
        get: (name) => response.headers.get(name) ?? undefined,
        has: (name) => response.headers.has(name),
        all: () => [...response.headers.entries()].map(([key, value]) => ({ key, value }))
      },
      text: () => response.text,
      json: () => {
        try {
          return JSON.parse(response.text);
        } catch {
          throw new Error(`response is not JSON (content-type ${response.headers.get('content-type') || 'none'})`);
        }
      },
      to: { have: { status: statusAssertion } }
    },
    request: {
      method: requestInfo.method,
      url: { toString: () => requestInfo.url, raw: requestInfo.url },
      headers: {
        get: (name) =>
          requestInfo.headers.find((header) => String(header.key).toLowerCase() === String(name).toLowerCase())?.value,
        add: (header) => requestInfo.headers.push(header),
        all: () => requestInfo.headers.map((header) => ({ ...header }))
      },
      body: { mode: requestInfo.bodyMode, raw: requestInfo.bodyRaw }
    },
    variables: scopes.local,
    collectionVariables: scopes.collection,
    environment: scopes.environment,
    globals: scopes.global
  };
}

async function send(request, scopes) {
  const url = scopes.resolve(request.url?.raw || '');
  const method = String(request.method || 'GET').toUpperCase();
  const headers = {};
  for (const header of headerPairs(request)) {
    headers[scopes.resolve(header.key)] = scopes.resolve(header.value);
  }

  const rawBody = bodyText(request);
  const body = rawBody ? scopes.resolve(rawBody) : undefined;
  if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: controller.signal
    });

    const text = await response.text();
    return {
      code: response.status,
      statusText: response.statusText,
      headers: response.headers,
      text,
      size: Buffer.byteLength(text),
      ms: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runScript(lines, pm, label) {
  if (lines.length === 0) return;
  const sandbox = vm.createContext({
    pm,
    console: { log: (...args) => VERBOSE && console.log('    ', ...args), error: (...args) => console.error('    ', ...args) },
    Buffer,
    setTimeout,
    clearTimeout
  });

  try {
    vm.runInContext(lines.join('\n'), sandbox, { filename: label, timeout: 10000 });
  } catch (error) {
    // A thrown error outside pm.test still fails the request: that is the same
    // contract Newman applies. The name stays stable so the detail is readable.
    pm.test('script executed without throwing', () => {
      throw error;
    });
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

(async () => {
  const collection = readJson(COLLECTION_PATH, 'collection');
  const environment = readJson(ENVIRONMENT_PATH, 'environment');
  const requests = collectRequests(collection.item);

  console.log(`\nAdPal Postman suite · ${collection.info?.name || '(unnamed)'}`);
  console.log(`collection  ${path.relative(ROOT, COLLECTION_PATH)}`);
  console.log(`environment ${path.relative(ROOT, ENVIRONMENT_PATH)} · ${environment.name || '(unnamed)'}`);
  console.log(`requests    ${requests.length}`);

  const problems = lint(collection, environment, requests);
  if (problems.length) {
    console.log(`\n  lint found ${problems.length} problem(s):`);
    for (const problem of problems) console.log(`   ! ${problem}`);
    process.exit(1);
  }
  console.log('  lint ok · schema, variables, test scripts');

  if (LINT_ONLY) {
    console.log('\nlint-only mode · no requests sent');
    return;
  }

  const scopes = createScopes(collection, environment);
  const baseUrl = scopes.lookup('baseUrl');
  console.log(`target      ${baseUrl}\n`);

  // Fail fast with a useful message rather than 15 identical fetch errors.
  try {
    await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    fail(`cannot reach ${baseUrl} · ${error?.message || error}\n  Start the server first:  cd server && npm start`);
  }

  const summary = { passed: 0, failed: 0, skipped: 0 };
  const failures = [];
  let currentFolder = null;

  for (const { item, folder } of requests) {
    if (folder !== currentFolder) {
      currentFolder = folder;
      console.log(`${folder}`);
    }

    const label = `${folder} / ${item.name}`;
    const results = [];

    try {
      const response = await send(item.request, scopes);
      const pm = buildPm({
        response,
        // buildPm wants the four variable scopes, not the resolver wrapper.
        scopes: scopes.scopes,
        requestInfo: {
          method: item.request.method,
          url: scopes.resolve(item.request.url?.raw || ''),
          headers: item.request.header || [],
          bodyMode: item.request.body?.mode,
          bodyRaw: item.request.body?.raw
        },
        results
      });

      await runScript(scriptLines(item, 'prerequest'), pm, `${item.name}.prerequest.js`);
      await runScript(scriptLines(item, 'test'), pm, `${item.name}.test.js`);

      const failed = results.filter((result) => result.status === 'failed');
      const skipped = results.filter((result) => result.status === 'skipped');
      summary.passed += results.filter((result) => result.status === 'passed').length;
      summary.failed += failed.length;
      summary.skipped += skipped.length;

      const status = failed.length ? 'FAIL' : 'ok  ';
      const detail = failed.length
        ? `${failed.length}/${results.length} failed`
        : `${results.length - skipped.length}/${results.length} passed${skipped.length ? `, ${skipped.length} skipped` : ''}`;
      console.log(`  ${status} ${item.name} · ${response.code} (${response.ms}ms) · ${detail}`);

      if (VERBOSE) {
        for (const result of results) {
          const mark = result.status === 'passed' ? '·' : result.status === 'skipped' ? '−' : 'x';
          console.log(`       ${mark} ${result.name}${result.error ? ` — ${result.error}` : ''}`);
        }
      }

      if (failed.length && !VERBOSE) {
        for (const result of failed) {
          console.log(`       x ${result.name} — ${result.error}`);
        }
      }
      if (failed.length) {
        for (const result of failed) {
          failures.push(`${label} · ${result.name} — ${result.error}`);
        }
      }
    } catch (error) {
      summary.failed += 1;
      const reason = error?.name === 'AbortError' ? 'timed out after 30s' : error?.message || String(error);
      console.log(`  FAIL ${item.name} · ${reason}`);
      failures.push(`${label} · ${reason}`);
    }
  }

  const total = summary.passed + summary.failed;
  console.log(
    `\n${summary.passed}/${total} assertions passed` +
      (summary.skipped ? ` · ${summary.skipped} skipped` : '') +
      ` · ${requests.length} requests`
  );

  if (failures.length) {
    console.log('\nfailures:');
    for (const failure of failures) console.log(`  ! ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('collection passed against the running server');
  }
})().catch((error) => {
  console.error('\nvalidator crashed ·', error?.stack || error);
  process.exitCode = 1;
});
