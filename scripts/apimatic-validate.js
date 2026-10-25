#!/usr/bin/env node
// AdPal APIMatic validator.
//
// Three sources of truth are compared, and any disagreement is drift:
//
//   1. adpal.openapi.json            — the spec APIMatic would import
//   2. adpal.postman_collection.json — the suite that already passes
//   3. server/server.js              — the routes the process actually serves
//
// plus a fourth, stronger source: the *live* responses, validated field by field
// against the spec's schemas. A schema can be internally consistent and still be
// a fiction; only the live pass catches that.
//
// Checks, in order:
//   structure  OpenAPI 3.0 shape and APIMatic import constraints
//   refs       every $ref resolves; no ignored $ref siblings
//   coverage   Postman ↔ spec ↔ server, in both directions
//   codes      status codes asserted by the suite are documented by the spec
//   security   bearer usage in the suite matches declared security schemes
//   live       response bodies and status codes conform to the spec
//
// Usage:
//   node scripts/apimatic-validate.js              # full run
//   node scripts/apimatic-validate.js --lint-only  # no network
//   node scripts/apimatic-validate.js --no-live    # coverage + codes, no probes
//   node scripts/apimatic-validate.js --verbose    # print passing checks too
//   node scripts/apimatic-validate.js --base-url http://localhost:3000
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SPEC_PATH = path.resolve(ROOT, argValue('--spec') || 'adpal.openapi.json');
const COLLECTION_PATH = path.resolve(ROOT, argValue('--collection') || 'adpal.postman_collection.json');
const ENVIRONMENT_PATH = path.join(ROOT, 'adpal.postman_environment.json');
const SERVER_PATH = path.join(ROOT, 'server', 'server.js');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);

const VERBOSE = hasFlag('--verbose');
const LINT_ONLY = hasFlag('--lint-only');
const NO_LIVE = hasFlag('--no-live') || LINT_ONLY;

/* ------------------------------------------------------------------ */
/* Findings                                                           */
/* ------------------------------------------------------------------ */

const findings = [];

function record(severity, area, message, hint) {
  findings.push({ severity, area, message, hint });
}

const error = (area, message, hint) => record('error', area, message, hint);
const warn = (area, message, hint) => record('warn', area, message, hint);
const note = (area, message, hint) => record('info', area, message, hint);

function readJson(file, label) {
  if (!fs.existsSync(file)) {
    console.error(`\n  ${label} not found: ${path.relative(ROOT, file)}`);
    process.exit(1);
  }
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch (failure) {
    console.error(`\n  ${label} is not valid JSON: ${failure.message}`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* JSON Pointer / $ref resolution                                     */
/* ------------------------------------------------------------------ */

function resolvePointer(spec, pointer) {
  if (!pointer.startsWith('#/')) return null;
  return pointer
    .slice(2)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, token) => (node === undefined || node === null ? undefined : node[token]), spec);
}

function resolveRef(spec, schema, depth = 0) {
  if (!schema || typeof schema !== 'object') return schema;
  if (!schema.$ref) return schema;
  if (depth > 24) return schema;
  const target = resolvePointer(spec, schema.$ref);
  if (!target) return schema;
  return resolveRef(spec, target, depth + 1);
}

/* ------------------------------------------------------------------ */
/* A small OpenAPI 3.0 JSON Schema validator                          */
/* ------------------------------------------------------------------ */

const UTF8 = (value) => Buffer.byteLength(value, 'utf8');

function typeOfValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => deepEqual(a[key], b[key]));
}

/**
 * Validates `value` against an OpenAPI 3.0 schema, collecting every mismatch
 * rather than stopping at the first one. Reporting all mismatches at once is
 * what makes a drift report actionable.
 */
function validate(value, schema, at, spec, errors) {
  if (schema === undefined || schema === null) return;
  if (typeof schema !== 'object') return;

  const isNullable = schema.nullable === true;
  if (value === null) {
    if (!isNullable) errors.push(`${at}: null is not allowed`);
    return;
  }

  if (schema.$ref) {
    const target = resolvePointer(spec, schema.$ref);
    if (!target) {
      errors.push(`${at}: unresolved $ref ${schema.$ref}`);
      return;
    }
    validate(value, target, at, spec, errors);
    // In 3.0, siblings of $ref are ignored. Do not validate them here; the
    // linter already reports them as a spec smell.
    return;
  }

  if (Array.isArray(schema.allOf)) {
    for (const [index, sub] of schema.allOf.entries()) {
      validate(value, sub, at, spec, errors);
      if (errors.length > 400) return;
      if (index > 8) break;
    }
  }

  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOfValue(value);
    const matches = allowed.some((type) => {
      if (type === actual) return true;
      // `integer` satisfies `number`, and an integer value satisfies either.
      if (type === 'number' && actual === 'integer') return true;
      return false;
    });
    if (!matches) {
      errors.push(`${at}: expected ${allowed.join('|')}, got ${actual}`);
      return;
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((candidate) => deepEqual(candidate, value))) {
      errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${at}: longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern) {
      let regex = null;
      try {
        regex = new RegExp(schema.pattern);
      } catch {
        errors.push(`${at}: schema pattern is not a valid regex: ${schema.pattern}`);
      }
      if (regex && !regex.test(value)) {
        errors.push(`${at}: does not match /${schema.pattern}/`);
      }
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push(`${at}: not a valid date-time`);
    }
    if (schema.format === 'uri' && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      errors.push(`${at}: not a URI`);
    }
    if (schema.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      errors.push(`${at}: not an email address`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${at}: ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${at}: ${value} is above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${at}: has ${value.length} items, minimum is ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${at}: has ${value.length} items, maximum is ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((entry, index) => validate(entry, schema.items, `${at}[${index}]`, spec, errors));
    }
    return;
  }

  if (value && typeof value === 'object') {
    const properties = schema.properties || {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(`${at}.${key}: required but missing`);
        }
      }
    }

    for (const [key, entry] of Object.entries(value)) {
      const known = Object.prototype.hasOwnProperty.call(properties, key);
      if (known) {
        validate(entry, properties[key], `${at}.${key}`, spec, errors);
        continue;
      }

      if (schema.additionalProperties === false) {
        errors.push(`${at}.${key}: returned by the server but not declared in the schema`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validate(entry, schema.additionalProperties, `${at}.${key}`, spec, errors);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Collection paging helpers                                          */
/* ------------------------------------------------------------------ */

const VARIABLE_RE = /\{\{\s*([^}\s]+)\s*\}\}/g;

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

function requestPath(request) {
  const raw = String(request.url?.raw || '');
  const withoutBase = raw.replace(/^\{\{\s*baseUrl\s*\}\}/i, '').replace(/^https?:\/\/[^/]+/i, '');
  const pathOnly = withoutBase.split('?')[0].replace(/\/$/, '');
  // Normalise both `:id` and `{id}` so three sources can be compared.
  return pathOnly.replace(/:([A-Za-z0-9_]+)/g, '{$1}') || '/';
}

function testScriptText(item) {
  const event = (item.event || []).find((entry) => entry.listen === 'test');
  if (!event || !event.script) return '';
  const exec = event.script.exec;
  if (Array.isArray(exec)) return exec.join('\n');
  return typeof exec === 'string' ? exec : '';
}

/**
 * Extracts the status codes a request's tests accept.
 *
 * The suite frequently asserts a *set*, e.g. `[200, 409].to.include(code)`, or
 * swaps on `pm.response.code`. Both forms are reduced to the set of codes the
 * test is willing to pass, which is exactly what must be documented.
 */
function assertedCodes(item) {
  const text = testScriptText(item);
  const codes = new Set();

  for (const match of text.matchAll(/to\.have\.status\((\d{3})\)/g)) codes.add(Number(match[1]));

  for (const match of text.matchAll(/expect\(\[([0-9,\s]+)\]\)\.to\.include\(pm\.response\.code\)/g)) {
    for (const code of match[1].split(',')) {
      if (code.trim()) codes.add(Number(code.trim()));
    }
  }

  for (const match of text.matchAll(/\[([0-9,\s]+)\]\.to\.include\(pm\.response\.code\)/g)) {
    for (const code of match[1].split(',')) {
      if (code.trim()) codes.add(Number(code.trim()));
    }
  }

  // `if (pm.response.code === 200)` reads as an accepted branch too.
  for (const match of text.matchAll(/pm\.response\.code === (\d{3})/g)) codes.add(Number(match[1]));

  return [...codes].sort();
}

function usesBearer(item) {
  const headers = item.request?.header || [];
  return headers.some(
    (header) => String(header.key).toLowerCase() === 'authorization' && /\{\{\s*bearer_token\s*\}\}|\bBearer\b/i.test(String(header.value))
  );
}

/* ------------------------------------------------------------------ */
/* Server route extraction                                            */
/* ------------------------------------------------------------------ */

function normaliseRoute(route) {
  return route.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/$/, '');
}

/**
 * Reads the route table straight out of `server.js`.
 *
 * Literal routes are obvious; the L402 router is mounted via a template
 * (`app.get(\`${base}/offer\`, ...)` inside `mountL402`), so the templates and
 * the mount points are extracted separately and expanded here. That is more
 * faithful than probing, because it sees routes regardless of whether a
 * request would reach them with valid state.
 */
function readServerRoutes() {
  if (!fs.existsSync(SERVER_PATH)) {
    error('server', `server.js not found at ${path.relative(ROOT, SERVER_PATH)}`);
    return [];
  }

  const source = fs.readFileSync(SERVER_PATH, 'utf8');
  const routes = new Map();

  const add = (method, route) => {
    const key = `${method.toLowerCase()} ${normaliseRoute(route)}`;
    routes.set(key, { method: method.toLowerCase(), path: normaliseRoute(route) });
  };

  for (const match of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) {
    add(match[1], match[2]);
  }

  const templates = [...source.matchAll(/app\.(get|post)\(`\$\{base\}([^`]+)`/g)].map((match) => ({
    method: match[1],
    suffix: match[2]
  }));
  const mounts = [...source.matchAll(/mountL402\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);

  for (const mount of mounts) {
    for (const template of templates) add(template.method, `${mount}${template.suffix}`);
  }

  return [...routes.values()];
}

/**
 * Endpoints deliberately outside the generated SDK surface.
 *
 * Every entry needs a reason: an exclusion without one is indistinguishable
 * from an oversight, which is what this script exists to prevent.
 */
const EXCLUSIONS = {
  'GET /api/logs': 'Server-sent event stream; not expressible as a generated SDK method.',
  'POST /api/client-event': 'Browser telemetry ingest, called by the demo page rather than by an API client.',
  'POST /api/offer': 'Legacy aggregate endpoint, superseded by the L402 settle flow.',
  'POST /api/flush-payout': 'Backwards-compatible alias of POST /api/payout.',
  'GET /l402/offer': 'Protocol-native alias of GET /api/l402/offer.',
  'POST /l402/challenge': 'Protocol-native alias of POST /api/l402/challenge.',
  'POST /l402/settle': 'Protocol-native alias of POST /api/l402/settle.',
  'POST /l402/solana/confirm': 'Protocol-native alias of POST /api/l402/solana/confirm.',
  'GET /l402/receipt/{token}': 'Protocol-native alias of GET /api/l402/receipt/{token}.',
  'GET /l402/sessions': 'Protocol-native alias of GET /api/l402/sessions.'
};

/* ------------------------------------------------------------------ */
/* Duplicate-key detection                                            */
/* ------------------------------------------------------------------ */

/**
 * Finds duplicate keys in raw JSON text.
 *
 * `JSON.parse` keeps the last occurrence and says nothing, so a spec with a
 * duplicated `description` or `required` silently loses half of it. Hand-edited
 * specs hit this constantly, and the result looks valid. Tokenising by hand is
 * the only way to see it.
 */
function findDuplicateKeys(text) {
  const duplicates = [];
  const stack = [];
  const keyPath = [];
  let i = 0;

  const skipWhitespace = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };

  const readString = () => {
    i += 1; // opening quote
    let out = '';
    while (i < text.length) {
      const char = text[i];
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (char === '"') {
        i += 1;
        break;
      }
      out += char;
      i += 1;
    }
    return out;
  };

  const walk = () => {
    skipWhitespace();
    const char = text[i];

    if (char === '{') {
      i += 1;
      const frame = new Set();
      stack.push(frame);
      while (i < text.length) {
        skipWhitespace();
        if (text[i] === '}') {
          i += 1;
          stack.pop();
          return;
        }
        if (text[i] !== '"') {
          i += 1;
          continue;
        }
        const key = readString();
        if (frame.has(key)) duplicates.push([...keyPath, key].join('.'));
        frame.add(key);
        skipWhitespace();
        if (text[i] === ':') i += 1;
        keyPath.push(key);
        walk();
        keyPath.pop();
        skipWhitespace();
        if (text[i] === ',') i += 1;
      }
      stack.pop();
      return;
    }

    if (char === '[') {
      i += 1;
      let index = 0;
      while (i < text.length) {
        skipWhitespace();
        if (text[i] === ']') {
          i += 1;
          return;
        }
        keyPath.push(String(index));
        walk();
        keyPath.pop();
        index += 1;
        skipWhitespace();
        if (text[i] === ',') i += 1;
      }
      return;
    }

    if (char === '"') {
      readString();
      return;
    }

    // Literal: read until a structural character.
    while (i < text.length && !/[,\]}\s]/.test(text[i])) i += 1;
  };

  try {
    walk();
  } catch {
    // Best effort: a malformed document is reported elsewhere.
  }
  return duplicates;
}

/* ------------------------------------------------------------------ */
/* Section 1: structure and APIMatic import constraints               */
/* ------------------------------------------------------------------ */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

/** Codes an operation treats as success, honouring an explicit declaration. */
function successCodes(operation) {
  const declared = Array.isArray(operation['x-adpal-success-codes'])
    ? operation['x-adpal-success-codes'].map(Number)
    : [];
  const documented = Object.keys(operation.responses || {})
    .filter((code) => /^2\d\d$/.test(code))
    .map(Number);
  return [...new Set([...documented, ...declared])];
}

function lintStructure(spec) {
  if (!/^3\.0\.\d+$/.test(String(spec.openapi || ''))) {
    error(
      'structure',
      `openapi must be a 3.0.x version string (found "${spec.openapi}")`,
      'APIMatic imports 3.1 only partially; keep the spec on 3.0.x.'
    );
  }

  for (const field of ['title', 'version', 'description']) {
    if (!spec.info || !spec.info[field]) error('structure', `info.${field} is required`);
  }

  if (!Array.isArray(spec.servers) || spec.servers.length === 0) {
    error('structure', 'servers must declare at least one server');
  }
  for (const server of spec.servers || []) {
    if (!/^https?:\/\//.test(String(server.url || ''))) error('structure', `server url is not absolute: ${server.url}`);
    if (String(server.url || '').endsWith('/')) {
      error('structure', `server url must not end with "/": ${server.url}`, 'APIMatic concatenates paths directly.');
    }
  }

  const declaredTags = new Set((spec.tags || []).map((tag) => tag.name));
  const usedTags = new Set();
  const operationIds = new Map();
  let operationCount = 0;

  for (const [route, pathItem] of Object.entries(spec.paths || {})) {
    if (!route.startsWith('/')) error('structure', `path must start with "/": ${route}`);

    const templateParams = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const pathLevelParams = (pathItem.parameters || []).filter((param) => param.in === 'path');

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.includes(method)) continue;
      operationCount += 1;
      const label = `${method.toUpperCase()} ${route}`;

      if (!operation.operationId) {
        error('structure', `${label} has no operationId`, 'APIMatic derives SDK method names from it.');
      } else {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(operation.operationId)) {
          error('structure', `${label} operationId "${operation.operationId}" is not a valid identifier`);
        }
        if (operationIds.has(operation.operationId)) {
          error('structure', `duplicate operationId "${operation.operationId}" (${operationIds.get(operation.operationId)} and ${label})`);
        }
        operationIds.set(operation.operationId, label);
      }

      if (!Array.isArray(operation.tags) || operation.tags.length === 0) {
        error('structure', `${label} has no tags`, 'Tags drive SDK grouping.');
      } else {
        for (const tag of operation.tags) {
          usedTags.add(tag);
          if (!declaredTags.has(tag)) error('structure', `${label} uses undeclared tag "${tag}"`);
        }
      }

      if (!operation.summary) warn('structure', `${label} has no summary`);
      if (!operation.description) warn('structure', `${label} has no description`);

      const responses = operation.responses || {};
      const codes = Object.keys(responses);
      if (codes.length === 0) {
        error('structure', `${label} documents no responses`);
      } else {
        if (successCodes(operation).length === 0) {
          error(
            'structure',
            `${label} documents no success response`,
            'APIMatic requires one. If the success case is genuinely a non-2xx code (as with an L402 challenge), declare it in `x-adpal-success-codes`.'
          );
        }
        for (const code of codes) {
          const response = responses[code];
          if (!response.description) error('structure', `${label} ${code} has no description`);
          if (!/^\d{3}$/.test(code) && code !== 'default') {
            error('structure', `${label} has a non-numeric response key "${code}"`);
          }
          if (code !== 'default' && !/^2\d\d$/.test(code) && !response.content) {
            warn('structure', `${label} ${code} documents no body`, 'APIMatic generates weaker error models without a schema.');
          }
        }
        for (const declared of operation['x-adpal-success-codes'] || []) {
          if (!codes.includes(String(declared))) {
            error('structure', `${label} declares x-adpal-success-codes ${declared} but documents no ${declared} response`);
          }
        }
      }

      // Path parameters must be declared exactly once, on the operation or the path.
      const opParams = operation.parameters || [];
      const allParams = [...pathLevelParams, ...opParams];
      const declaredPathParams = allParams.filter((param) => param.in === 'path').map((param) => param.name);
      for (const templateParam of templateParams) {
        if (!declaredPathParams.includes(templateParam)) {
          error('structure', `${label} does not declare path parameter "{${templateParam}}"`);
        }
      }
      for (const declared of declaredPathParams) {
        if (!templateParams.includes(declared)) {
          error('structure', `${label} declares path parameter "${declared}" that is not in the route`);
        }
      }
      for (const param of allParams) {
        if (param.in === 'path' && param.required !== true) {
          error('structure', `${label} path parameter "${param.name}" must set required: true`);
        }
        if (!param.in) error('structure', `${label} has a parameter without "in"`);
        if (!param.schema && !param.content) {
          error('structure', `${label} parameter "${param.name || '(unnamed)'}" has no schema`);
        }
        if (param.required === true && param.schema && param.schema.nullable === true) {
          warn('structure', `${label} required parameter "${param.name}" is nullable`);
        }
      }

      if (operation.requestBody) {
        if (!operation.requestBody.content) {
          error('structure', `${label} requestBody has no content`);
        } else if (method === 'get' || method === 'head') {
          warn('structure', `${label} declares a requestBody on a ${method.toUpperCase()}`);
        }
      }
    }
  }

  for (const tag of declaredTags) {
    if (!usedTags.has(tag)) warn('structure', `tag "${tag}" is declared but never used`);
  }

  if (operationCount === 0) error('structure', 'spec defines no operations');

  return operationCount;
}

/* ------------------------------------------------------------------ */
/* Section 2: $ref hygiene and APIMatic schema constraints            */
/* ------------------------------------------------------------------ */

function walkSchemas(node, at, spec, visit, seen = new Set()) {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (node.$ref) visit(node, at);

  if (node.properties) {
    for (const [key, sub] of Object.entries(node.properties)) walkSchemas(sub, `${at}.${key}`, spec, visit, seen);
  }
  if (node.items) walkSchemas(node.items, `${at}[]`, spec, visit, seen);
  if (Array.isArray(node.allOf)) node.allOf.forEach((sub, index) => walkSchemas(sub, `${at}<allOf:${index}>`, spec, visit, seen));
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((sub, index) => walkSchemas(sub, `${at}<oneOf:${index}>`, spec, visit, seen));
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((sub, index) => walkSchemas(sub, `${at}<anyOf:${index}>`, spec, visit, seen));
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    walkSchemas(node.additionalProperties, `${at}.*`, spec, visit, seen);
  }
}

function lintSchemas(spec) {
  const schemas = spec.components?.schemas || {};

  for (const name of Object.keys(schemas)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      error('schemas', `schema name "${name}" is not a valid identifier`, 'APIMatic turns it into a class name.');
    }
    if (/\s/.test(name)) error('schemas', `schema name "${name}" contains whitespace`);
  }

  const visit = (node, at) => {
    if (typeof node.$ref !== 'string') {
      warn('schemas', `${at}: $ref is not a string`);
      return;
    }
    if (!resolvePointer(spec, node.$ref)) {
      error('schemas', `${at}: unresolved $ref "${node.$ref}"`);
    }
    const siblings = Object.keys(node).filter((key) => key !== '$ref' && key !== 'description' && key !== 'title');
    if (siblings.length) {
      warn(
        'schemas',
        `${at}: $ref has siblings (${siblings.join(', ')}) that OpenAPI 3.0 ignores`,
        'Wrap in allOf if the sibling constraints must apply.'
      );
    }
  };

  for (const [name, schema] of Object.entries(schemas)) {
    if (schema === null || typeof schema !== 'object') {
      error('schemas', `schema "${name}" is not an object`);
      continue;
    }
    walkSchemas(schema, name, spec, visit);

    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && typeof schema.additionalProperties !== 'object') {
      error('schemas', `${name}.additionalProperties must be a boolean or a schema`);
    }
    if (schema.not) error('schemas', `${name} uses "not", which APIMatic does not support`);
    if (schema.oneOf) warn('schemas', `${name} uses oneOf; APIMatic flattens these and may lose the distinction`);
    if (schema.anyOf) warn('schemas', `${name} uses anyOf; APIMatic flattens these and may lose the distinction`);
    if (schema.nullable === true && !schema.type && !schema.$ref && !schema.allOf) {
      warn('schemas', `${name} is nullable but declares no type`);
    }
    if (schema.type === 'object' && !schema.properties && schema.additionalProperties === undefined) {
      note('schemas', `${name} is a free-form object with no declared properties`);
    }
  }

  // Security schemes.
  const schemes = spec.components?.securitySchemes || {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!['http', 'apiKey', 'oauth2', 'openIdConnect'].includes(scheme.type)) {
      error('security', `securityScheme "${name}" has unsupported type "${scheme.type}"`);
    }
    if (scheme.type === 'http' && !['bearer', 'basic'].includes(String(scheme.scheme))) {
      error('security', `securityScheme "${name}" has unsupported http scheme "${scheme.scheme}"`);
    }
    if (scheme.type === 'http' && scheme.scheme === 'bearer' && !scheme.bearerFormat) {
      warn('security', `securityScheme "${name}" has no bearerFormat`);
    }
  }

  // Every security requirement must name a declared scheme.
  const checkRequirements = (requirements, at) => {
    if (!Array.isArray(requirements)) return;
    for (const requirement of requirements) {
      for (const name of Object.keys(requirement)) {
        if (!schemes[name]) error('security', `${at} requires undeclared securityScheme "${name}"`);
      }
    }
  };
  checkRequirements(spec.security, 'root security');
  for (const [route, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.includes(method)) continue;
      checkRequirements(operation.security, `${method.toUpperCase()} ${route}`);
    }
  }

  return Object.keys(schemas).length;
}

/* ------------------------------------------------------------------ */
/* Section 3: three-way coverage                                      */
/* ------------------------------------------------------------------ */

function indexSpecOperations(spec) {
  const operations = new Map();
  for (const [route, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.includes(method)) continue;
      operations.set(`${method.toUpperCase()} ${normaliseRoute(route)}`, { route, method, operation });
    }
  }
  return operations;
}

function checkCoverage(spec, requests) {
  const operations = indexSpecOperations(spec);

  // --- Postman -> spec -------------------------------------------------
  const suiteOperations = new Map();
  for (const { item } of requests) {
    const method = String(item.request.method || 'GET').toUpperCase();
    const route = requestPath(item.request);
    const key = `${method} ${normaliseRoute(route)}`;
    if (!suiteOperations.has(key)) suiteOperations.set(key, []);
    suiteOperations.get(key).push(item.name);
  }

  for (const [key, names] of suiteOperations) {
    if (!operations.has(key)) {
      error(
        'coverage',
        `the suite calls ${key} but the spec has no such operation`,
        `Called by: ${names.join(', ')}`
      );
    }
  }

  // --- spec -> server --------------------------------------------------
  const serverRoutes = readServerRoutes();
  const serverIndex = new Map(serverRoutes.map((route) => [`${route.method.toUpperCase()} ${route.path}`, route]));
  const documented = new Set();

  for (const [key, entry] of operations) {
    if (serverIndex.has(key)) {
      documented.add(key);
      continue;
    }
    if (EXCLUSIONS[key]) {
      note('coverage', `${key} is documented in the spec but deliberately excluded from the server check`, EXCLUSIONS[key]);
      continue;
    }
    error('coverage', `the spec documents ${key} but the server does not register that route`);
  }

  // --- server -> spec --------------------------------------------------
  for (const route of serverRoutes) {
    const key = `${route.method.toUpperCase()} ${route.path}`;
    if (!route.path.startsWith('/api') && !route.path.startsWith('/l402')) continue;
    if (operations.has(key)) continue;
    if (EXCLUSIONS[key]) {
      note('coverage', `${key} is served but excluded from the spec`, EXCLUSIONS[key]);
      continue;
    }
    error(
      'coverage',
      `the server registers ${key} but the spec does not document it`,
      'Either document it or add it to EXCLUSIONS in this script with a reason.'
    );
  }

  // --- spec ops the suite never exercises -----------------------------
  for (const key of operations.keys()) {
    if (suiteOperations.has(key)) continue;
    note('coverage', `${key} is documented but not exercised by the Postman suite`);
  }

  return operations;
}

/* ------------------------------------------------------------------ */
/* Section 4: status codes and security agreement                     */
/* ------------------------------------------------------------------ */

function documentedCodes(operation, spec) {
  const codes = new Set();
  for (const key of Object.keys(operation.responses || {})) {
    if (/^\d{3}$/.test(key)) codes.add(Number(key));
  }
  return codes;
}

function checkStatusCodes(operations, requests) {
  for (const { item } of requests) {
    const method = String(item.request.method || 'GET').toUpperCase();
    const key = `${method} ${normaliseRoute(requestPath(item.request))}`;
    const entry = operations.get(key);
    if (!entry) continue;

    const asserted = assertedCodes(item);
    if (asserted.length === 0) {
      warn('codes', `${key} (${item.name}) asserts no status code`);
      continue;
    }

    const documented = documentedCodes(entry.operation, null);
    for (const code of asserted) {
      if (!documented.has(code)) {
        error(
          'codes',
          `the suite accepts ${code} for ${key} but the spec does not document it`,
          `Documented: ${[...documented].sort().join(', ')}`
        );
      }
    }
  }

  // The reverse direction: a documented 2xx that the suite never asserts is
  // fine, but a documented code that no handler can emit is a fiction. The
  // live pass is what proves this; here we only flag the obvious.
  for (const [key, entry] of operations) {
    if (successCodes(entry.operation).length === 0) {
      error('codes', `${key} documents no success code`);
    }
  }
}

function checkSecurity(operations, requests) {
  for (const { item } of requests) {
    const method = String(item.request.method || 'GET').toUpperCase();
    const key = `${method} ${normaliseRoute(requestPath(item.request))}`;
    const entry = operations.get(key);
    if (!entry) continue;

    const declaresBearer = (entry.operation.security || []).some(
      (requirement) => requirement && Object.prototype.hasOwnProperty.call(requirement, 'L402Bearer')
    );
    const sendsBearer = usesBearer(item);

    if (sendsBearer && !declaresBearer) {
      error(
        'security',
        `${key} sends a Bearer token in the suite but the spec declares no L402Bearer security`,
        `Request: ${item.name}`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Section 5: live conformance                                        */
/* ------------------------------------------------------------------ */

const SIGNALS = {
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

function buildScenarios() {
  return [
    { key: 'GET /api/health', label: 'health' },
    { key: 'GET /api/toolkit', label: 'toolkit' },
    { key: 'GET /api/agents', label: 'agents' },
    { key: 'GET /api/balance', label: 'balance' },
    { key: 'GET /api/telemetry', label: 'telemetry' },
    { key: 'GET /api/solana', label: 'solana profile' },
    { key: 'POST /api/solana/fund', label: 'solana fund', body: { sol: 1 } },
    { key: 'GET /api/l402/offer', label: 'gated resource (402)' },
    { key: 'POST /api/l402/challenge', label: 'challenge', body: { offer_id: 'attention_session_v1' }, capture: 'contract' },
    {
      key: 'POST /api/l402/settle',
      label: 'settle',
      body: (state) => ({
        payment_context_token: state.contract.payment_context_token,
        offer_id: state.contract.selected_offer_id,
        attention: { signals: SIGNALS }
      }),
      capture: 'settlement'
    },
    { key: 'GET /api/l402/sessions', label: 'sessions' },
    {
      key: 'GET /api/l402/offer',
      label: 'gated resource (200)',
      bearer: (state) => state.settlement?.bearer_token,
      expectStatus: [200]
    },
    {
      key: 'GET /api/l402/receipt/{token}',
      label: 'receipt',
      path: (state) => `/api/l402/receipt/${state.contract.payment_context_token}`,
      expectStatus: [200]
    },
    {
      key: 'POST /api/l402/solana/confirm',
      label: 'confirm malformed signature',
      body: (state) => ({
        signature: '5'.repeat(64),
        payment_context_token: state.contract.payment_context_token
      }),
      expectStatus: [402]
    },
    {
      key: 'POST /api/l402/solana/confirm',
      label: 'confirm unknown signature',
      body: (state) => ({
        signature: '1'.repeat(64),
        payment_context_token: state.contract.payment_context_token
      })
    },
    { key: 'POST /api/payout', label: 'payout (paypal)', body: { rail: 'paypal_payouts', reason: 'apimatic-check' }, expectStatus: [200, 409] },
    { key: 'POST /api/payout', label: 'payout (solana)', body: { rail: 'solana-devnet', reason: 'apimatic-check' }, expectStatus: [200, 409, 503] },
    { key: 'GET /api/payout/{id}', label: 'payout status (bad id)', path: () => '/api/payout/not-a-batch-id', expectStatus: [400] },
    {
      key: 'POST /api/webhooks/paypal',
      label: 'webhook unknown event (acknowledged)',
      body: {
        id: `WH-VALIDATOR-${Date.now().toString(36).toUpperCase()}`,
        event_type: 'ADPAL.VALIDATOR.PROBE',
        resource: { payout_batch_id: 'NOT-A-BATCH' }
      },
      expectStatus: [200]
    },
    {
      key: 'POST /api/webhooks/paypal',
      label: 'webhook non-object body',
      body: 'not-an-event',
      expectStatus: [400]
    },
    { key: 'POST /api/dev/reset', label: 'reset', body: {}, expectStatus: [200] }
  ];
}

async function send(baseUrl, method, pathname, body, token) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) headers.authorization = `Bearer ${token}`;

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : payload,
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json, ms: Date.now() - startedAt };
}

async function runLive(spec, operations, baseUrl) {
  const scenarios = buildScenarios();
  const state = {};
  let checked = 0;

  for (const scenario of scenarios) {
    const entry = operations.get(scenario.key);
    if (!entry) continue;

    const method = entry.method.toUpperCase();
    const pathname = scenario.path ? scenario.path(state) : entry.route;
    const body = typeof scenario.body === 'function' ? scenario.body(state) : scenario.body;
    const token = scenario.bearer ? scenario.bearer(state) : undefined;

    let response;
    try {
      response = await send(baseUrl, method, pathname, method === 'GET' ? undefined : body, token);
    } catch (failure) {
      error('live', `${scenario.label}: request failed · ${failure?.message || failure}`);
      continue;
    }

    // 1. Is this status documented for the operation?
    const documented = documentedCodes(entry.operation, spec);
    const success = documented.has(response.status);

    if (!success) {
      error(
        'live',
        `${method} ${pathname} returned ${response.status}, which the spec does not document`,
        `${scenario.label} · documented: ${[...documented].sort().join(', ')}`
      );
      continue;
    }

    if (scenario.expectStatus && !scenario.expectStatus.includes(response.status)) {
      warn(
        'live',
        `${scenario.label}: got ${response.status}, expected one of ${scenario.expectStatus.join(', ')}`,
        'The state on the server may differ from a fresh run (threshold, faucet, replay guard).'
      );
    }

    // 2. Does the body match the schema for that status?
    const responseSpec = entry.operation.responses?.[String(response.status)];
    const schema = responseSpec?.content?.['application/json']?.schema;
    if (!schema) {
      if (response.text) warn('live', `${scenario.label}: ${response.status} has a body but no declared schema`);
      continue;
    }
    if (response.json === null) {
      error('live', `${scenario.label}: expected JSON, got ${response.text.slice(0, 80)}`);
      continue;
    }

    const errors = [];
    validate(response.json, schema, 'body', spec, errors);
    checked += 1;

    for (const problem of errors.slice(0, 12)) {
      error('live', `${method} ${pathname} ${response.status} · ${problem}`, scenario.label);
    }
    if (errors.length > 12) {
      error('live', `${method} ${pathname} ${response.status} · ${errors.length - 12} more schema mismatch(es)`);
    }

    if (errors.length === 0 && VERBOSE) {
      note('live', `${method} ${pathname} ${response.status} conforms (${response.ms}ms)`);
    }

    if (scenario.capture) state[scenario.capture] = response.json;
  }

  return checked;
}

/* ------------------------------------------------------------------ */
/* Report                                                             */
/* ------------------------------------------------------------------ */

function report(meta) {
  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warn');
  const notes = findings.filter((finding) => finding.severity === 'info');

  console.log('');
  console.log(`AdPal APIMatic validation · ${meta.title} ${meta.version}`);
  console.log(`spec        ${path.relative(ROOT, SPEC_PATH)}`);
  console.log(`collection  ${path.relative(ROOT, COLLECTION_PATH)}`);
  console.log(`server      ${path.relative(ROOT, SERVER_PATH)}`);
  console.log(
    `surface     ${meta.operations} operations · ${meta.schemas} schemas · ` +
      `${meta.suiteOperations} exercised by the suite · ${meta.serverRoutes} routes served`
  );
  if (meta.target) console.log(`target      ${meta.target}`);
  if (meta.liveChecked !== undefined) console.log(`live        ${meta.liveChecked} response bodies validated`);
  console.log('');

  const group = (list, heading) => {
    if (list.length === 0) return;
    console.log(`${heading}`);
    const byArea = new Map();
    for (const finding of list) {
      if (!byArea.has(finding.area)) byArea.set(finding.area, []);
      byArea.get(finding.area).push(finding);
    }
    for (const [area, entries] of byArea) {
      console.log(`  ${area}`);
      for (const entry of entries) {
        console.log(`    - ${entry.message}`);
        if (entry.hint) console.log(`      ${entry.hint}`);
      }
    }
    console.log('');
  };

  if (VERBOSE) group(notes, 'notes');
  group(warnings, 'warnings');
  group(errors, 'errors');

  const driftFree = errors.length === 0;

  if (driftFree) {
    console.log(
      `PASS · no drift · 0 errors, ${warnings.length} warning(s), ${notes.length} note(s)`
    );
    console.log('The Postman suite, the OpenAPI spec and the live server agree.');
  } else {
    console.log(`FAIL · ${errors.length} error(s), ${warnings.length} warning(s)`);
    console.log('Fix the errors above; each one is a place where two of the three sources disagree.');
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

(async () => {
  const spec = readJson(SPEC_PATH, 'OpenAPI spec');
  const collection = readJson(COLLECTION_PATH, 'Postman collection');
  const environment = existsOrNull(ENVIRONMENT_PATH);

  for (const duplicate of findDuplicateKeys(fs.readFileSync(SPEC_PATH, 'utf8').replace(/^\uFEFF/, ''))) {
    error(
      'structure',
      `duplicate JSON key "${duplicate}" in the spec`,
      'JSON.parse keeps only the last value, so the earlier one is silently discarded.'
    );
  }
  for (const duplicate of findDuplicateKeys(fs.readFileSync(COLLECTION_PATH, 'utf8').replace(/^\uFEFF/, ''))) {
    error('structure', `duplicate JSON key "${duplicate}" in the Postman collection`);
  }

  const requests = collectRequests(collection.item);

  const operations = indexSpecOperations(spec);
  const operationCount = lintStructure(spec);
  const schemaCount = lintSchemas(spec);

  const specOperations = checkCoverage(spec, requests);
  checkStatusCodes(specOperations, requests);
  checkSecurity(specOperations, requests);

  let liveChecked;
  let target;

  if (!NO_LIVE) {
    const enabled = (environment?.values || []).filter((value) => value.enabled !== false);
    target = argValue('--base-url') || enabled.find((value) => value.key === 'baseUrl')?.value || 'http://localhost:3000';

    try {
      await fetch(`${target}/api/health`, { signal: AbortSignal.timeout(5000) });
    } catch (failure) {
      error('live', `cannot reach ${target} · ${failure?.message || failure}`, 'Start the server, or pass --no-live.');
    }

    if (!findings.some((finding) => finding.area === 'live' && finding.severity === 'error' && finding.message.startsWith('cannot reach'))) {
      liveChecked = await runLive(spec, operations, target);
    }
  }

  const serverRoutes = readServerRoutes();
  const apiRoutes = serverRoutes.filter((route) => route.path.startsWith('/api') || route.path.startsWith('/l402'));

  report({
    title: spec.info?.title || '(untitled)',
    version: spec.info?.version || '(no version)',
    operations: operationCount,
    schemas: schemaCount,
    suiteOperations: new Set(requests.map(({ item }) => `${String(item.request.method).toUpperCase()} ${normaliseRoute(requestPath(item.request))}`)).size,
    serverRoutes: apiRoutes.length,
    target,
    liveChecked
  });
})().catch((failure) => {
  console.error('\nvalidator crashed ·', failure?.stack || failure);
  process.exitCode = 1;
});

function existsOrNull(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
